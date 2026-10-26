import type { LocalMusicLibraryDocument } from './localLibrary.ts'
import type { LibraryMetadata } from './libraryDatabase.ts'
import type { Playlist } from './playlists.ts'
import { validMusicFocusQuery } from './musicFocus.ts'
import { normalizeMusicTagName } from './musicTags.ts'
import { normalizeMusicFocusName } from './musicFocus.ts'
import { parsePersonalMusicArtwork } from './personalMusicArtwork.ts'
import { validMetadataProvider } from './musicMetadata.ts'

export type MusicBackupScalar = string | number | null
export type MusicBackupRecord = Record<string, MusicBackupScalar>
/** Portable logical records. Names and columns are a fixed contract, not SQL input. */
export const MUSIC_BACKUP_RECORDS = {
  entities: ['id', 'kind', 'title', 'artist', 'identity'],
  sourceAliases: ['namespace', 'key', 'entity_id'],
  sources: ['id', 'source_key', 'provider', 'track_id', 'recording_id', 'release_id', 'album_key'],
  identities: ['id', 'provider', 'kind', 'external_id', 'name'],
  identityRefs: ['provider', 'kind', 'id_type', 'value', 'target_id'],
  explorationRefs: ['provider', 'kind', 'id_type', 'value', 'entity_id'],
  subjects: ['id', 'revision', 'target_id', 'mbid', 'state'],
  links: ['id', 'entity_id', 'kind', 'revision', 'target_id', 'state'],
  suppressions: ['entity_id', 'kind', 'provider', 'id_type', 'value', 'reason', 'changed_at'],
  identityHistory: ['seq', 'link_id', 'candidate_id', 'state', 'target_id', 'evidence', 'changed_at', 'event_id'],
  linkHistory: ['seq', 'entity_id', 'target_id', 'mbid', 'state', 'evidence', 'changed_at', 'event_id'],
  overrides: ['entity_id', 'payload'],
  sourcePreferences: ['entity_id', 'provider', 'updated_at'],
  artworkOverrides: ['entity_id', 'payload'],
  ratings: ['profile_id', 'target_key', 'kind', 'steps', 'revision', 'updated_at'],
  ratingHistory: ['seq', 'profile_id', 'target_key', 'kind', 'steps', 'revision', 'updated_at', 'reason', 'event_id'],
  preferences: ['profile_id', 'target_key', 'kind', 'state', 'revision', 'updated_at'],
  preferenceHistory: ['seq', 'profile_id', 'target_key', 'kind', 'state', 'revision', 'updated_at', 'reason', 'event_id'],
  favorites: ['id', 'revision', 'saved_at', 'payload', 'legacy_revision', 'default_id', 'migration_receipt'],
  preferenceRestores: ['id', 'revision'],
  tags: ['profile_id', 'id', 'name', 'normalized_name', 'name_revision', 'members_revision', 'updated_at'],
  tagMembers: ['profile_id', 'tag_id', 'entity_id'],
  focus: ['profile_id', 'id', 'name', 'normalized_name', 'query', 'name_revision', 'query_revision', 'updated_at'],
  genres: ['id', 'name', 'name_en', 'parent_id', 'dictionary_version', 'user_modified'],
  genreAliases: ['provider', 'normalized', 'value', 'genre_id', 'ignored', 'normalization_version', 'user_modified'],
  genreOverrides: ['target_kind', 'target_id', 'genre_ids'],
  genreImportOverrides: ['target_kind', 'target_id', 'import_key', 'genre_ids'],
  genreImportNodes: ['provider', 'original_id', 'genre_id'],
  genreAliasBridges: ['import_provider', 'provider', 'normalized', 'value', 'genre_id', 'ignored'],
  performances: ['id', 'owner_id', 'provider', 'set_key', 'revision', 'truncated', 'origin'],
  performanceRelations: ['id', 'set_id', 'from_id', 'to_id', 'kind', 'position', 'payload'],
  legacyBindings: ['plugin_id', 'legacy_id', 'entity_id', 'evidence'],
  legacyDocuments: ['plugin_id', 'source_revision', 'revision', 'input_revision', 'base'],
  legacyAlbums: ['plugin_id', 'legacy_id', 'payload', 'disposition'],
  legacyInputs: ['plugin_id', 'legacy_id', 'revision'],
  legacyHistory: ['plugin_id', 'revision', 'payload', 'bindings', 'event_id'],
  membershipAdded: ['source_key', 'added_at'],
  historyWatermarks: ['kind', 'seq']
} as const
export type MusicBackupRecordKind = keyof typeof MUSIC_BACKUP_RECORDS
/** Additive personal authorities are absent in older music v1 documents. */
type AddedMusicBackupRecordKind = 'sourcePreferences' | 'artworkOverrides'
export type MusicBackupRecords = Record<Exclude<MusicBackupRecordKind, AddedMusicBackupRecordKind>, MusicBackupRecord[]> &
  Partial<Record<AddedMusicBackupRecordKind, MusicBackupRecord[]>>
