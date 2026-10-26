/**
 * Minimal Chromecast discovery (mDNS) + Cast v2 Default Media Receiver load.
 * No third-party cast libraries — keeps the Electron binary free of native deps.
 *
 * Security: only used on LAN; media URLs are already app-issued token URLs.
 */
import { parseJsonWithNestingLimit } from '../../shared/jsonSafety.ts'

import { createSocket, type Socket } from 'node:dgram'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { CastDevice, CastLoadRequest, CastSample } from './castBackend.ts'

const MDNS_ADDRESS = '224.0.0.251'
const MDNS_PORT = 5353
const CAST_DEFAULT_PORT = 8009
/** Default Media Receiver app id. */
const DEFAULT_MEDIA_RECEIVER = 'CC1AD845'

export interface ChromecastDiscoveryOptions {
  timeoutMs?: number
  createSocket?: typeof createSocket
}

export async function discoverChromecastDevices(
  options: ChromecastDiscoveryOptions = {}
): Promise<CastDevice[]> {
  const timeoutMs = options.timeoutMs ?? 2500
  const socketFactory = options.createSocket ?? createSocket
  const records = await queryGoogleCastMdns(socketFactory, timeoutMs)
  const devices: CastDevice[] = []
  const seen = new Set<string>()

  for (const rec of records) {
    const host = rec.address
    const port = rec.port || CAST_DEFAULT_PORT
    if (!host) continue
    const id = `chromecast:${host}:${port}`
    if (seen.has(id)) continue
    seen.add(id)
    devices.push({
      id,
      protocol: 'chromecast',
      friendlyName: rec.friendlyName || `Chromecast (${host})`,
      manufacturer: 'Google',
      modelName: rec.model || 'Chromecast',
      location: `${host}:${port}`,
      avTransportUrl: null,
      renderingControlUrl: null,
      host,
      port,
      lastSeenAt: Date.now()
    })
  }

  return devices.sort((a, b) => a.friendlyName.localeCompare(b.friendlyName, 'zh-CN'))
}

interface MdnsCastRecord {
  address: string
  port: number
  friendlyName: string
  model: string
}

function queryGoogleCastMdns(
  socketFactory: typeof createSocket,
  timeoutMs: number
): Promise<MdnsCastRecord[]> {
  return new Promise((resolve) => {
    const found = new Map<string, MdnsCastRecord>()
    let socket: Socket
    try {
      socket = socketFactory('udp4')
    } catch {
      resolve([])
      return
    }

    const finish = (): void => {
      try {
        socket.close()
      } catch {
        // ignore
      }
      resolve(Array.from(found.values()))
    }

    const timer = setTimeout(finish, timeoutMs)

    socket.on('message', (msg, rinfo) => {
      try {
        const parsed = parseMdnsCastResponse(msg, rinfo.address)
        for (const rec of parsed) {
          const key = `${rec.address}:${rec.port}`
          const prev = found.get(key)
          if (!prev || (rec.friendlyName && !prev.friendlyName)) {
            found.set(key, rec)
          }
        }
      } catch {
        // ignore malformed packets
      }
    })
    socket.on('error', () => {
      clearTimeout(timer)
      finish()
    })

    socket.bind(0, () => {
      try {
        socket.addMembership(MDNS_ADDRESS)
      } catch {
        // membership optional on some hosts
      }
      const query = buildMdnsPtrQuery('_googlecast._tcp.local')
      try {
        socket.send(query, 0, query.length, MDNS_PORT, MDNS_ADDRESS)
      } catch {
        clearTimeout(timer)
        finish()
        return
      }
      setTimeout(() => {
        try {
          socket.send(query, 0, query.length, MDNS_PORT, MDNS_ADDRESS)
        } catch {
          // ignore
        }
      }, 200)
    })
  })
}

