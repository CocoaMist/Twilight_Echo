import { isQueueWorkspaceDocument } from './queueWorkspace.ts'
import { isLyricsManagementDocument } from './lyricsManagement.ts'
import { isPlaybackBookmarksDocument } from './playbackBookmarks.ts'
import { isRadioStationsDocument } from './radioStations.ts'
import { isPodcastSubscriptionsDocument } from './podcastSubscriptions.ts'
import { isPlaybackSession } from './playbackSession.ts'

export const PERSONAL_BACKUP_LIMIT = 180 * 1024 * 1024
export const PERSONAL_DOMAINS = [
  'library',
  'playlists',
  'queue',
  'playback',
  'lyrics',
  'bookmarks',
  'radio',
  'podcasts',
  'statistics',
  'versions'
] as const
export type PersonalDomain = (typeof PERSONAL_DOMAINS)[number]
export type PersonalData = Partial<Record<PersonalDomain, unknown>>
export interface PersonalBackup {
  format: 'twilight-personal-data'
  version: 1
  createdAt: string
  data: PersonalData
}
export interface PathMapping {
  from: string
  to: string
}
export interface PersonalRestoreOptions {
  conflict: 'keep-local' | 'use-backup'
  mappings: PathMapping[]
  domains: PersonalDomain[]
}
export interface PersonalBackupPreview {
  version: 1
  createdAt: string
  rows: { domain: PersonalDomain; incoming: number; current: number; conflicts: number }[]
  roots: string[]
}
export const PERSONAL_DOMAIN_LABELS: Record<PersonalDomain, string> = {
  library: '曲库索引与排除记录',
  playlists: '歌单与收藏',
  queue: '命名队列与播放历史',
  playback: '当前播放队列与位置',
  lyrics: '歌词编辑与偏移',
  bookmarks: '播放书签',
  radio: '电台收藏',
  podcasts: '播客订阅与进度',
  statistics: '听歌统计',
  versions: '曲目与专辑版本关系'
}
export const PERSONAL_STORAGE_KEYS = {
  statistics: 'twilight-echo:listening-stats:v1',
  versions: 'twilight.music-versions.v1'
} as const
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const records = (v: unknown): v is Record<string, unknown>[] =>
  Array.isArray(v) && v.every(isRecord)
const safeNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0

export function validatePersonalDomain(domain: PersonalDomain, value: unknown): boolean {
  switch (domain) {
    case 'queue':
      return isQueueWorkspaceDocument(value)
    case 'lyrics':
      return isLyricsManagementDocument(value)
    case 'bookmarks':
      return isPlaybackBookmarksDocument(value)
    case 'radio':
      return isRadioStationsDocument(value)
    case 'podcasts':
      return isPodcastSubscriptionsDocument(value)
    case 'playback':
      return (
        value === null ||
        (isPlaybackSession(value) && (value.queue === undefined || records(value.queue)))
      )
    case 'playlists':
      return (
        records(value) &&
        value.length <= 10000 &&
        value.every(
          (p) =>
            typeof p.id === 'string' &&
            typeof p.name === 'string' &&
            Array.isArray(p.trackIds) &&
            p.trackIds.every((id) => typeof id === 'string')
        )
      )
    case 'library':
      return (
        isRecord(value) &&
        value.version === 2 &&
        records(value.tracks) &&
        value.tracks.every((t) => typeof t.id === 'string' && typeof t.filePath === 'string') &&
        Array.isArray(value.folders) &&
        value.folders.every((p) => typeof p === 'string') &&
        records(value.exclusions)
      )
    case 'statistics':
      return (
        isRecord(value) &&
        isRecord(value.days) &&
        isRecord(value.tracks) &&
        Object.values(value.days).every(safeNumber) &&
        Object.values(value.tracks).every(
          (t) =>
            isRecord(t) &&
            typeof t.title === 'string' &&
            typeof t.artist === 'string' &&
            safeNumber(t.seconds) &&
            safeNumber(t.plays)
        )
      )
    case 'versions':
      return validateVersions(value)
  }
}
function validateVersions(value: unknown): boolean {
  if (!isRecord(value) || value.version !== 1) return false
  for (const scope of ['tracks', 'albums']) {
    const d = value[scope]
    if (!isRecord(d) || !records(d.versions) || !records(d.families) || d.versions.length > 20000)
      return false
    const ids = new Set<string>(),
      sources = new Set<string>(),
      families = new Set<string>(),
      assigned = new Set<string>()
    for (const v of d.versions) {
      if (
        typeof v.id !== 'string' ||
        !v.id ||
        ids.has(v.id) ||
        typeof v.label !== 'string' ||
        v.label.length > 100 ||
        !Array.isArray(v.sources) ||
        !v.sources.length
      )
        return false
      ids.add(v.id)
      for (const s of v.sources) {
        if (typeof s !== 'string' || !s || s.length > 8192 || sources.has(s)) return false
        sources.add(s)
      }
      if (v.preferredSource !== null && !v.sources.includes(v.preferredSource)) return false
    }
    if (sources.size > 40000) return false
    for (const f of d.families) {
      if (
        typeof f.id !== 'string' ||
        !f.id ||
        families.has(f.id) ||
        !Array.isArray(f.versions) ||
        f.versions.length < 2
      )
        return false
      families.add(f.id)
      for (const id of f.versions) {
        if (typeof id !== 'string' || !ids.has(id) || assigned.has(id)) return false
        assigned.add(id)
      }
      if (f.preferredVersion !== null && !f.versions.includes(f.preferredVersion)) return false
    }
  }
  return true
}
export function validatePersonalBackup(value: unknown): value is PersonalBackup {
  return (
    isRecord(value) &&
    value.format === 'twilight-personal-data' &&
    value.version === 1 &&
    typeof value.createdAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    isRecord(value.data) &&
    Object.entries(value.data).every(
      ([k, v]) =>
        PERSONAL_DOMAINS.includes(k as PersonalDomain) &&
        validatePersonalDomain(k as PersonalDomain, v)
    )
  )
}

