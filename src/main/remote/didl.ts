/** Minimal DIDL-Lite metadata for SetAVTransportURI. */

import { escapeXml as escapeXmlForDidl } from './soap.ts'
export { escapeXmlForDidl }

export function buildDidlLiteMetadata(options: {
  title: string
  artist?: string
  album?: string
  resUrl: string
  contentType?: string
}): string {
  const title = escapeXmlForDidl(options.title || 'Unknown')
  const artist = escapeXmlForDidl(options.artist || '')
  const album = escapeXmlForDidl(options.album || '')
  const resUrl = escapeXmlForDidl(options.resUrl)
  const protocolInfo = options.contentType
    ? `http-get:*:${options.contentType}:*`
    : 'http-get:*:audio/*:*'
  return [
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"',
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"',
    ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">',
    '<item id="0" parentID="0" restricted="1">',
    `<dc:title>${title}</dc:title>`,
    artist ? `<upnp:artist>${artist}</upnp:artist>` : '',
    album ? `<upnp:album>${album}</upnp:album>` : '',
    '<upnp:class>object.item.audioItem.musicTrack</upnp:class>',
    `<res protocolInfo="${protocolInfo}">${resUrl}</res>`,
    '</item>',
    '</DIDL-Lite>'
  ].join('')
}
