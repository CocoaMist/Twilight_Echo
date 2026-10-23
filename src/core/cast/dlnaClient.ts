import { createSocket, type Socket } from 'node:dgram'
import {
  extractControlUrlsFromDeviceDescription,
  buildSsdpMSearch,
  parseSsdpResponse,
  resolveUpnpUrl,
  SSDP_MULTICAST_ADDRESS,
  SSDP_PORT
} from './ssdp.ts'
import {
  buildAvTransportSoap,
  buildRenderingControlSoap,
  formatUpnpTime,
  parseUpnpTime
} from '../../shared/soap.ts'
import type { CastSample } from './castBackend.ts'
import type { DlnaDeviceInfo } from '../../shared/remoteControl.ts'

export interface DlnaDiscoveryOptions {
  timeoutMs?: number
  fetchText?: (url: string) => Promise<string>
  createSocket?: typeof createSocket
}

export async function discoverDlnaDevices(
  options: DlnaDiscoveryOptions = {}
): Promise<DlnaDeviceInfo[]> {
  const timeoutMs = options.timeoutMs ?? 2500
  const fetchText =
    options.fetchText ??
    (async (url: string) => {
      const response = await fetch(url, {
        headers: { 'user-agent': 'TwilightEcho/1.0 DLNA' },
        signal: AbortSignal.timeout(4000)
      })
      if (!response.ok) throw new Error(`device description HTTP ${response.status}`)
      return await response.text()
    })
  const socketFactory = options.createSocket ?? createSocket

  const responses = await collectSsdpResponses(socketFactory, timeoutMs)
  const byUsn = new Map<string, DlnaDeviceInfo>()

  for (const response of responses) {
    if (response.statusCode !== 200) continue
    try {
      const xml = await fetchText(response.location)
      const meta = extractControlUrlsFromDeviceDescription(xml)
      const avTransportUrl = resolveUpnpUrl(response.location, meta.avTransportUrl)
      const renderingControlUrl = resolveUpnpUrl(response.location, meta.renderingControlUrl)
      byUsn.set(response.usn, {
        usn: response.usn,
        friendlyName: meta.friendlyName,
        location: response.location,
        manufacturer: meta.manufacturer,
        modelName: meta.modelName,
        avTransportUrl,
        renderingControlUrl,
        lastSeenAt: Date.now()
      })
    } catch {
      // Skip devices that refuse description fetch.
    }
  }

  return Array.from(byUsn.values()).sort((a, b) =>
    a.friendlyName.localeCompare(b.friendlyName, 'zh-CN')
  )
}

function collectSsdpResponses(
  socketFactory: typeof createSocket,
  timeoutMs: number
): Promise<NonNullable<ReturnType<typeof parseSsdpResponse>>[]> {
  return new Promise((resolve) => {
    const found: NonNullable<ReturnType<typeof parseSsdpResponse>>[] = []
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
      resolve(found)
    }

    const timer = setTimeout(finish, timeoutMs)

    socket.on('message', (msg) => {
      const parsed = parseSsdpResponse(msg.toString('utf8'))
      if (parsed) found.push(parsed)
    })
    socket.on('error', () => {
      clearTimeout(timer)
      finish()
    })

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true)
      } catch {
        // optional
      }
      const payload = Buffer.from(buildSsdpMSearch(), 'utf8')
      socket.send(payload, 0, payload.length, SSDP_PORT, SSDP_MULTICAST_ADDRESS)
      // Second burst improves discovery on flaky networks.
      setTimeout(() => {
        try {
          socket.send(payload, 0, payload.length, SSDP_PORT, SSDP_MULTICAST_ADDRESS)
        } catch {
          // ignore
        }
      }, 200)
    })
  })
}

export async function dlnaSetAvTransportUri(
  controlUrl: string,
  mediaUrl: string,
  metadataXml = '',
  signal?: AbortSignal
): Promise<void> {
  const soap = buildAvTransportSoap('SetAVTransportURI', {
    CurrentURI: mediaUrl,
    CurrentURIMetaData: metadataXml
  })
  await postSoap(controlUrl, soap.soapAction, soap.body, signal)
}

export async function dlnaPlay(controlUrl: string, signal?: AbortSignal): Promise<void> {
  const soap = buildAvTransportSoap('Play', { Speed: '1' })
  await postSoap(controlUrl, soap.soapAction, soap.body, signal)
}

export async function dlnaPause(controlUrl: string, signal?: AbortSignal): Promise<void> {
  const soap = buildAvTransportSoap('Pause')
  await postSoap(controlUrl, soap.soapAction, soap.body, signal)
}

export async function dlnaStop(controlUrl: string, signal?: AbortSignal): Promise<void> {
  const soap = buildAvTransportSoap('Stop')
  await postSoap(controlUrl, soap.soapAction, soap.body, signal)
}

export async function dlnaSeek(
  controlUrl: string,
  positionSeconds: number,
  signal?: AbortSignal
): Promise<void> {
  const soap = buildAvTransportSoap('Seek', {
    Unit: 'REL_TIME',
    Target: formatUpnpTime(positionSeconds)
  })
  await postSoap(controlUrl, soap.soapAction, soap.body, signal)
}

export async function dlnaSetVolume(
  controlUrl: string,
  volume0to1: number,
  signal?: AbortSignal
): Promise<void> {
  const desired = Math.round(Math.min(1, Math.max(0, volume0to1)) * 100)
  const soap = buildRenderingControlSoap('SetVolume', { DesiredVolume: desired })
  await postSoap(controlUrl, soap.soapAction, soap.body, signal)
}

async function postSoap(
  controlUrl: string,
  soapAction: string,
  body: string,
  signal?: AbortSignal
): Promise<string> {
  const response = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      'content-type': 'text/xml; charset="utf-8"',
      soapaction: soapAction,
      'user-agent': 'TwilightEcho/1.0 DLNA'
    },
    body,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000)
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`DLNA SOAP failed (${response.status}): ${text.slice(0, 200)}`)
  }
  return response.text()
}

/** Read the actual renderer clock, not an interpolated frontend progress value. */
export async function dlnaStatus(controlUrl: string, signal?: AbortSignal): Promise<CastSample> {
  const read = async (action: 'GetTransportInfo' | 'GetPositionInfo') => {
    const soap = buildAvTransportSoap(action)
    return postSoap(controlUrl, soap.soapAction, soap.body, signal)
  }
  const [transport, position] = await Promise.all([
    read('GetTransportInfo'),
    read('GetPositionInfo')
  ])
  const field = (xml: string, name: string) =>
    new RegExp(`<(?:(?:[\\w-]+):)?${name}(?:\\s[^>]*)?>([^<]*)</`).exec(xml)?.[1] ?? ''
  const state = field(transport, 'CurrentTransportState')
  return {
    state: state === 'PLAYING' ? 'playing' : state === 'PAUSED_PLAYBACK' ? 'paused' : 'stopped',
    buffering: state === 'TRANSITIONING',
    position: parseUpnpTime(field(position, 'RelTime')) ?? 0,
    duration: parseUpnpTime(field(position, 'TrackDuration')) ?? 0,
    ended: state === 'STOPPED'
  }
}