// Only paths and identities derived from paths are remapped. Lyrics, titles and URLs are untouched.
export function remapPersonalPaths(value: unknown, mappings: PathMapping[], field = ''): unknown {
  const remap = (text: string) => {
    const normalized = text.replace(/\\/g, '/')
    for (const m of [...mappings].sort((a, b) => b.from.length - a.from.length)) {
      const from = m.from.replace(/\\/g, '/').replace(/\/+$/, '')
      const prefix = normalized.startsWith('local:') ? 'local:' : ''
      const path = normalized.slice(prefix.length)
      const windowsPath = /^[a-z]:/i.test(from) || from.startsWith('//')
      const pathKey = windowsPath ? path.toLowerCase() : path
      const fromKey = windowsPath ? from.toLowerCase() : from
      if (pathKey === fromKey || pathKey.startsWith(fromKey + '/'))
        return prefix + m.to.replace(/\\/g, '/').replace(/\/+$/, '') + path.slice(from.length)
    }
    return text
  }
  if (typeof value === 'string')
    return [
      'filePath',
      'dir',
      'cueSheetPath',
      'folders',
      'trackKey',
      'sources',
      'preferredSource'
    ].includes(field)
      ? remap(value)
      : value
  if (Array.isArray(value)) return value.map((v) => remapPersonalPaths(v, mappings, field))
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [remap(k), remapPersonalPaths(v, mappings, k)])
    )
  return value
}
function identity(v: unknown): string {
  return isRecord(v)
    ? String(v.id ?? v.feedUrl ?? v.streamUrl ?? v.filePath ?? JSON.stringify(v))
    : JSON.stringify(v)
}
function aliases(v: unknown): string[] {
  return [
    identity(v),
    ...(isRecord(v) && typeof (v.feedUrl ?? v.streamUrl) === 'string'
      ? [`url:${v.feedUrl ?? v.streamUrl}`]
      : [])
  ]
}
function mergeItems(local: unknown[], incoming: unknown[], prefer: boolean): unknown[] {
  const result: unknown[] = []
  const indices = new Map<string, number>()
  function add(value: unknown, replace: boolean) {
    const keys = aliases(value)
    const matches = [...new Set(keys.flatMap((k) => (indices.has(k) ? [indices.get(k)!] : [])))]
    if (matches.length && !replace) return
    const index = matches.length ? Math.min(...matches) : result.length
    for (const match of matches) {
      for (const key of aliases(result[match])) if (indices.get(key) === match) indices.delete(key)
      result[match] = undefined
    }
    result[index] = value
    for (const key of keys) indices.set(key, index)
  }
  for (const value of local) add(value, false)
  for (const value of incoming) add(value, prefer)
  return result.filter((value) => value !== undefined)
}
const collections: Partial<Record<PersonalDomain, string[]>> = {
  library: ['tracks', 'folders', 'exclusions'],
  queue: ['sessions', 'history'],
  bookmarks: ['bookmarks'],
  radio: ['stations'],
  podcasts: ['subscriptions'],
  lyrics: ['tracks'],
  statistics: ['tracks', 'days']
}
export function mergePersonalDomain(
  domain: PersonalDomain,
  local: unknown,
  incoming: unknown,
  conflict: PersonalRestoreOptions['conflict']
): unknown {
  if (local === undefined) return incoming
  const prefer = conflict === 'use-backup'
  if (domain === 'playlists' && Array.isArray(local) && Array.isArray(incoming))
    return mergeItems(local, incoming, prefer)
  // Version graphs and the active queue are indivisible: mixing references breaks identities.
  if (!collections[domain] || !isRecord(local) || !isRecord(incoming))
    return prefer ? incoming : local
  const result = { ...(prefer ? incoming : local) }
  for (const key of collections[domain]!) {
    const a = local[key],
      b = incoming[key]
    if (Array.isArray(a) && Array.isArray(b)) result[key] = mergeItems(a, b, prefer)
    else if (isRecord(a) && isRecord(b)) result[key] = prefer ? { ...a, ...b } : { ...b, ...a }
  }
  return result
}
function entries(domain: PersonalDomain, v: unknown): unknown[] {
  if (v === undefined || v === null) return []
  if (Array.isArray(v)) return v
  if (!isRecord(v)) return [v]
  if (domain === 'versions' || domain === 'playback') return [v]
  return (collections[domain] || []).flatMap((k) =>
    Array.isArray(v[k]) ? v[k] : isRecord(v[k]) ? Object.keys(v[k]).map((id) => ({ id })) : []
  )
}
export function previewPersonalBackup(
  backup: PersonalBackup,
  current: PersonalData
): PersonalBackupPreview {
  return {
    version: backup.version,
    createdAt: backup.createdAt,
    rows: PERSONAL_DOMAINS.filter((d) => d in backup.data).map((domain) => {
      const incoming = entries(domain, backup.data[domain]),
        local = entries(domain, current[domain]),
        keys = new Set(local.flatMap(aliases))
      return {
        domain,
        incoming: incoming.length,
        current: local.length,
        conflicts: ['versions', 'playback'].includes(domain)
          ? Math.min(incoming.length, local.length)
          : incoming.filter((v) => aliases(v).some((key) => keys.has(key))).length
      }
    }),
    roots:
      isRecord(backup.data.library) && Array.isArray(backup.data.library.folders)
        ? (backup.data.library.folders as string[])
        : []
  }
}