/** Build a minimal mDNS PTR query packet. */
function buildMdnsPtrQuery(name: string): Buffer {
  const labels = name.split('.').filter(Boolean)
  const nameBufs: Buffer[] = []
  for (const label of labels) {
    const b = Buffer.from(label, 'utf8')
    nameBufs.push(Buffer.from([b.length]), b)
  }
  nameBufs.push(Buffer.from([0]))
  const qname = Buffer.concat(nameBufs)
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x0000, 0) // id
  header.writeUInt16BE(0x0000, 2) // flags (standard query)
  header.writeUInt16BE(1, 4) // QDCOUNT
  header.writeUInt16BE(0, 6)
  header.writeUInt16BE(0, 8)
  header.writeUInt16BE(0, 10)
  const question = Buffer.alloc(4)
  question.writeUInt16BE(12, 0) // PTR
  question.writeUInt16BE(1, 2) // IN
  return Buffer.concat([header, qname, question])
}

function parseMdnsCastResponse(msg: Buffer, fallbackAddress: string): MdnsCastRecord[] {
  if (msg.length < 12) return []
  const ancount = msg.readUInt16BE(6)
  const nscount = msg.readUInt16BE(8)
  const arcount = msg.readUInt16BE(10)
  let offset = 12
  // skip questions
  const qdcount = msg.readUInt16BE(4)
  for (let i = 0; i < qdcount; i++) {
    offset = skipName(msg, offset)
    offset += 4
  }

  const txtByTarget = new Map<string, Record<string, string>>()
  const srvByTarget = new Map<string, { port: number; target: string }>()
  const aByHost = new Map<string, string>()
  const ptrTargets: string[] = []

  const total = ancount + nscount + arcount
  for (let i = 0; i < total && offset + 10 <= msg.length; i++) {
    const nameResult = readName(msg, offset)
    offset = nameResult.next
    if (offset + 10 > msg.length) break
    const type = msg.readUInt16BE(offset)
    offset += 2
    offset += 2 // class
    offset += 4 // ttl
    const rdlength = msg.readUInt16BE(offset)
    offset += 2
    if (offset + rdlength > msg.length) break
    const rdata = msg.subarray(offset, offset + rdlength)
    const owner = nameResult.name.toLowerCase()

    if (type === 12 /* PTR */) {
      const ptr = readName(rdata, 0, msg)
      if (owner.includes('_googlecast._tcp')) {
        ptrTargets.push(ptr.name.toLowerCase())
      }
    } else if (type === 33 /* SRV */) {
      if (rdata.length >= 6) {
        const port = rdata.readUInt16BE(4)
        const target = readName(rdata, 6, msg).name.toLowerCase()
        srvByTarget.set(owner, { port, target })
      }
    } else if (type === 16 /* TXT */) {
      txtByTarget.set(owner, parseTxt(rdata))
    } else if (type === 1 /* A */ && rdata.length >= 4) {
      const ip = `${rdata[0]}.${rdata[1]}.${rdata[2]}.${rdata[3]}`
      aByHost.set(owner, ip)
    }
    offset += rdlength
  }

  const results: MdnsCastRecord[] = []
  const targets = ptrTargets.length > 0 ? ptrTargets : Array.from(srvByTarget.keys())
  for (const service of targets) {
    if (!service.includes('googlecast') && !srvByTarget.has(service)) continue
    const srv = srvByTarget.get(service)
    const txt = txtByTarget.get(service) ?? {}
    const hostName = srv?.target ?? ''
    const address = (hostName && aByHost.get(hostName)) || fallbackAddress
    if (!address) continue
    results.push({
      address,
      port: srv?.port ?? CAST_DEFAULT_PORT,
      friendlyName: txt.fn || txt.md || service.split('.')[0] || 'Chromecast',
      model: txt.md || 'Chromecast'
    })
  }
  return results
}

