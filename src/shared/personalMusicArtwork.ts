/** User-owned bitmap data. It has no external identity, cache grant or provider licence. */
export interface PersonalMusicArtwork {
  dataUrl: string
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  bytes: number
  width: number
  height: number
}

export const PERSONAL_MUSIC_ARTWORK_MAX_BYTES = 2 * 1024 * 1024
const maxDimension = 8192
const maxPixels = 32 * 1024 * 1024

/** Shared public/DB/backup boundary: canonical base64, actual bitmap header and bounded dimensions. */
export function parsePersonalMusicArtwork(value: unknown): PersonalMusicArtwork | null {
  if (typeof value !== 'string' || value.length > Math.ceil(PERSONAL_MUSIC_ARTWORK_MAX_BYTES / 3) * 4 + 32)
    return null
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match || match[2].length % 4) return null
  let raw: string
  try { raw = atob(match[2]) } catch { return null }
  if (!raw.length || raw.length > PERSONAL_MUSIC_ARTWORK_MAX_BYTES || btoa(raw) !== match[2]) return null
  const b = (i: number) => raw.charCodeAt(i)
  const u16 = (i: number) => b(i) * 256 + b(i + 1)
  const u32 = (i: number) => b(i) * 0x1000000 + b(i + 1) * 65536 + b(i + 2) * 256 + b(i + 3)
  const le24 = (i: number) => b(i) + b(i + 1) * 256 + b(i + 2) * 65536
  const le32 = (i: number) => le24(i) + b(i + 3) * 0x1000000
  let width = 0, height = 0
  if (match[1] === 'image/png') {
    if (raw.length < 45 || raw.slice(0, 8) !== '\x89PNG\r\n\x1a\n' || u32(8) !== 13 || raw.slice(12, 16) !== 'IHDR') return null
    width = u32(16); height = u32(20)
    // A complete PNG ends at IEND; do not persist a truncated file selected by MIME alone.
    let offset = 8, complete = false, pixels = false
    while (offset + 12 <= raw.length) {
      const length = u32(offset), type = raw.slice(offset + 4, offset + 8)
      if (offset + 12 + length > raw.length) return null
      if (type === 'acTL') return null
      if (type === 'IDAT' && length > 0) pixels = true
      offset += 12 + length
      if (type === 'IEND') { complete = length === 0 && offset === raw.length; break }
    }
    if (!complete || !pixels) return null
  } else if (match[1] === 'image/jpeg') {
    if (raw.length < 12 || b(0) !== 255 || b(1) !== 216 || b(raw.length - 2) !== 255 || b(raw.length - 1) !== 217) return null
    let offset = 2, pixels = false
    while (offset + 4 < raw.length) {
      if (b(offset++) !== 255) return null
      while (b(offset) === 255) offset++
      const marker = b(offset++)
      if (marker === 218) {
        const length = u16(offset)
        pixels = length >= 6 && offset + length < raw.length - 2
        break
      }
      if (marker === 217) break
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue
      const length = u16(offset)
      if (length < 2 || offset + length > raw.length) return null
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8 || width || height) return null
        height = u16(offset + 3); width = u16(offset + 5)
      }
      offset += length
    }
    if (!pixels) return null
  } else {
    if (raw.length < 30 || raw.slice(0, 4) !== 'RIFF' || le32(4) + 8 !== raw.length || raw.slice(8, 12) !== 'WEBP') return null
    let offset = 12, canvasWidth = 0, canvasHeight = 0
    while (offset + 8 <= raw.length) {
      const type = raw.slice(offset, offset + 4), length = le32(offset + 4), data = offset + 8
      if (data + length + length % 2 > raw.length) return null
      if (type === 'VP8X') {
        if (length !== 10 || (b(data) & 2)) return null
        canvasWidth = le24(data + 4) + 1; canvasHeight = le24(data + 7) + 1
      } else if (type === 'VP8L' && length > 5 && b(data) === 47) {
        if (width || height) return null
        width = 1 + b(data + 1) + ((b(data + 2) & 63) << 8)
        height = 1 + (b(data + 2) >> 6) + (b(data + 3) << 2) + ((b(data + 4) & 15) << 10)
      } else if (type === 'VP8 ' && length > 10 && raw.slice(data + 3, data + 6) === '\x9d\x01\x2a') {
        if (width || height) return null
        width = (b(data + 6) + b(data + 7) * 256) & 16383; height = (b(data + 8) + b(data + 9) * 256) & 16383
      }
      offset = data + length + length % 2
    }
    if (offset !== raw.length || (canvasWidth && (width !== canvasWidth || height !== canvasHeight))) return null
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
    width > maxDimension || height > maxDimension || width * height > maxPixels) return null
  return { dataUrl: value, mime: match[1] as PersonalMusicArtwork['mime'], bytes: raw.length, width, height }
}
