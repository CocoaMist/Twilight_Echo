import type { Track } from '../types/music.ts'

export const MAX_PLAYLIST_IMPORT_BYTES = 8 * 1024 * 1024
export const MAX_PLAYLIST_IMPORT_ENTRIES = 20_000

export type PlaylistFileFormat = 'm3u' | 'm3u8' | 'pls'

export interface PlaylistImportEntry {
  path: string
  title?: string
  durationSeconds?: number
}

export interface PlaylistImportResult {
  format: PlaylistFileFormat
  entries: PlaylistImportEntry[]
  warnings: string[]
}

export interface PlaylistRelocation {
  trackId: string
  fromPath: string
  toTrack: Track
}

export interface PlaylistRelocationResult {
  relocations: PlaylistRelocation[]
  unresolvedTrackIds: string[]
  ambiguousTrackIds: string[]
}

function cleanLine(value: string): string {
  return value.replace(/^\uFEFF/, '').trim()
}

function normalizePath(value: string): string {
  return value.trim().replace(/\//g, '\\').replace(/\\+/g, '\\').toLocaleLowerCase('en-US')
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLocaleLowerCase('en-US')
}

function validateText(text: string): void {
  if (new TextEncoder().encode(text).byteLength > MAX_PLAYLIST_IMPORT_BYTES) {
    throw new Error('歌单文件超过 8 MiB 导入上限')
  }
}

function pushEntry(
  entries: PlaylistImportEntry[],
  warnings: string[],
  entry: PlaylistImportEntry
): void {
  if (!entry.path || entry.path.includes('\0')) {
    warnings.push('已跳过空路径或包含 NUL 字符的条目')
    return
  }
  if (entries.length >= MAX_PLAYLIST_IMPORT_ENTRIES) {
    throw new Error(`歌单条目超过 ${MAX_PLAYLIST_IMPORT_ENTRIES.toLocaleString()} 首上限`)
  }
  entries.push(entry)
}

function parseExtInf(value: string): Pick<PlaylistImportEntry, 'title' | 'durationSeconds'> {
  const match = /^#EXTINF:([+-]?\d+(?:\.\d+)?)\s*,\s*(.*)$/i.exec(value)
  if (!match) return {}
  const seconds = Number(match[1])
  return {
    ...(Number.isFinite(seconds) && seconds >= 0 ? { durationSeconds: seconds } : {}),
    ...(match[2] ? { title: match[2].trim() } : {})
  }
}

function parseM3u(text: string, format: 'm3u' | 'm3u8'): PlaylistImportResult {
  const entries: PlaylistImportEntry[] = []
  const warnings: string[] = []
  let pending: Pick<PlaylistImportEntry, 'title' | 'durationSeconds'> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = cleanLine(raw)
    if (!line) continue
    if (/^#EXTINF:/i.test(line)) {
      pending = parseExtInf(line)
      continue
    }
    if (line.startsWith('#')) continue
    pushEntry(entries, warnings, { path: line, ...pending })
    pending = {}
  }
  return { format, entries, warnings }
}

function parsePls(text: string): PlaylistImportResult {
  const fields = new Map<number, { path?: string; title?: string; durationSeconds?: number }>()
  const warnings: string[] = []
  let inPlaylistSection = false
  for (const raw of text.split(/\r?\n/)) {
    const line = cleanLine(raw)
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    if (/^\[playlist\]$/i.test(line)) {
      inPlaylistSection = true
      continue
    }
    if (!inPlaylistSection) continue
    const equals = line.indexOf('=')
    if (equals <= 0) continue
    const key = line.slice(0, equals).trim()
    const value = line.slice(equals + 1).trim()
    const match = /^(file|title|length)(\d+)$/i.exec(key)
    if (!match) continue
    const index = Number(match[2])
    if (!Number.isSafeInteger(index) || index < 1 || index > MAX_PLAYLIST_IMPORT_ENTRIES) {
      warnings.push(`已跳过非法 PLS 条目序号: ${key}`)
      continue
    }
    const current = fields.get(index) ?? {}
    if (match[1].toLocaleLowerCase() === 'file') current.path = value
    if (match[1].toLocaleLowerCase() === 'title') current.title = value
    if (match[1].toLocaleLowerCase() === 'length') {
      const duration = Number(value)
      if (Number.isFinite(duration) && duration >= 0) current.durationSeconds = duration
    }
    fields.set(index, current)
  }
  const entries: PlaylistImportEntry[] = []
  for (const [, entry] of [...fields.entries()].sort(([left], [right]) => left - right)) {
    if (!entry.path) {
      warnings.push('已跳过没有 FileN 的 PLS 条目')
      continue
    }
    pushEntry(entries, warnings, entry as PlaylistImportEntry)
  }
  return { format: 'pls', entries, warnings }
}