function parseTxt(rdata: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  while (i < rdata.length) {
    const len = rdata[i++]
    if (len === 0 || i + len > rdata.length) break
    const pair = rdata.subarray(i, i + len).toString('utf8')
    i += len
    const eq = pair.indexOf('=')
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return out
}

function skipName(buf: Buffer, offset: number): number {
  return readName(buf, offset).next
}

function readName(
  buf: Buffer,
  offset: number,
  fullMessage?: Buffer
): { name: string; next: number } {
  const labels: string[] = []
  let jumped = false
  let next = offset
  let guard = 0
  const msg = fullMessage ?? buf

  while (guard++ < 64 && offset < buf.length) {
    const len = buf[offset]
    if (len === 0) {
      if (!jumped) next = offset + 1
      break
    }
    if ((len & 0xc0) === 0xc0) {
      if (offset + 1 >= buf.length) break
      const pointer = ((len & 0x3f) << 8) | buf[offset + 1]
      if (!jumped) next = offset + 2
      jumped = true
      // Continue reading from pointer in the full message.
      const nested = readName(msg, pointer, msg)
      labels.push(...nested.name.split('.').filter(Boolean))
      break
    }
    offset += 1
    if (offset + len > buf.length) break
    labels.push(buf.subarray(offset, offset + len).toString('utf8'))
    offset += len
    if (!jumped) next = offset
  }
  return { name: labels.join('.'), next }
}

// ─── Cast v2 session ─────────────────────────────────────────────────────────

interface ActiveCastSession {
  socket: TLSSocket
  requestId: number
  transportId: string | null
  mediaSessionId: number | null
  receiverSessionId: string | null
  receiverAppId: string | null
  closed: boolean
  sample: CastSample | null
  volume?: number
  detachAbort?: () => void
  replies: Map<
    number,
    { resolve(value: Record<string, unknown>): void; reject(error: Error): void }
  >
}

const sessions = new Map<string, ActiveCastSession>()

function nextRequestId(session: ActiveCastSession): number {
  session.requestId += 1
  return session.requestId
}

export async function chromecastLoad(
  device: CastDevice,
  request: CastLoadRequest,
  options: {
    signal?: AbortSignal
    confirmed?: boolean
    connect?: typeof tlsConnect
    receiverReady?(sessionId: string): Promise<void>
  } = {}
): Promise<void> {
  const host = device.host
  const port = device.port ?? CAST_DEFAULT_PORT
  if (!host) throw new Error('Chromecast device host is missing')

  await chromecastStop(device).catch(() => {})

  const session = await openCastSession(host, port, options.signal, options.connect)
  session.detachAbort?.()
  sessions.set(device.id, session)

  try {
    // Launch Default Media Receiver
    await sendJson(session, 'sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.receiver', {
      type: 'LAUNCH',
      appId: DEFAULT_MEDIA_RECEIVER,
      requestId: nextRequestId(session)
    })

    const transportId = await waitForTransportId(session, 8000, options.signal)
    session.transportId = transportId

    await sendJson(session, 'sender-0', transportId, 'urn:x-cast:com.google.cast.tp.connection', {
      type: 'CONNECT',
      origin: {}
    })

    const contentType = request.contentType || 'audio/mpeg'
    const media = {
      contentId: request.mediaUrl,
      streamType: 'BUFFERED',
      contentType,
      metadata: {
        metadataType: 3,
        title: request.title || 'Twilight Echo',
        artist: request.artist || '',
        albumName: request.album || ''
      }
    }

    const loadId = nextRequestId(session)
    if (options.receiverReady) {
      if (!session.receiverSessionId)
        throw new Error('Chromecast receiver session identity missing')
      await options.receiverReady(session.receiverSessionId)
      options.signal?.throwIfAborted()
    }
    const load = {
      type: 'LOAD',
      requestId: loadId,
      media,
      autoplay: request.autoplay ?? true,
      currentTime: Math.max(0, request.positionSeconds ?? 0)
    }
    if (options.confirmed) {
      await requestReply(
        session,
        transportId,
        'urn:x-cast:com.google.cast.media',
        load,
        options.signal
      )
      if (session.mediaSessionId == null) throw new Error('Chromecast did not accept the media')
    } else {
      await sendJson(session, 'sender-0', transportId, 'urn:x-cast:com.google.cast.media', load)
      // Compatibility callers retain their original best-effort load behavior.
      await waitForMediaSession(session, 5000).catch(() => {})
    }
  } catch (error) {
    if (!options.confirmed) closeSession(device.id)
    throw error
  } finally {
    session.detachAbort?.()
  }
}

export async function chromecastPlay(device: CastDevice): Promise<void> {
  const session = sessions.get(device.id)
  if (!session?.transportId || session.mediaSessionId == null) return
  await sendJson(session, 'sender-0', session.transportId, 'urn:x-cast:com.google.cast.media', {
    type: 'PLAY',
    requestId: nextRequestId(session),
    mediaSessionId: session.mediaSessionId
  })
}

export async function chromecastPause(device: CastDevice): Promise<void> {
  const session = sessions.get(device.id)
  if (!session?.transportId || session.mediaSessionId == null) return
  await sendJson(session, 'sender-0', session.transportId, 'urn:x-cast:com.google.cast.media', {
    type: 'PAUSE',
    requestId: nextRequestId(session),
    mediaSessionId: session.mediaSessionId
  })
}

export async function chromecastStop(
  device: CastDevice,
  options: { confirmed?: boolean } = {}
): Promise<void> {
  const session = sessions.get(device.id)
  if (!session) return
  if (options.confirmed) {
    const expected = session.receiverSessionId
    await requestReply(session, 'receiver-0', 'urn:x-cast:com.google.cast.receiver', {
      type: 'GET_STATUS',
      requestId: nextRequestId(session)
    })
    // A different receiver app/session belongs to another controller now.
    if (
      session.receiverSessionId &&
      session.receiverAppId === DEFAULT_MEDIA_RECEIVER &&
      (!expected || expected === session.receiverSessionId)
    ) {
      const stoppedSessionId = session.receiverSessionId
      await requestReply(session, 'receiver-0', 'urn:x-cast:com.google.cast.receiver', {
        type: 'STOP',
        requestId: nextRequestId(session),
        sessionId: stoppedSessionId
      })
      if (session.receiverSessionId === stoppedSessionId)
        throw new Error('Chromecast did not confirm Stop')
    }
    closeSession(device.id)
    return
  }
  try {
    if (session.transportId && session.mediaSessionId != null) {
      await sendJson(session, 'sender-0', session.transportId, 'urn:x-cast:com.google.cast.media', {
        type: 'STOP',
        requestId: nextRequestId(session),
        mediaSessionId: session.mediaSessionId
      })
    }
    await sendJson(session, 'sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.receiver', {
      type: 'STOP',
      requestId: nextRequestId(session),
      ...(session.receiverSessionId ? { sessionId: session.receiverSessionId } : {})
    })
  } catch {
    // ignore
  }
  closeSession(device.id)
}

export async function chromecastSeek(device: CastDevice, positionSeconds: number): Promise<void> {
  const session = sessions.get(device.id)
  if (!session?.transportId || session.mediaSessionId == null) return
  await sendJson(session, 'sender-0', session.transportId, 'urn:x-cast:com.google.cast.media', {
    type: 'SEEK',
    requestId: nextRequestId(session),
    mediaSessionId: session.mediaSessionId,
    currentTime: Math.max(0, positionSeconds)
  })
}

export async function chromecastSetVolume(device: CastDevice, volume0to1: number): Promise<void> {
  const session = sessions.get(device.id)
  if (!session) return
  const level = Math.min(1, Math.max(0, volume0to1))
  await sendJson(session, 'sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.receiver', {
    type: 'SET_VOLUME',
    requestId: nextRequestId(session),
    volume: { level, muted: false }
  })
}

function closeSession(deviceId: string): void {
  const session = sessions.get(deviceId)
  if (!session) return
  session.closed = true
  for (const reply of session.replies.values()) reply.reject(new Error('Chromecast session closed'))
  session.replies.clear()
  try {
    session.socket.destroy()
  } catch {
    // ignore
  }
  sessions.delete(deviceId)
}

function openCastSession(
  host: string,
  port: number,
  signal?: AbortSignal,
  connect = tlsConnect
): Promise<ActiveCastSession> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    let session: ActiveCastSession | undefined
    const socket = connect(
      {
        host,
        port,
        rejectUnauthorized: false,
        servername: host
      },
      () => {
        session = {
          socket,
          requestId: 1,
          transportId: null,
          mediaSessionId: null,
          receiverSessionId: null,
          receiverAppId: null,
          closed: false,
          sample: null,
          replies: new Map(),
          detachAbort: () => signal?.removeEventListener('abort', abort)
        }
        const active = session
        // Platform connection handshake
        void sendJson(
          active,
          'sender-0',
          'receiver-0',
          'urn:x-cast:com.google.cast.tp.connection',
          {
            type: 'CONNECT',
            origin: {}
          }
        )
          .then(() =>
            sendJson(active, 'sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.tp.heartbeat', {
              type: 'PING'
            })
          )
          .then(() => resolve(active))
          .catch(reject)

        // Heartbeat
        const heartbeat = setInterval(() => {
          if (active.closed) {
            clearInterval(heartbeat)
            return
          }
          void sendJson(
            active,
            'sender-0',
            'receiver-0',
            'urn:x-cast:com.google.cast.tp.heartbeat',
            {
              type: 'PING'
            }
          ).catch(() => {
            clearInterval(heartbeat)
          })
        }, 5000)
        socket.on('close', () => {
          active.closed = true
          for (const reply of active.replies.values())
            reply.reject(new Error('Chromecast connection closed'))
          active.replies.clear()
          clearInterval(heartbeat)
        })
        socket.on('error', () => {
          active.closed = true
          for (const reply of active.replies.values())
            reply.reject(new Error('Chromecast connection closed'))
          active.replies.clear()
          clearInterval(heartbeat)
        })

        // Inbound message pump
        let buffer = Buffer.alloc(0)
        socket.on('data', (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk])
          for (;;) {
            if (buffer.length < 4) break
            const size = buffer.readUInt32BE(0)
            if (buffer.length < 4 + size) break
            const frame = buffer.subarray(4, 4 + size)
            buffer = buffer.subarray(4 + size)
            handleCastFrame(active, frame)
          }
        })
      }
    )
    const abort = () =>
      socket.destroy(signal?.reason instanceof Error ? signal.reason : new Error('Cast cancelled'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    socket.once('close', () => signal?.removeEventListener('abort', abort))
    socket.setTimeout(12_000)
    socket.on('error', reject)
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error('Chromecast connection timed out'))
    })
  })
}

