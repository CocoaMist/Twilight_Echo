import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable, Transform } from 'node:stream'
import { buildSoapEnvelope } from '../../remote/soap.ts'
import { buildNetworkEntryId } from '../networkPath.ts'
import { NetworkResumeUnsupported, NetworkSourceFailure } from '../errors.ts'
import { entryKind } from '../entryKinds.ts'
import type { NetworkAuth, NetworkSourceAdapter, NetworkSourceSession } from './types.ts'
import type { NetworkEntry, NetworkSourceProfile } from '../../../shared/networkSources.ts'

export interface DlnaHttpResponse {
  status: number
  body: Buffer
}

export interface DlnaTransport {
  get(url: string, options?: DlnaRequestOptions): Promise<DlnaHttpResponse>
  post(
    url: string,
    soapAction: string,
    body: string,
    options?: DlnaRequestOptions
  ): Promise<DlnaHttpResponse>
  getStream?(
    url: string,
    options: DlnaRequestOptions
  ): Promise<{ status: number; stream: Readable }>
}

export interface DlnaRequestOptions {
  signal?: AbortSignal
  connectTimeoutMs: number
  transferTimeoutMs: number
  maxBytes: number
  start?: number
}

const MAX_XML_BYTES = 4 * 1024 * 1024
const MAX_MEDIA_BYTES = 4 * 1024 * 1024 * 1024
const BROWSE_PAGE_SIZE = 250
const MAX_BROWSE_ENTRIES = 10_000

const CD_SERVICE = 'urn:schemas-upnp-org:service:ContentDirectory:1'
const DEFAULT_DESC_PATHS = ['/rootDesc.xml', '/description.xml', '/', '/upnp/description.xml']

interface DidlEntry {
  id: string
  title: string
  container: boolean
  audioItem: boolean
  res: string | null
}

function extractControlUrl(xml: string): string | null {
  const serviceBlocks = xml.match(/<service\b[\s\S]*?<\/service>/gi) ?? []
  for (const block of serviceBlocks) {
    const type = /<serviceType[^>]*>([\s\S]*?)<\/serviceType>/i.exec(block)?.[1] ?? ''
    const control = /<controlURL[^>]*>([\s\S]*?)<\/controlURL>/i.exec(block)?.[1] ?? ''
    if (type.toLowerCase().includes('contentdirectory') && control.trim()) {
      return control.trim()
    }
  }
  return null
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function parseDidl(result: string): DidlEntry[] {
  const xml = unescapeXml(result)
  const entries: DidlEntry[] = []
  const pattern = /<(container|item)\b([^>]*)>([\s\S]*?)<\/\1>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) {
    const tag = match[1]
    const attributes = match[2]
    const body = match[3]
    const id = /id="([^"]*)"/.exec(attributes)?.[1] ?? ''
    if (!id) continue
    const title =
      /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(body)?.[1] ??
      /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ??
      id
    const upnpClass = /<upnp:class[^>]*>([\s\S]*?)<\/upnp:class>/i.exec(body)?.[1] ?? ''
    const res = /<res[^>]*>([\s\S]*?)<\/res>/i.exec(body)?.[1] ?? null
    entries.push({
      id,
      title: unescapeXml(title.trim()),
      container: tag === 'container',
      audioItem: upnpClass.toLowerCase().includes('audioitem'),
      res: res?.trim() ?? null
    })
  }
  return entries
}

async function defaultGet(url: string, options: DlnaRequestOptions): Promise<DlnaHttpResponse> {
  return requestText('GET', url, options)
}

async function defaultPost(
  url: string,
  soapAction: string,
  body: string,
  options: DlnaRequestOptions
): Promise<DlnaHttpResponse> {
  return requestText(
    'POST',
    url,
    options,
    {
      SOAPACTION: `"${soapAction}"`,
      'Content-Type': 'text/xml; charset="utf-8"',
      'Content-Length': Buffer.byteLength(body)
    },
    body
  )
}

async function requestText(
  method: string,
  url: string,
  options: DlnaRequestOptions,
  headers: Record<string, string | number> = {},
  body?: string
): Promise<DlnaHttpResponse> {
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(options.transferTimeoutMs)
  ])
  const { status, stream } = await requestStream(method, url, { ...options, signal }, headers, body)
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    chunks.push(buffer)
  }
  return { status, body: Buffer.concat(chunks, bytes) }
}

