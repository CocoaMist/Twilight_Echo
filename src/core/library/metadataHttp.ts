/** One host budget for all Core public-metadata exits, including the Rhine adapter. */
const HOSTS = new Set([
  'musicbrainz.org',
  'www.wikidata.org',
  'commons.wikimedia.org',
  'zh.wikipedia.org',
  'en.wikipedia.org'
])
const MBID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'
const caaIndex = (url: URL) => url.hostname === 'coverartarchive.org' && !url.search && !url.hash &&
  new RegExp(`^/release(?:-group)?/${MBID}/?$`, 'i').test(url.pathname)
function archiveIndex(url: URL): string | null {
  if (url.search || url.hash) return null
  const path = url.hostname === 'archive.org' ? '^/download/' :
    /^[a-z0-9-]+\.(?:us|ca)\.archive\.org$/.test(url.hostname) ? '^/\\d+/items/' : null
  return path ? new RegExp(`${path}mbid-(${MBID})/index\\.json$`, 'i').exec(url.pathname)?.[1].toLowerCase() ?? null : null
}
const qqMetadata = (url: URL, init: RequestInit) => url.hostname === 'u.y.qq.com' &&
  url.pathname === '/cgi-bin/musicu.fcg' && !url.search && !url.hash && init.method === 'POST' &&
  typeof init.body === 'string' && init.body.length <= 32768

function publicMusicEndpoint(url: URL) {
  if (url.hash) return false
  if (url.hostname === 'vocadb.net') return /^\/api\/(?:artists|albums)(?:\/[1-9]\d*)?$/.test(url.pathname)
  if (url.hostname === 'api.discogs.com') return /^\/(?:database\/search|(?:artists|masters|releases)\/[1-9]\d*)$/.test(url.pathname)
  return url.hostname === 'www.theaudiodb.com' &&
    /^\/api\/v1\/json\/[A-Za-z0-9_-]{1,128}\/(?:search|searchalbum|artist|artist-mb|album|album-mb)\.php$/.test(url.pathname)
}

/** CAA's JSON index is hosted on IA. Only this exact index redirect chain is
 * accepted; arbitrary archive files and image downloads are not metadata exits. */
async function fetchMetadata(fetcher: typeof fetch, url: URL, init: RequestInit): Promise<Response> {
  if (!caaIndex(url)) return fetcher(url, { ...init, redirect: 'error' })
  let current = url
  let release: string | null = null
  for (let hops = 0; ; hops++) {
    const response = await fetcher(current, { ...init, redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location || hops >= 3) throw new Error('Unsupported CAA index redirect')
    const next = new URL(location, current)
    const id = archiveIndex(next)
    if (next.protocol !== 'https:' || next.port || next.username || next.password || !id || (release && release !== id))
      throw new Error('Unsupported CAA index redirect')
    release = id
    current = next
  }
}
export class MetadataHttpError extends Error {
  readonly status: number
  readonly retryAt: number | null
  constructor(message: string, status: number, retryAt: number | null = null) {
    super(message)
    this.status = status
    this.retryAt = retryAt
  }
}
export function retryAfter(value: string | null, now: number): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(now, date) : null
}
export function metadataDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    const abort = () => {
      done()
      reject(signal.reason)
    }
    const timer = setTimeout(
      () => {
        done()
        resolve()
      },
      Math.max(0, ms)
    )
    signal.addEventListener('abort', abort, { once: true })
  })
}
interface Shared {
  controller: AbortController
  consumers: number
  promise: Promise<Response>
}
export class MetadataHttp {
  private readonly hosts = new Map<string, { tail: Promise<unknown>; next: number }>()
  private readonly requests = new Map<string, Shared>()
  private readonly fetcher: typeof fetch
  private readonly interval: number
  private readonly now: () => number
  constructor(fetcher: typeof fetch = globalThis.fetch, interval = 1100, now = Date.now) {
    this.fetcher = fetcher
    this.interval = interval
    this.now = now
  }
  fetch = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input))
    const qq = qqMetadata(url, init)
    if (
      url.protocol !== 'https:' ||
      (!HOSTS.has(url.hostname) && !caaIndex(url) && !qq && !publicMusicEndpoint(url)) ||
      url.port ||
      url.username ||
      url.password ||
      (!qq && ((init.method && init.method !== 'GET') || init.body))
    )
      return Promise.reject(new Error('Unsupported public metadata endpoint'))
    const signal = init.signal
    if (signal?.aborted) return Promise.reject(signal.reason)
    const key = JSON.stringify([url.href, [...new Headers(init.headers).entries()].sort(), ...(qq ? [init.method, init.body] : [])])
    let shared = this.requests.get(key)
    if (!shared) {
      const controller = new AbortController()
      const host = this.hosts.get(url.hostname) ?? { tail: Promise.resolve(), next: 0 }
      this.hosts.set(url.hostname, host)
      const promise = host.tail
        .catch(() => {})
        .then(async () => {
          const current = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])
          while (host.next > this.now())
            await metadataDelay(Math.min(2147483647, host.next - this.now()), current)
          current.throwIfAborted()
          // Free tiers: TAB 30/min, Discogs unauthenticated 25/min. VocaDB
          // discourages bulk crawling; every lookup uses this same host queue.
          const minimum = ({ 'www.theaudiodb.com': 2100, 'api.discogs.com': 2500, 'vocadb.net': 1500 })[url.hostname] ?? 0
          host.next = this.now() + (this.interval === 0 ? 0 : Math.max(this.interval, minimum))
          const response = await fetchMetadata(this.fetcher, url, { ...init, signal: current })
          if ([429, 503].includes(response.status))
            host.next = Math.max(
              host.next,
              retryAfter(response.headers.get('retry-after'), this.now()) ?? 0
            )
          const reader = response.body?.getReader()
          const chunks: Uint8Array[] = []
          let bytes = 0
          try {
            while (reader) {
              const item = await reader.read()
              if (item.done) break
              bytes += item.value.byteLength
              if (bytes > 2 * 1024 * 1024) throw new Error('Metadata response exceeds 2 MiB')
              chunks.push(item.value)
            }
          } finally {
            await reader?.cancel().catch(() => {})
          }
          const data = new Uint8Array(bytes)
          let offset = 0
          for (const chunk of chunks) {
            data.set(chunk, offset)
            offset += chunk.byteLength
          }
          return new Response([204, 205, 304].includes(response.status) ? null : data, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          })
        })
      host.tail = promise
      shared = { controller, consumers: 0, promise }
      this.requests.set(key, shared)
      const entry = shared
      void promise
        .finally(() => {
          if (this.requests.get(key) === entry) this.requests.delete(key)
        })
        .catch(() => {})
    }
    shared.consumers++
    const entry = shared
    return new Promise<Response>((resolve, reject) => {
      let done = false
      const finish = () => {
        if (done) return false
        done = true
        signal?.removeEventListener('abort', abort)
        if (--entry.consumers === 0) {
          if (this.requests.get(key) === entry) this.requests.delete(key)
          entry.controller.abort(new Error('No metadata request consumers'))
        }
        return true
      }
      const abort = () => {
        if (finish()) reject(signal?.reason)
      }
      signal?.addEventListener('abort', abort, { once: true })
      entry.promise.then(
        (response) => {
          if (finish()) resolve(response.clone())
        },
        (error) => {
          if (finish()) reject(error)
        }
      )
    })
  }
}
export const publicMetadataHttp = new MetadataHttp()