function handleCastFrame(session: ActiveCastSession, frame: Buffer): void {
  try {
    const msg = decodeCastMessage(frame)
    if (!msg.payloadUtf8) return
    const payload = parseJsonWithNestingLimit(msg.payloadUtf8) as Record<string, unknown>
    if (payload.type === 'PONG') return
    if (payload.type === 'RECEIVER_STATUS') {
      const status = payload.status as
        | {
            applications?: Array<{ transportId?: string; sessionId?: string; appId?: string }>
            volume?: { level?: number }
          }
        | undefined
      const app = status?.applications?.[0]
      if (app?.transportId) session.transportId = app.transportId
      session.receiverSessionId = app?.sessionId ?? null
      session.receiverAppId = app?.appId ?? null
      if (typeof status?.volume?.level === 'number') session.volume = status.volume.level
    }
    if (payload.type === 'MEDIA_STATUS') {
      const status = (
        payload.status as
          | Array<{
              mediaSessionId?: number
              playerState?: string
              currentTime?: number
              media?: { duration?: number }
              idleReason?: string
            }>
          | undefined
      )?.[0]
      if (typeof status?.mediaSessionId === 'number') session.mediaSessionId = status.mediaSessionId
      if (status)
        session.sample = {
          state:
            status.playerState === 'PLAYING'
              ? 'playing'
              : status.playerState === 'PAUSED'
                ? 'paused'
                : 'stopped',
          buffering: status.playerState === 'BUFFERING',
          position: status.currentTime ?? 0,
          duration: status.media?.duration ?? session.sample?.duration ?? 0,
          ended: status.playerState === 'IDLE' && status.idleReason === 'FINISHED'
        }
    }
    if (typeof payload.requestId === 'number') {
      const reply = session.replies.get(payload.requestId)
      if (reply) {
        session.replies.delete(payload.requestId)
        if (['INVALID_REQUEST', 'LOAD_FAILED', 'LOAD_CANCELLED'].includes(String(payload.type)))
          reply.reject(new Error(`Chromecast ${payload.type}`))
        else reply.resolve(payload)
      }
    }
  } catch {
    // ignore
  }
}