async function requestStream(
  method: string,
  url: string,
  options: DlnaRequestOptions,
  headers: Record<string, string | number> = {},
  body?: string
): Promise<{ status: number; stream: Readable }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new NetworkSourceFailure('denied', 'DLNA 媒体地址必须使用 HTTP'))
      return
    }
    const requestFn = parsed.protocol === 'https:' ? httpsRequest : httpRequest
    let stream: Transform | undefined
    const req = requestFn(
      parsed,
      {
        method,
        headers: { ...headers, ...(options.start ? { Range: `bytes=${options.start}-` } : {}) },
        signal: options.signal
      },
      (res) => {
        clearTimeout(connectTimer)
        const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(
          String(res.headers['content-range'] ?? '')
        )
        if (
          options.start &&
          (res.statusCode !== 206 ||
            !range ||
            Number(range[1]) !== options.start ||
            Number(range[2]) < options.start ||
            (range[3] !== '*' && Number(range[2]) >= Number(range[3])))
        ) {
          res.destroy()
          reject(new NetworkResumeUnsupported())
          return
        }
        const declaredLength = Number(res.headers['content-length'])
        if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
          res.destroy()
          reject(new NetworkSourceFailure('network', 'DLNA 响应超过大小限制'))
          return
        }
        let bytes = 0
        stream = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length
            if (bytes > options.maxBytes) {
              callback(new NetworkSourceFailure('network', 'DLNA 响应超过大小限制'))
            } else callback(null, chunk)
          }
        })
        const output = stream
        // Protect the interval between response headers and caller subscription.
        output.on('error', () => undefined)
        res.on('error', (error) => output.destroy(error))
        res.once('aborted', () =>
          output.destroy(new NetworkSourceFailure('network', 'DLNA 响应中断'))
        )
        output.once('close', () => {
          res.destroy()
          req.destroy()
        })
        res.pipe(output)
        resolve({ status: res.statusCode ?? 0, stream: output })
      }
    )
    const connectTimer = setTimeout(() => {
      req.destroy(new NetworkSourceFailure('timeout', 'DLNA 连接超时'))
    }, options.connectTimeoutMs)
    req.setTimeout(options.transferTimeoutMs, () => {
      req.destroy(new NetworkSourceFailure('timeout', 'DLNA 传输超时'))
    })
    req.on('error', (error) => {
      clearTimeout(connectTimer)
      stream?.destroy(error)
      reject(error)
    })
    req.once('close', () => clearTimeout(connectTimer))
    if (body) req.write(body)
    req.end()
  })
}

function toEntry(profile: NetworkSourceProfile, item: DidlEntry): NetworkEntry {
  const path = `/${item.id}`
  const kind = item.container
    ? 'directory'
    : entryKind(item.title, { mime: item.audioItem ? 'audio/unknown' : undefined })
  return {
    id: buildNetworkEntryId(profile.protocol, profile.id, path),
    profileId: profile.id,
    name: item.title,
    kind,
    path,
    mimeType: item.res ?? undefined
  }
}

/**
 * DLNA / UPnP 媒体服务器浏览 adapter：SSDP 设备描述 → ContentDirectory Browse。
 * 播放走 item 的 res URL（直连），与现有 DLNA 投送（castBackend）分离。
 */
