import { containsGb18030FourByteSequence } from './legacyTextEncoding.ts'
/**
 * Lyrics decoding is deliberately kept data-only and fatal so every main-process
 * read site (the lazy .lrc loader, the import dialog, and SACD ISO sibling
 * lyrics) follows identical byte rules instead of silently replacing legacy
 * encodings with U+FFFD.
 */
export type LyricsEncoding = 'utf-8-bom' | 'utf-8' | 'gbk' | 'gb18030'

export class LyricsDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LyricsDecodeError'
  }
}

export const MAX_LYRICS_BYTES = 1024 * 1024

export function decodeLyrics(bytes: Uint8Array): {
  text: string
  encoding: LyricsEncoding
} {
  if (bytes.byteLength === 0) throw new LyricsDecodeError('Lyrics file is empty')
  if (bytes.byteLength > MAX_LYRICS_BYTES) {
    throw new LyricsDecodeError('Lyrics file exceeds the 1 MiB limit')
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: decode(bytes.subarray(3), 'utf-8'), encoding: 'utf-8-bom' }
  }
  try {
    return { text: decode(bytes, 'utf-8'), encoding: 'utf-8' }
  } catch {
    // Node's WHATWG decoder supports both labels. Keep the result explicit: most
    // legacy lyrics files are GBK-encoded Chinese text. Some ICU builds accept
    // GB18030 four-byte sequences through the `gbk` decoder as an extension, so
    // detect the unambiguous four-byte form first and keep the reported encoding
    // truthful rather than labelling every legacy Chinese LRC as GBK.
    const legacyDecoders = containsGb18030FourByteSequence(bytes)
      ? ([['gb18030', 'gb18030']] as const)
      : ([
          ['gbk', 'gbk'],
          ['gb18030', 'gb18030']
        ] as const)
    for (const [label, encoding] of legacyDecoders) {
      try {
        const text = decode(bytes, label)
        if (text.trim()) return { text, encoding }
      } catch {
        // Continue to the next explicitly supported legacy encoding.
      }
    }
    throw new LyricsDecodeError(
      'Unsupported or malformed lyrics encoding (expected UTF-8, GBK, or GB18030)'
    )
  }
}

function decode(bytes: Uint8Array, encoding: string): string {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    throw new LyricsDecodeError(`Invalid ${encoding} lyrics data`)
  }
}