function requestReply(
  session: ActiveCastSession,
  destination: string,
  namespace: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted()
  const requestId = Number(payload.requestId)
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      session.replies.delete(requestId)
      if (error) reject(error)
      else resolve(value!)
    }
    const abort = () => finish(signal?.reason ?? new Error('Cast cancelled'))
    const timer = setTimeout(() => finish(new Error('Chromecast reply timed out')), 8000)
    session.replies.set(requestId, { resolve: (value) => finish(undefined, value), reject: finish })
    signal?.addEventListener('abort', abort, { once: true })
    void sendJson(session, 'sender-0', destination, namespace, payload).catch(finish)
  })
}

export async function chromecastStatus(
  device: CastDevice,
  signal?: AbortSignal
): Promise<CastSample> {
  const session = sessions.get(device.id)
  if (!session?.transportId || session.closed) throw new Error('Chromecast session unavailable')
  const [media] = await Promise.all([
    requestReply(
      session,
      session.transportId,
      'urn:x-cast:com.google.cast.media',
      {
        type: 'GET_STATUS',
        requestId: nextRequestId(session)
      },
      signal
    ),
    requestReply(
      session,
      'receiver-0',
      'urn:x-cast:com.google.cast.receiver',
      {
        type: 'GET_STATUS',
        requestId: nextRequestId(session)
      },
      signal
    )
  ])
  if (!Array.isArray(media.status) || media.status.length === 0 || !session.sample)
    throw new Error('Chromecast media status missing')
  return { ...session.sample, ...(session.volume === undefined ? {} : { volume: session.volume }) }
}