export function parsePlaylistDocument(text: string, fileName: string): PlaylistImportResult {
  validateText(text)
  const extension = fileName.trim().split('.').pop()?.toLocaleLowerCase('en-US')
  if (extension === 'pls') return parsePls(text)
  if (extension === 'm3u8') return parseM3u(text, 'm3u8')
  if (extension === 'm3u') return parseM3u(text, 'm3u')
  throw new Error('仅支持 M3U、M3U8 和 PLS 歌单文件')
}

function toPortablePath(path: string): string {
  return path.replace(/\\/g, '/')
}

export function exportPlaylistDocument(
  tracks: readonly Track[],
  format: PlaylistFileFormat
): string {
  const writer = createPlaylistDocumentWriter(format)
  for (const track of tracks) writer.append(track)
  return writer.finish()
}

/** Keep export text, not complete resolved Track arrays, across database pages. */
export function createPlaylistDocumentWriter(format: PlaylistFileFormat) {
  const rows = [format === 'pls' ? '[playlist]' : '#EXTM3U']
  let count = 0
  return {
    append(track: Track): void {
      const number = ++count,
        title = track.artist ? `${track.artist} - ${track.title}` : track.title,
        duration = Math.max(0, Math.round(track.duration || 0))
      if (format === 'pls')
        rows.push(
          `File${number}=${toPortablePath(track.filePath)}`,
          `Title${number}=${title}`,
          `Length${number}=${duration}`
        )
      else rows.push(`#EXTINF:${duration},${title}`, toPortablePath(track.filePath))
    },
    finish(): string {
      const tail = format === 'pls' ? [`NumberOfEntries=${count}`, 'Version=2'] : []
      return `${[...rows, ...tail].join('\r\n')}\r\n`
    }
  }
}

/** Resolves only unique candidates. Ambiguity is deliberately surfaced for user review. */
export function findPlaylistRelocations(
  missingTracks: readonly Track[],
  candidates: readonly Track[]
): PlaylistRelocationResult {
  const relocations: PlaylistRelocation[] = []
  const unresolvedTrackIds: string[] = []
  const ambiguousTrackIds: string[] = []
  const usedCandidateIds = new Set<string>()
  const byPath = new Map(candidates.map((track) => [normalizePath(track.filePath), track]))

  for (const missing of missingTracks) {
    if (byPath.has(normalizePath(missing.filePath))) continue
    const filename = basename(missing.filePath || missing.fileName)
    const filenameMatches = candidates.filter(
      (candidate) =>
        !usedCandidateIds.has(candidate.id) && basename(candidate.filePath) === filename
    )
    const metadataMatches = candidates.filter((candidate) => {
      if (usedCandidateIds.has(candidate.id)) return false
      return (
        candidate.title.trim().toLocaleLowerCase() === missing.title.trim().toLocaleLowerCase() &&
        candidate.artist.trim().toLocaleLowerCase() === missing.artist.trim().toLocaleLowerCase() &&
        Math.abs((candidate.duration || 0) - (missing.duration || 0)) <= 2
      )
    })
    const matches = filenameMatches.length === 1 ? filenameMatches : metadataMatches
    if (matches.length === 1) {
      usedCandidateIds.add(matches[0].id)
      relocations.push({ trackId: missing.id, fromPath: missing.filePath, toTrack: matches[0] })
    } else if (matches.length > 1 || filenameMatches.length > 1) {
      ambiguousTrackIds.push(missing.id)
    } else {
      unresolvedTrackIds.push(missing.id)
    }
  }
  return { relocations, unresolvedTrackIds, ambiguousTrackIds }
}

export function reorderStableIds(
  ids: readonly string[],
  movingIds: Iterable<string>,
  targetIndex: number
): string[] {
  const moving = new Set(movingIds)
  const picked = ids.filter((id) => moving.has(id))
  if (picked.length === 0) return [...ids]
  const rest = ids.filter((id) => !moving.has(id))
  const beforeMoving = ids.slice(0, Math.max(0, targetIndex)).filter((id) => moving.has(id)).length
  const insertion = Math.max(0, Math.min(rest.length, targetIndex - beforeMoving))
  return [...rest.slice(0, insertion), ...picked, ...rest.slice(insertion)]
}