export type CompleteMusicBackupRecords = Record<MusicBackupRecordKind, MusicBackupRecord[]>
const addedMusicBackupRecordKinds = new Set<string>(['sourcePreferences', 'artworkOverrides'])
export interface MusicPersonalBackupDocument {
  version: 1
  origin: string
  dictionaryVersion: number
  records: MusicBackupRecords
}
export interface MusicPersonalBackupRevision {
  library: number; catalog: number; metadata: number; identity: number; ratings: number
  preferences: number; playlists: number; tags: number; focus: number; genres: number; exploration: number
}
export interface MusicPersonalBackupMapping {
  kind: 'entity' | 'identity'; incomingId: string; targetId: string
  method: 'same-origin' | 'previous-import' | 'source' | 'external-reference' | 'offline-anchor'
}
export interface MusicPersonalBackupPreview {
  /** Comparable portable logical-record totals, including anchors and history, excluding automatic caches. */
  incoming: number; current: number; conflicts: number; missingSources: number; mappedEntities: number
  unbound: number; referenceMapping: number; dependencies: string[]
  revision: MusicPersonalBackupRevision
  mappings: MusicPersonalBackupMapping[]
  mappingCount: number
  mappingsTruncated: boolean
  referenceConflicts: Array<{ incomingId: string; kind: string; title: string; targetIds: string[] }>
}
export interface MusicPersonalBackupRestoreBundle {
  restoreId: string
  conflict: 'keep-local' | 'use-backup'
  expectedRevision: MusicPersonalBackupRevision
  music?: MusicPersonalBackupDocument
  library?: LocalMusicLibraryDocument
  playlists?: Playlist[]
  playlistsExpectedRevision?: number
  now?: number
}
export interface MusicPersonalBackupRestoreResult {
  revision: MusicPersonalBackupRevision
  metadata: LibraryMetadata
}
export interface MusicPersonalBackupDatabaseApi {
  musicBackupRevision(): Promise<MusicPersonalBackupRevision>
  musicBackupExport(maxBytes: number): Promise<MusicPersonalBackupDocument>
  musicBackupPreview(data?: MusicPersonalBackupDocument, conflict?: 'keep-local' | 'use-backup'): Promise<MusicPersonalBackupPreview>
  musicBackupRestore(bundle: MusicPersonalBackupRestoreBundle): Promise<MusicPersonalBackupRestoreResult>
}
export const MUSIC_BACKUP_MAX_RECORDS = 1_000_000
export const MUSIC_BACKUP_MAX_BYTES = 180 * 1024 * 1024
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const uint = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const kinds = ['recording', 'release', 'album_project', 'artist', 'work', 'performance']
const histories = ['ratingHistory', 'preferenceHistory', 'identityHistory', 'linkHistory']
const numberColumns = new Set(['revision', 'source_revision', 'input_revision', 'updated_at', 'changed_at', 'seq', 'name_revision', 'members_revision', 'query_revision', 'dictionary_version', 'user_modified', 'ignored', 'normalization_version', 'position', 'truncated', 'legacy_revision'])
const jsonFields = new Set(['payload', 'evidence', 'query', 'genre_ids', 'migration_receipt', 'bindings', 'base'])
const unsafeKey = /^(cookie|cookies|password|authorization|accessToken|refreshToken|secret|apiKey|headers|credentials|privateKey|streamUrl|providerContext|artworkContext)$/i
/** Drop session material from personal snapshots and historical receipts. */
export function musicBackupJsonReplacer(key: string, value: unknown): unknown {
  return unsafeKey.test(key) || ['coverSource', 'coverSmallSource'].includes(key) ||
    (['cover', 'coverSmall'].includes(key) && typeof value === 'string' && !value.startsWith('data:image/')) ? undefined : value
}
function safeJson(v: unknown, depth = 0): boolean {
  if (depth > 40) return false
  if (Array.isArray(v)) return v.every(x => safeJson(x, depth + 1))
  if (record(v)) return Object.entries(v).every(([k, x]) => musicBackupJsonReplacer(k, x) !== undefined && safeJson(x, depth + 1))
  return v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
}
export function emptyMusicBackupRecords(): CompleteMusicBackupRecords {
  return Object.fromEntries(Object.keys(MUSIC_BACKUP_RECORDS).map(k => [k, []])) as unknown as CompleteMusicBackupRecords
}
export function validMusicPersonalBackupRevision(v: unknown): v is MusicPersonalBackupRevision {
  return record(v) && Object.keys(v).length === 11 && ['library', 'catalog', 'metadata', 'identity', 'ratings', 'preferences', 'playlists', 'tags', 'focus', 'genres', 'exploration'].every(k => uint(v[k]))
}
/** All foreign references are checked before a restore can publish any row. */
export function validateMusicPersonalBackup(value: unknown): value is MusicPersonalBackupDocument {
  if (!record(value) || Object.keys(value).some(k => !['version', 'origin', 'dictionaryVersion', 'records'].includes(k)) || value.version !== 1 ||
    typeof value.origin !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(value.origin) || !uint(value.dictionaryVersion) || value.dictionaryVersion < 1 || !record(value.records) ||
    Object.keys(value.records).some(k => !Object.hasOwn(MUSIC_BACKUP_RECORDS, k))) return false
  let total = 0
  for (const [name, columns] of Object.entries(MUSIC_BACKUP_RECORDS)) {
    const rows = Object.hasOwn(value.records, name) ? value.records[name] : (addedMusicBackupRecordKinds.has(name) ? [] : undefined)
    if (!Array.isArray(rows) || (total += rows.length) > MUSIC_BACKUP_MAX_RECORDS) return false
    for (const row of rows) {
      if (!record(row) || Object.keys(row).length !== columns.length || !columns.every(k => k in row) ||
        Object.values(row).some(v => v !== null && typeof v !== 'string' && !uint(v)) ||
        Object.entries(row).some(([k, v]) => typeof v === 'string' && (v.includes('\0') || v.length > (jsonFields.has(k) ? 8 * 1024 * 1024 : 32768)))) return false
      for (const k of columns) {
        if (jsonFields.has(k)) {
          if (typeof row[k] !== 'string') return false
          try { if (!safeJson(JSON.parse(row[k] as string))) return false } catch { return false }
        }
      }
      if ('profile_id' in row && row.profile_id !== 'default') return false
      for (const [column, v] of Object.entries(row)) {
        if (numberColumns.has(column) && !uint(v)) return false
        if (!numberColumns.has(column) && column !== 'steps' && !(name === 'favorites' && column === 'id') && v !== null && typeof v !== 'string') return false
        if (v === null && !(name === 'sourcePreferences' && column === 'provider') && !['steps', 'target_id', 'release_id', 'album_key', 'state', 'candidate_id', 'parent_id', 'genre_id'].includes(column)) return false
        if (['id', 'entity_id', 'owner_id', 'from_id', 'to_id', 'link_id', 'set_id', 'tag_id', 'event_id', 'target_key', 'provider', 'id_type', 'source_key', 'plugin_id', 'legacy_id'].includes(column) && !(name === 'favorites' && column === 'id') && !(name === 'sourcePreferences' && column === 'provider' && v === null) && (typeof v !== 'string' || !v)) return false
      }
      if ('kind' in row && name !== 'performanceRelations' && name !== 'historyWatermarks' && !kinds.includes(String(row.kind))) return false
      if (name === 'historyWatermarks' && !histories.includes(String(row.kind))) return false
      if ('target_kind' in row && !['source', 'collection'].includes(String(row.target_kind))) return false
      if (['ratings', 'ratingHistory'].includes(name) && row.steps !== null && (!uint(row.steps) || row.steps < 1 || row.steps > 10)) return false
      if (['preferences', 'preferenceHistory'].includes(name) && !['none', 'favorite', 'ban'].includes(String(row.state))) return false
      if (name === 'links' && !['unresolved', 'confirmed', 'detached'].includes(String(row.state))) return false
      if (name === 'entities' && !['source', 'manual'].includes(String(row.identity))) return false
      if (['ratings', 'ratingHistory'].includes(name) && !['recording', 'release'].includes(String(row.kind))) return false
      if (['preferences', 'preferenceHistory'].includes(name) && !['recording', 'release', 'artist', 'work'].includes(String(row.kind))) return false
      if (name === 'favorites' && row.id !== 1) return false
      if (name === 'favorites') {
        const views = JSON.parse(String(row.payload))
        if (!Array.isArray(views) || views.length !== 1 || !record(views[0]) || views[0].id !== row.default_id || views[0].isDefault !== true || typeof views[0].name !== 'string' ||
          !Array.isArray(views[0].trackIds) || views[0].trackIds.some(id => typeof id !== 'string' || !id)) return false
      }
      if (name === 'tags' && (typeof row.name !== 'string' || row.normalized_name !== normalizeMusicTagName(row.name))) return false
      if (name === 'focus' && (typeof row.name !== 'string' || row.normalized_name !== normalizeMusicFocusName(row.name))) return false
      if (name === 'membershipAdded' && !(row.added_at === 'unknown' || (typeof row.added_at === 'string' && /^\d+$/.test(row.added_at) && uint(Number(row.added_at))))) return false
      if (name === 'genres' && (!['0', '1'].includes(String(row.user_modified)) || Number(row.dictionary_version) < 1)) return false
      if (name === 'genreAliases' && (!['0', '1'].includes(String(row.user_modified)) || !['0', '1'].includes(String(row.ignored)) || Number(row.normalization_version) < 1)) return false
      if (name === 'performances' && (row.origin !== 'manual' || row.provider !== 'twilight' || row.set_key !== 'manual-performance')) return false
      if (name === 'focus' && !validMusicFocusQuery(JSON.parse(String(row.query)))) return false
      if ('event_id' in row) { try { const id = JSON.parse(String(row.event_id)); if (!Array.isArray(id) || id.length !== 3 || typeof id[0] !== 'string' || id[1] !== name || !uint(id[2])) return false } catch { return false } }
      if (name === 'sourceAliases') {
        if (!['source.recording', 'source.release', 'source.artist'].includes(String(row.namespace))) return false
        try { const key = JSON.parse(String(row.key)); if (!Array.isArray(key) || key.length < 2 || key.length > 4) return false } catch { return false }
      }
      if (name === 'overrides') {
        const p = JSON.parse(String(row.payload))
        if (!record(p) || !['value', 'clear'].includes(String(p.mode)) || typeof p.value !== 'string' || !['zh-Hans', 'zh-Hant', 'en'].includes(String(p.language))) return false
      }
      if (name === 'sourcePreferences' && row.provider !== null && !validMetadataProvider(row.provider)) return false
      if (name === 'artworkOverrides') {
        const p = JSON.parse(String(row.payload))
        if (!record(p) || !['value', 'clear'].includes(String(p.mode)) || !uint(p.updatedAt) ||
          Object.keys(p).some(k => !['mode', 'dataUrl', 'updatedAt'].includes(k)) ||
          (p.mode === 'value' ? !parsePersonalMusicArtwork(p.dataUrl) : p.dataUrl !== undefined)) return false
      }
    }
  }
  const r = value.records as MusicBackupRecords
  const ids = (rows: MusicBackupRecord[], field = 'id') => new Set(rows.map(r => String(r[field])))
  for (const name of histories as Array<'ratingHistory' | 'preferenceHistory' | 'identityHistory' | 'linkHistory'>) if (ids(r[name], 'seq').size !== r[name].length || ids(r[name], 'event_id').size !== r[name].length) return false
  const e = ids(r.entities), i = ids(r.identities), l = ids(r.links), t = ids(r.tags), g = ids(r.genres), p = ids(r.performances)
  const entityKinds = new Map(r.entities.map(row => [String(row.id), row.kind]))
  for (const rows of [r.sourcePreferences ?? [], r.artworkOverrides ?? []]) if (ids(rows, 'entity_id').size !== rows.length) return false
  if ((r.artworkOverrides ?? []).some(row => !['artist', 'release', 'album_project'].includes(String(entityKinds.get(String(row.entity_id)))))) return false
  const identityKinds = new Map(r.identities.map(row => [String(row.id), row.kind])), linkGroups = new Set(r.links.map(row => JSON.stringify([row.entity_id, row.kind])))
  if (!r.suppressions.every(row => linkGroups.has(JSON.stringify([row.entity_id, row.kind])))) return false
  if (!r.links.every(row => row.state !== 'confirmed' || row.target_id !== null)) return false
  for (const alias of r.sourceAliases) if (entityKinds.get(String(alias.entity_id)) !== String(alias.namespace).slice(7)) return false
  const legacy = ids(r.legacyDocuments, 'plugin_id')
  if (![...r.legacyAlbums, ...r.legacyInputs, ...r.legacyHistory, ...r.legacyBindings].every(row => legacy.has(String(row.plugin_id)))) return false
  if ([r.entities, r.identities, r.links, r.tags, r.focus, r.genres, r.performances].some(rows => ids(rows).size !== rows.length)) return false
  const all = (rows: MusicBackupRecord[], field: string, set: Set<string>, nullable = false) => rows.every(row => (nullable && row[field] === null) || set.has(String(row[field])))
  if (!all(r.sourceAliases, 'entity_id', e) || !all(r.sources, 'recording_id', e) || !all(r.sources, 'release_id', e, true) || !all(r.identityRefs, 'target_id', i) ||
    !all(r.explorationRefs, 'entity_id', e) || !all(r.subjects, 'id', e) || !all(r.subjects, 'target_id', i, true) ||
    !all(r.links, 'entity_id', e) || !all(r.links, 'target_id', i, true) || !all(r.suppressions, 'entity_id', e) ||
    !all(r.identityHistory, 'link_id', l) || !all(r.identityHistory, 'target_id', i, true) || !all(r.linkHistory, 'entity_id', e) ||
    !all(r.linkHistory, 'target_id', i, true) || !all(r.overrides, 'entity_id', e) || !all(r.sourcePreferences ?? [], 'entity_id', e) ||
    !all(r.artworkOverrides ?? [], 'entity_id', e) || !all(r.tagMembers, 'entity_id', e) ||
    !all(r.tagMembers, 'tag_id', t) || !all(r.genres, 'parent_id', g, true) || !all(r.genreAliases, 'genre_id', g, true) ||
    !all(r.genreImportNodes, 'genre_id', g, true) || !all(r.genreAliasBridges, 'genre_id', g, true) ||
    !all(r.performances, 'owner_id', e) || !all(r.performanceRelations, 'set_id', p) || !all(r.performanceRelations, 'from_id', e) ||
    !all(r.performanceRelations, 'to_id', e) || !all(r.legacyBindings, 'entity_id', e)) return false
  for (const rows of [r.ratings, r.ratingHistory, r.preferences, r.preferenceHistory]) for (const row of rows) {
    try {
      const key = JSON.parse(String(row.target_key))
      if (!Array.isArray(key) || key.length !== 3 || !['entity', 'identity'].includes(key[0]) || key[1] !== row.kind || !(key[0] === 'entity' ? e : i).has(key[2]) ||
        (key[0] === 'entity' ? entityKinds.get(key[2]) : identityKinds.get(key[2])) !== key[1]) return false
    } catch { return false }
  }
  for (const row of r.performanceRelations) {
    if (!['work_performance', 'performance_recording'].includes(String(row.kind))) return false
    const from = entityKinds.get(String(row.from_id)), to = entityKinds.get(String(row.to_id))
    if (row.kind === 'work_performance' ? from !== 'work' || to !== 'performance' : from !== 'performance' || to !== 'recording') return false
    if (JSON.stringify(JSON.parse(String(row.payload))) !== '{"attribution":null}') return false
  }
  for (const row of [...r.genreOverrides, ...r.genreImportOverrides]) {
    const v = JSON.parse(String(row.genre_ids))
    if (!Array.isArray(v) || v.some(id => typeof id !== 'string' || !g.has(id))) return false
  }
  // A graph cycle is not a valid user hierarchy, even if SQLite would accept the FKs.
  const parents = new Map(r.genres.map(row => [String(row.id), row.parent_id]))
  const checked = new Set<string>()
  for (const id of g) { const seen = new Set<string>(); let next: MusicBackupScalar | undefined = id
    while (typeof next === 'string' && !checked.has(next)) { if (seen.has(next)) return false; seen.add(next); next = parents.get(next) }
    for (const visited of seen) checked.add(visited)
  }
  return true
}

