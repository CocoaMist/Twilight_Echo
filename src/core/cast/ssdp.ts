export const SSDP_MULTICAST_ADDRESS = '239.255.255.250'
export const SSDP_PORT = 1900
export const SSDP_DEFAULT_MX = 2

export interface SsdpSearchOptions {
  st?: string
  mx?: number
  man?: string
}

export interface ParsedSsdpResponse {
  statusCode: number
  headers: Record<string, string>
  usn: string
  location: string
  st: string
  server: string
}

export function buildSsdpMSearch(options: SsdpSearchOptions = {}): string {
  const st = options.st ?? 'urn:schemas-upnp-org:device:MediaRenderer:1'
  const mx = Math.max(1, Math.min(5, options.mx ?? SSDP_DEFAULT_MX))
  const man = options.man ?? '"ssdp:discover"'
  return [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_MULTICAST_ADDRESS}:${SSDP_PORT}`,
    `MAN: ${man}`,
    `MX: ${mx}`,
    `ST: ${st}`,
    '',
    ''
  ].join('\r\n')
}

export function parseSsdpResponse(raw: string): ParsedSsdpResponse | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  const statusLine = lines[0]?.trim() ?? ''
  const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})/i.exec(statusLine)
  if (!statusMatch) return null
  const statusCode = Number(statusMatch[1])
  const headers: Record<string, string> = {}
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line || !line.trim()) break
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    headers[key] = value
  }
  const location = headers.location ?? ''
  const usn = headers.usn ?? location
  if (!location || !usn) return null
  return {
    statusCode,
    headers,
    usn,
    location,
    st: headers.st ?? '',
    server: headers.server ?? ''
  }
}

export function extractControlUrlsFromDeviceDescription(xml: string): {
  friendlyName: string
  manufacturer: string
  modelName: string
  avTransportUrl: string | null
  renderingControlUrl: string | null
} {
  const text = typeof xml === 'string' ? xml : ''
  const friendlyName = firstTagText(text, 'friendlyName') || 'DLNA Device'
  const manufacturer = firstTagText(text, 'manufacturer')
  const modelName = firstTagText(text, 'modelName')

  let avTransportUrl: string | null = null
  let renderingControlUrl: string | null = null

  const serviceBlocks = text.match(/<service\b[\s\S]*?<\/service>/gi) ?? []
  for (const block of serviceBlocks) {
    const type = firstTagText(block, 'serviceType').toLowerCase()
    const control = firstTagText(block, 'controlURL')
    if (!control) continue
    if (type.includes('avtransport')) avTransportUrl = control
    if (type.includes('renderingcontrol')) renderingControlUrl = control
  }

  return { friendlyName, manufacturer, modelName, avTransportUrl, renderingControlUrl }
}

export function resolveUpnpUrl(baseLocation: string, controlUrl: string | null): string | null {
  if (!controlUrl) return null
  try {
    return new URL(controlUrl, baseLocation).toString()
  } catch {
    return null
  }
}

function firstTagText(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
  const match = re.exec(xml)
  if (!match) return ''
  return match[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
}
