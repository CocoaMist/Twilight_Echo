import { createDecipheriv } from 'node:crypto'
import { normalizeNcmFileIdentity, type NcmFileIdentity } from '../../shared/ncmFileIdentity.ts'

const prefix = "163 key(Don't modify):"
/** Public file-format key, not an account credential. Only structured identity is retained. */
export function readNcmFileIdentity(comments: unknown): NcmFileIdentity | undefined {
  if (!Array.isArray(comments) || comments.length > 64) return undefined
  const values = comments.flatMap(c => {
    const text = typeof c === 'string' ? c : c && typeof c === 'object' ? c.text : undefined
    return typeof text === 'string' && text.startsWith(prefix) ? [text] : []
  })
  if (values.length !== 1 || values[0].length > 32768) return undefined
  try {
    const encoded = values[0].slice(prefix.length).trim()
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return undefined
    const cipher = createDecipheriv('aes-128-ecb', Buffer.from("#14ljk_!\\]&0U<'("), null)
    const plain = Buffer.concat([cipher.update(Buffer.from(encoded, 'base64')), cipher.final()]).toString('utf8')
    if (!plain.startsWith('music:')) return undefined
    const v = JSON.parse(plain.slice(6))
    return normalizeNcmFileIdentity({ recordingId: String(v.musicId), releaseId: String(v.albumId),
      title: v.musicName, album: v.album, durationSeconds: v.duration / 1000,
      artists: Array.isArray(v.artist) ? v.artist.map(a => Array.isArray(a) ? { name: a[0], id: String(a[1]) } : null) : [] })
  } catch { return undefined }
}