/** Main's crash-stop path opens only a control connection. It never launches an
 * app, loads media or stops a receiver session now owned by another controller. */
export async function chromecastStopReceiver(
  host: string,
  port: number,
  receiverSessionId: string,
  connect = tlsConnect
): Promise<void> {
  const session = await openCastSession(host, port, undefined, connect)
  const containsReceiver = (reply: Record<string, unknown>): boolean => {
    if (reply.type !== 'RECEIVER_STATUS' || !reply.status || typeof reply.status !== 'object')
      throw new Error('Chromecast receiver status missing')
    const applications = (reply.status as { applications?: Array<{ sessionId?: string }> })
      .applications
    return applications?.some((app) => app.sessionId === receiverSessionId) ?? false
  }
  try {
    const status = await requestReply(
      session,
      'receiver-0',
      'urn:x-cast:com.google.cast.receiver',
      {
        type: 'GET_STATUS',
        requestId: nextRequestId(session)
      }
    )
    if (!containsReceiver(status)) return
    const stopped = await requestReply(
      session,
      'receiver-0',
      'urn:x-cast:com.google.cast.receiver',
      {
        type: 'STOP',
        requestId: nextRequestId(session),
        sessionId: receiverSessionId
      }
    )
    if (containsReceiver(stopped)) throw new Error('Chromecast did not confirm Stop')
  } finally {
    session.socket.destroy()
  }
}

