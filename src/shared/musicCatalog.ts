import type { CoreTrackView } from './coreViews.ts'
import type { MusicVersionsDocument } from './musicVersions.ts'
import type { TrackData } from './track.ts'

export type CatalogKind = 'recording' | 'release' | 'artist' | 'album_project'
export const CATALOG_MAX_BATCH_BYTES = 1024 * 1024
export interface CatalogEntity {
  id: string
  kind: CatalogKind
  title: string
  artist: string
  identity: 'source' | 'manual'
  sourceCount: number
}
/** References to existing catalog rows, not a claim of confirmed external identity. */
export type CatalogEntityReference = Pick<CatalogEntity, 'id' | 'kind' | 'title' | 'artist'>
export interface CatalogReferences {
  revision: number
  total: number
  items: CatalogEntityReference[]
}
export interface CatalogTrackReferences extends CatalogReferences {
  sourceId: string
}
export type CatalogReferenceContext =
  | { type: 'track'; provider: string; id: string }
  | { type: 'collection'; collection: 'artists' | 'albums'; id: string }
  | { type: 'native'; provider: string; id: string }
export interface CatalogQuery {
  kind: CatalogKind
  scope?: 'library' | 'all'
  source?: string
  search?: string
  /** Exact source artist title, after trimming. Does not change collection membership. */
  artistName?: string
  revision?: number
  offset?: number
  limit?: number
  /** Exact legacy membership/native-ID lookup. Never a title-search shortcut. */
  context?: CatalogReferenceContext
}
export interface CatalogPage {
  revision: number
  offset: number
  total: number
  items: CatalogEntity[]
}
export interface CatalogSourceQuery {
  entityId: string
  revision?: number
  offset?: number
  limit?: number
}
export interface CatalogSource {
  id: string
  provider: string
  recordingId: string
  releaseId: string | null
  availability: 'indexed' | 'unknown' | 'missing'
  inLibrary: boolean
  preferred: boolean
  /** Display only. Playback uses this source's ID, not a legacy path-shaped Track ID. */
  track: Omit<CoreTrackView, 'id' | 'queueEntryId' | 'subTrack'>
}
export interface CatalogSourcePage {
  revision: number
  offset: number
  total: number
  items: CatalogSource[]
}
export interface CatalogFact {
  sourceId: string
  field: 'title' | 'artist' | 'album'
  value: string
  origin: 'file' | 'provider'
}
export interface CatalogDetail {
  revision: number
  entity: CatalogEntity | null
  facts: CatalogFact[]
  factsTruncated: boolean
}
export interface CatalogStatus {
  revision: number
  localCursor: number
  localHorizon: number
  localPending: boolean
  dirtySources: number
  playlistsRevision: number | null
  versionsRevision: number | null
}
export interface CatalogServiceStatus extends CatalogStatus {
  state: 'idle' | 'running' | 'paused' | 'failed'
  error: string | null
}

/** Private Core -> database transport. Track snapshots never enter public requests. */
export type CatalogSync =
  | { kind: 'begin'; revision: number }
  | { kind: 'append'; id: string; sequence: number; tracks: TrackData[] }
  | { kind: 'commit'; id: string; sequence: number }
  | { kind: 'abort'; id: string }
export interface CatalogSyncResult {
  id: string
  sequence: number
}
export interface CatalogDatabaseApi {
  catalogStatus(): Promise<CatalogStatus>
  catalogAdvance(limit?: number): Promise<CatalogStatus>
  catalogQuery(query: CatalogQuery): Promise<CatalogPage>
  catalogDetail(id: string, revision?: number): Promise<CatalogDetail>
  catalogSources(query: CatalogSourceQuery): Promise<CatalogSourcePage>
  catalogSync(request: CatalogSync): Promise<CatalogSyncResult>
  catalogProjectVersions(document: MusicVersionsDocument, revision: number): Promise<void>
  catalogResolve(sourceId: string, revision: number): Promise<TrackData | null>
}

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const uint = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
const text = (v: unknown, max: number) =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0')
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v)
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((key) => allowed.includes(key))
const validContext = (v: unknown, kind: unknown): boolean => {
  if (!record(v)) return false
  if (v.type === 'collection')
    return (
      keys(v, ['type', 'collection', 'id']) &&
      (v.collection === 'artists' || v.collection === 'albums') &&
      text(v.id, 32768)
    )
  return (
    (v.type === 'track' || v.type === 'native') &&
    keys(v, ['type', 'provider', 'id']) &&
    typeof v.provider === 'string' &&
    /^[a-z0-9][a-z0-9._-]{0,127}$/.test(v.provider) &&
    text(v.id, v.type === 'track' ? 8192 : 128) &&
    (v.type !== 'native' ||
      (v.provider !== 'local' &&
        typeof kind === 'string' &&
        ['artist', 'release', 'album_project'].includes(kind)))
  )
}

/** Shared by public validation and SQL reads; paths, URLs and arbitrary filters are not inputs. */
export function validCatalogPayload(name: string, value: unknown): boolean {
  if (!record(value)) return false
  const page = () =>
    optional(value.offset, uint) &&
    optional(value.limit, (n) => uint(n) && Number(n) >= 1 && Number(n) <= 200) &&
    optional(value.revision, uint)
  switch (name) {
    case 'catalog.query':
      return (
        keys(value, [
          'kind',
          'scope',
          'source',
          'search',
          'artistName',
          'revision',
          'offset',
          'limit',
          'context'
        ]) &&
        typeof value.kind === 'string' &&
        ['recording', 'release', 'artist', 'album_project'].includes(value.kind) &&
        optional(value.scope, (v) => v === 'library' || v === 'all') &&
        optional(value.source, (v) => text(v, 128)) &&
        optional(
          value.artistName,
          (v) => value.kind === 'artist' && text(v, 32768) && !!String(v).trim()
        ) &&
        optional(
          value.search,
          (v) => typeof v === 'string' && v.length <= 512 && !v.includes('\0')
        ) &&
        optional(value.context, (v) => validContext(v, value.kind)) &&
        page()
      )
    case 'catalog.sources':
      return (
        keys(value, ['entityId', 'revision', 'offset', 'limit']) &&
        text(value.entityId, 128) &&
        page()
      )
    case 'catalog.detail':
      return (
        keys(value, ['id', 'revision']) && text(value.id, 128) && optional(value.revision, uint)
      )
    case 'catalog.play':
      return (
        keys(value, ['sourceId', 'revision']) && text(value.sourceId, 128) && uint(value.revision)
      )
    case 'catalog.status':
    case 'catalog.refresh':
    case 'catalog.cancel':
      return keys(value, [])
    default:
      return false
  }
}
