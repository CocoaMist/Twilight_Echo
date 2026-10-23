/**
 * Pure M3U / PLS playlist importers for internet radio station lists.
 */

export interface ImportedRadioEntry {
  name: string
  streamUrl: string
}

const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024
const MAX_ENTRIES = 500

export function parseM3uPlaylist(text: string): ImportedRadioEntry[] {
  assertPlaylistText(text)
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const entries: ImportedRadioEntry[] = []
  let pendingName = ''

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      if (/^#EXTINF:/i.test(line)) {
        const comma = line.indexOf(',')
        pendingName = comma >= 0 ? line.slice(comma + 1).trim() : ''
      }
      continue
    }
    if (!isStreamUrl(line)) {
      pendingName = ''
      continue
    }
    entries.push({
      name: pendingName || nameFromUrl(line),
      streamUrl: line
    })
    pendingName = ''
    if (entries.length >= MAX_ENTRIES) break
  }
  return entries
}

export function parsePlsPlaylist(text: string): ImportedRadioEntry[] {
  assertPlaylistText(text)
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const fileMap = new Map<number, string>()
  const titleMap = new Map<number, string>()

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('[') || line.startsWith(';') || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    const fileMatch = /^File(\d+)$/i.exec(key)
    if (fileMatch) {
      const index = Number(fileMatch[1])
      if (Number.isSafeInteger(index) && isStreamUrl(value)) fileMap.set(index, value)
      continue
    }
    const titleMatch = /^Title(\d+)$/i.exec(key)
    if (titleMatch) {
      const index = Number(titleMatch[1])
      if (Number.isSafeInteger(index) && value) titleMap.set(index, value)
    }
  }

  const indexes = Array.from(fileMap.keys()).sort((a, b) => a - b)
  const entries: ImportedRadioEntry[] = []
  for (const index of indexes) {
    const streamUrl = fileMap.get(index)
    if (!streamUrl) continue
    entries.push({
      name: titleMap.get(index)?.trim() || nameFromUrl(streamUrl),
      streamUrl
    })
    if (entries.length >= MAX_ENTRIES) break
  }
  return entries
}

export function parseRadioPlaylist(text: string, fileNameHint = ''): ImportedRadioEntry[] {
  const hint = fileNameHint.toLowerCase()
  if (hint.endsWith('.pls') || looksLikePls(text)) return parsePlsPlaylist(text)
  return parseM3uPlaylist(text)
}

function looksLikePls(text: string): boolean {
  return /\[playlist\]/i.test(text) || /^File\d+\s*=/im.test(text)
}

function assertPlaylistText(text: string): void {
  if (typeof text !== 'string') throw new Error('Playlist text must be a string')
  if (Buffer.byteLength(text, 'utf8') > MAX_PLAYLIST_BYTES) {
    throw new Error('Playlist text is too large')
  }
}

function isStreamUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username &&
      !parsed.password
    )
  } catch {
    return false
  }
}

function nameFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname || 'Radio'
    const path = parsed.pathname.replace(/\/+$/, '')
    const leaf = path.split('/').filter(Boolean).pop()
    return leaf ? `${host}/${leaf}` : host
  } catch {
    return 'Radio'
  }
}