function waitForTransportId(
  session: ActiveCastSession,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const timer = setInterval(() => {
      if (signal?.aborted) {
        clearInterval(timer)
        reject(signal.reason)
        return
      }
      if (session.transportId) {
        clearInterval(timer)
        resolve(session.transportId)
        return
      }
      if (Date.now() - start > timeoutMs || session.closed) {
        clearInterval(timer)
        reject(new Error('Chromecast receiver did not launch in time'))
      }
    }, 50)
  })
}

function waitForMediaSession(session: ActiveCastSession, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const timer = setInterval(() => {
      if (session.mediaSessionId != null) {
        clearInterval(timer)
        resolve()
        return
      }
      if (Date.now() - start > timeoutMs || session.closed) {
        clearInterval(timer)
        reject(new Error('Chromecast media session not ready'))
      }
    }, 50)
  })
}

async function sendJson(
  session: ActiveCastSession,
  sourceId: string,
  destinationId: string,
  namespace: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (session.closed) throw new Error('Chromecast session closed')
  const body = JSON.stringify(payload)
  const frame = encodeCastMessage({
    sourceId,
    destinationId,
    namespace,
    payloadUtf8: body
  })
  const header = Buffer.alloc(4)
  header.writeUInt32BE(frame.length, 0)
  await new Promise<void>((resolve, reject) => {
    session.socket.write(Buffer.concat([header, frame]), (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

/** Protobuf wire encoding for CastMessage (subset used by castv2 JSON payloads). */
function encodeCastMessage(msg: {
  sourceId: string
  destinationId: string
  namespace: string
  payloadUtf8: string
}): Buffer {
  const parts: Buffer[] = []
  // protocol_version = 0 (field 1, varint)
  parts.push(Buffer.from([0x08, 0x00]))
  parts.push(encodeStringField(2, msg.sourceId))
  parts.push(encodeStringField(3, msg.destinationId))
  parts.push(encodeStringField(4, msg.namespace))
  // payload_type = STRING (0) field 5
  parts.push(Buffer.from([0x28, 0x00]))
  parts.push(encodeStringField(6, msg.payloadUtf8))
  return Buffer.concat(parts)
}

function encodeStringField(fieldNumber: number, value: string): Buffer {
  const data = Buffer.from(value, 'utf8')
  const tag = (fieldNumber << 3) | 2
  return Buffer.concat([Buffer.from([tag]), encodeVarint(data.length), data])
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = []
  let v = value >>> 0
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  bytes.push(v)
  return Buffer.from(bytes)
}

function decodeCastMessage(buf: Buffer): {
  sourceId: string
  destinationId: string
  namespace: string
  payloadUtf8: string
} {
  let offset = 0
  let sourceId = ''
  let destinationId = ''
  let namespace = ''
  let payloadUtf8 = ''
  while (offset < buf.length) {
    const tagResult = readVarint(buf, offset)
    offset = tagResult.next
    const field = tagResult.value >>> 3
    const wire = tagResult.value & 0x7
    if (wire === 0) {
      const v = readVarint(buf, offset)
      offset = v.next
    } else if (wire === 2) {
      const len = readVarint(buf, offset)
      offset = len.next
      const data = buf.subarray(offset, offset + len.value).toString('utf8')
      offset += len.value
      if (field === 2) sourceId = data
      else if (field === 3) destinationId = data
      else if (field === 4) namespace = data
      else if (field === 6) payloadUtf8 = data
    } else {
      break
    }
  }
  return { sourceId, destinationId, namespace, payloadUtf8 }
}

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let result = 0
  let shift = 0
  let pos = offset
  while (pos < buf.length) {
    const byte = buf[pos++]
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  return { value: result >>> 0, next: pos }
}
