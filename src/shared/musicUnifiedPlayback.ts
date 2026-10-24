import type { GenreBrowseToken, GenreMembersQuery } from './musicGenreBrowse.ts'
import { validGenreBrowsePayload, validGenreBrowseToken } from './musicGenreBrowse.ts'
import { validAlbumBrowseScope, type AlbumBrowseScope } from './musicAlbumBrowse.ts'
import type { TrackData } from './track.ts'

/** A separate operation from explicit catalog.play; clients submit opaque IDs. */
export interface UnifiedPlaybackRequest {
  sourceId: string
  revision: number
  providerOrder?: string[]
  scope?: GenreMembersQuery & { token: GenreBrowseToken }
  albumScope?: AlbumBrowseScope
}
export interface UnifiedPlaybackAttempt {
  sourceId: string
  provider: string
  status: 'selected' | 'failed'
  code: string | null
  message: string | null
}
export interface UnifiedPlaybackResult {
  status: 'played' | 'unavailable'
  requestedSourceId: string
  sourceId: string | null
  versionId: string | null
  attempts: UnifiedPlaybackAttempt[]
}

/** Private database/Core transport. Source keys and TrackData never enter public results. */
export interface CatalogPlaybackSourcesQuery {
  revision: number
  sourceId?: string
  sourceKeys?: string[]
  offset?: number
  limit?: number
}
export interface CatalogPlaybackSource {
  sourceId: string
  sourceKey: string
  provider: string
  inLibrary: boolean
  /** First actual catalog membership publication; legacy history is unknown. Re-adding retains the first time. */
  addedAt: number | null
  track: TrackData | null
}
export interface CatalogPlaybackSourcesPage {
  revision: number
  total: number
  offset: number
  items: CatalogPlaybackSource[]
}
export interface CatalogUnifiedPlaybackDatabaseApi {
  catalogPlaybackSources(query: CatalogPlaybackSourcesQuery): Promise<CatalogPlaybackSourcesPage>
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): boolean =>
  typeof value === 'string' && !!value.trim() && value.length <= 128 && !value.includes('\0')

export function validUnifiedPlaybackPayload(value: unknown): value is UnifiedPlaybackRequest {
  if (!record(value)) return false
  return (
    Object.keys(value).every((key) =>
      ['sourceId', 'revision', 'providerOrder', 'scope', 'albumScope'].includes(key)
    ) &&
    id(value.sourceId) &&
    Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 &&
    (value.providerOrder === undefined ||
      (Array.isArray(value.providerOrder) && value.providerOrder.length <= 128 &&
        value.providerOrder.every((provider) =>
          typeof provider === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(provider)
        ) && new Set(value.providerOrder).size === value.providerOrder.length)) &&
    (value.scope === undefined ||
      (record(value.scope) && validGenreBrowseToken(value.scope.token) &&
        validGenreBrowsePayload('genres.members', value.scope))) &&
    (value.albumScope === undefined || validAlbumBrowseScope(value.albumScope)) &&
    !(value.scope && value.albumScope)
  )
}
