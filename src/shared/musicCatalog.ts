import type { CoreTrackView } from './coreViews.ts'
import type { MusicVersionsDocument } from './musicVersions.ts'
import type { TrackData } from './track.ts'

export type CatalogKind = 'recording' | 'release' | 'artist'
export const CATALOG_MAX_BATCH_BYTES = 1024 * 1024
export interface CatalogEntity {
  id: string
  kind: CatalogKind
  title: string
  artist: string
  identity: 'source' | 'manual'
  sourceCount: number
}
export interface CatalogQuery {
  kind: CatalogKind
  scope?: 'library' | 'all'
  source?: string
  search?: string
  revision?: number
  offset?: number
  limit?: number
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
        keys(value, ['kind', 'scope', 'source', 'search', 'revision', 'offset', 'limit']) &&
        ['recording', 'release', 'artist'].includes(String(value.kind)) &&
        optional(value.scope, (v) => v === 'library' || v === 'all') &&
        optional(value.source, (v) => text(v, 128)) &&
        optional(
          value.search,
          (v) => typeof v === 'string' && v.length <= 512 && !v.includes('\0')
        ) &&
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