export function createDlnaAdapter(deps?: {
  transport?: DlnaTransport
  descriptionPaths?: string[]
}): NetworkSourceAdapter {
  const transport = deps?.transport ?? {
    get: defaultGet,
    post: defaultPost,
    getStream: (url: string, options: DlnaRequestOptions) => requestStream('GET', url, options)
  }
  const descriptionPaths = deps?.descriptionPaths ?? DEFAULT_DESC_PATHS

  return {
    protocol: 'dlna',
    async createSession(
      profile: NetworkSourceProfile,
      _auth: NetworkAuth
    ): Promise<NetworkSourceSession> {
      let controlUrl: string | null = null
      const lifetime = new AbortController()
      const baseUrl = `http://${profile.host}${profile.port ? `:${profile.port}` : ''}`

      function requestOptions(signal?: AbortSignal, maxBytes = MAX_XML_BYTES): DlnaRequestOptions {
        return {
          signal: signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal,
          connectTimeoutMs: profile.options.connectTimeoutMs,
          transferTimeoutMs: profile.options.transferTimeoutMs,
          maxBytes
        }
      }

      function checkCancelled(signal?: AbortSignal): void {
        if (signal?.aborted || lifetime.signal.aborted) {
          throw new NetworkSourceFailure('timeout', '网络操作已取消')
        }
      }

      function checkXml(response: DlnaHttpResponse): void {
        if (response.body.length > MAX_XML_BYTES) {
          throw new NetworkSourceFailure('network', 'DLNA 响应超过大小限制')
        }
      }

      async function ensureConnected(signal?: AbortSignal): Promise<void> {
        checkCancelled(signal)
        if (controlUrl) return
        for (const descPath of descriptionPaths) {
          try {
            const response = await transport.get(`${baseUrl}${descPath}`, requestOptions(signal))
            checkCancelled(signal)
            checkXml(response)
            if (response.status !== 200) continue
            const relative = extractControlUrl(response.body.toString('utf8'))
            if (!relative) continue
            controlUrl = new URL(relative, `${baseUrl}${descPath}`).toString()
            return
          } catch {
            checkCancelled(signal)
            // 尝试下一个描述路径
          }
        }
        throw new NetworkSourceFailure('network', '无法获取 DLNA 媒体服务器设备描述')
      }

      function throwForStatus(status: number): void {
        if (status >= 200 && status < 300) return
        if (status === 401 || status === 403) {
          throw new NetworkSourceFailure('auth', 'DLNA 服务器拒绝访问')
        }
        throw new NetworkSourceFailure('network', `DLNA 请求失败：HTTP ${status}`)
      }

      async function browse(
        objectId: string,
        flag: string,
        signal?: AbortSignal,
        startingIndex = 0
      ): Promise<{ items: DidlEntry[]; totalMatches: number | null }> {
        checkCancelled(signal)
        await ensureConnected(signal)
        const response = await transport.post(
          controlUrl as string,
          `${CD_SERVICE}#Browse`,
          buildSoapEnvelope({
            serviceType: CD_SERVICE,
            action: 'Browse',
            arguments: {
              ObjectID: objectId,
              BrowseFlag: flag,
              Filter: '*',
              StartingIndex: startingIndex,
              RequestedCount: flag === 'BrowseMetadata' ? 1 : BROWSE_PAGE_SIZE,
              SortCriteria: ''
            }
          }),
          requestOptions(signal)
        )
        checkCancelled(signal)
        checkXml(response)
        throwForStatus(response.status)
        const body = response.body.toString('utf8')
        const result = /<Result[^>]*>([\s\S]*?)<\/Result>/i.exec(body)?.[1] ?? ''
        const total = /<TotalMatches[^>]*>(\d+)<\/TotalMatches>/i.exec(body)?.[1]
        return { items: parseDidl(result), totalMatches: total == null ? null : Number(total) }
      }

      function objectIdOf(remotePath: string): string {
        const id = remotePath.replace(/^\//, '')
        return id || '0'
      }

      async function resolveUrl(remotePath: string, signal?: AbortSignal): Promise<string | null> {
        const { items } = await browse(objectIdOf(remotePath), 'BrowseMetadata', signal)
        return items[0]?.res ?? null
      }

      return {
        protocol: profile.protocol,
        async list(remotePath: string, signal?: AbortSignal): Promise<NetworkEntry[]> {
          const items: DidlEntry[] = []
          while (items.length < MAX_BROWSE_ENTRIES) {
            const page = await browse(
              objectIdOf(remotePath),
              'BrowseDirectChildren',
              signal,
              items.length
            )
            items.push(...page.items)
            if (
              items.length > MAX_BROWSE_ENTRIES ||
              (page.totalMatches ?? 0) > MAX_BROWSE_ENTRIES
            ) {
              throw new NetworkSourceFailure('network', 'DLNA 目录条目超过限制，请浏览子目录')
            }
            if (
              page.items.length === 0 ||
              (page.totalMatches != null
                ? items.length >= page.totalMatches
                : page.items.length < BROWSE_PAGE_SIZE)
            ) {
              return items.map((item) => toEntry(profile, item))
            }
          }
          throw new NetworkSourceFailure('network', 'DLNA 目录条目超过限制，请浏览子目录')
        },
        async stat(remotePath: string, signal?: AbortSignal): Promise<NetworkEntry | null> {
          const { items } = await browse(objectIdOf(remotePath), 'BrowseMetadata', signal)
          return items[0] ? toEntry(profile, items[0]) : null
        },
        async resolvePlaybackUrl(remotePath: string, signal?: AbortSignal): Promise<string | null> {
          return resolveUrl(remotePath, signal)
        },
        async readStream(
          remotePath: string,
          signal?: AbortSignal,
          options?: { start?: number }
        ): Promise<NodeJS.ReadableStream> {
          const url = await resolveUrl(remotePath, signal)
          if (!url) throw new NetworkSourceFailure('notFound', 'DLNA 条目没有可播放的媒体地址')
          const start = options?.start ?? 0
          if (transport.getStream) {
            const response = await transport.getStream(url, {
              ...requestOptions(signal, MAX_MEDIA_BYTES),
              start
            })
            try {
              checkCancelled(signal)
              throwForStatus(response.status)
              return response.stream
            } catch (error) {
              response.stream.destroy()
              throw error
            }
          }
          // Preserve the buffered transport seam used by existing injected
          // adapters; production HTTP always returns a backpressured stream.
          const response = await transport.get(url, requestOptions(signal, MAX_MEDIA_BYTES))
          checkCancelled(signal)
          throwForStatus(response.status)
          if (response.body.length > MAX_MEDIA_BYTES)
            throw new NetworkSourceFailure('network', 'DLNA 响应超过大小限制')
          return Readable.from([response.body.subarray(start)])
        },
        async close(): Promise<void> {
          lifetime.abort()
          controlUrl = null
        }
      }
    }
  }
}