/** Remap only declared source identities and path-bearing receipt/snapshot fields. */
export function remapMusicPersonalBackupPaths(document: MusicPersonalBackupDocument, mappings: Array<{ from: string; to: string }>): MusicPersonalBackupDocument {
  const path = (v: string): string => {
    let value = v.replace(/\\/g, '/')
    for (const m of [...mappings].sort((a, b) => b.from.length - a.from.length)) {
      const from = m.from.replace(/\\/g, '/').replace(/\/+$/, ''), prefix = value.startsWith('local:') ? 'local:' : '', rest = value.slice(prefix.length)
      const windows = /^[a-z]:/i.test(from) || from.startsWith('//'), compared = windows ? rest.toLowerCase() : rest, start = windows ? from.toLowerCase() : from
      if (compared === start || compared.startsWith(start + '/')) { value = prefix + m.to.replace(/\\/g, '/').replace(/\/+$/, '') + rest.slice(from.length); break }
    }
    return value
  }
  const collection = (value: string): string => {
    if (!value.startsWith('dir:')) return value
    const separator = value.indexOf('\u001f'), directory = value.slice(4, separator < 0 ? undefined : separator), mapped = path(directory)
    return 'dir:' + mapped.replace(/\//g, '\\').toLocaleLowerCase() + (separator < 0 ? '' : value.slice(separator))
  }
  const sourceIdentity = (value: string): string => {
    try {
      const key = JSON.parse(value) as unknown[]
      if (!Array.isArray(key)) return value
      if (key[0] === 'local' && typeof key[1] === 'string') { const mapped = path(key[1]); key[1] = /^[a-z]:\//i.test(mapped) ? mapped.toLowerCase() : mapped }
      else if (key[0] === 'album' && key[1] === 'local' && typeof key[2] === 'string') key[2] = collection(key[2])
      else if (key[1] === 'track' && typeof key[2] === 'string') key[2] = sourceIdentity(key[2])
      return JSON.stringify(key)
    } catch { return value }
  }
  const walk = (v: unknown, field = ''): unknown => {
    if (Array.isArray(v)) return v.map(x => walk(x, field))
    if (record(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'target_id' && v.target_kind === 'collection' && typeof x === 'string' ? collection(x) : walk(x, k)]))
    if (typeof v !== 'string') return v
    if (['source_key', 'album_key', 'key'].includes(field)) return sourceIdentity(v)
    if (jsonFields.has(field)) return JSON.stringify(walk(JSON.parse(v)))
    return field === 'collection_id' || field === 'collectionId' ? collection(v) : ['filePath', 'trackKey', 'sources', 'preferredSource', 'folder'].includes(field) ? path(v) : v
  }
  return walk(document) as MusicPersonalBackupDocument
}
