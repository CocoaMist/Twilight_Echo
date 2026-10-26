import type { GenreBrowseReadContext, GenreBrowseToken } from './musicGenreBrowse.ts'
import { validGenreBrowseToken } from './musicGenreBrowse.ts'

/** Shares the library's durable metadata/context/expiry fence. */
export type AlbumBrowseToken = GenreBrowseToken
/** Private Core/database authorization input, never a public payload field. */
export type AlbumBrowseReadContext = GenreBrowseReadContext

export interface AlbumBrowseQuery {
  /** Current catalog release or album_project. Names are never lookup keys. */
  entityId: string
  offset?: number
  limit?: number
  token?: AlbumBrowseToken
}
export interface AlbumBrowseScope {
  entityId: string
  /** Opaque release grouping ID from this browse snapshot. */
  releaseId: string
  token: AlbumBrowseToken
}
export interface AlbumSourcesQuery extends AlbumBrowseScope {
  offset?: number
  limit?: number
}
export interface AlbumBrowseProject {
  entityId: string
  title: string
  artist: string
  identity: 'confirmed' | 'unidentified'
  metadataTargetId: string | null
}
export interface AlbumBrowseRelease {
  id: string
  /** Representative catalog release; metadata identity is a separate field. */
  entityId: string
  title: string
  artist: string
  current: boolean
  identity: 'confirmed' | 'unidentified'
  metadataTargetId: string | null
  sourceCount: number
  /** Distinct album playback bindings, including ungrouped source-scoped releases. */
  playbackVersionCount: number
}
/** Manual playback equivalence and family, not a confirmed metadata release. */
export interface AlbumPlaybackVersion {
  id: string
  entityId: string
  label: string
  familyId: string | null
  preferredVersionId: string | null
  /** The manual entity's own confirmation; never inherited by physical releases. */
  metadataTargetId: string | null
  projectMetadataTargetId: string | null
}
export interface AlbumBrowseSource {
  sourceId: string
  provider: string
  recordingId: string
  title: string
  artist: string
  album: string
  availability: 'indexed' | 'unknown' | 'missing'
  preferred: boolean
  playbackVersion: AlbumPlaybackVersion | null
  /** Manual and physical confirmations disagree; neither overwrites the other. */
  identityConflict: boolean
}
export interface AlbumBrowsePage {
  token: AlbumBrowseToken
  project: AlbumBrowseProject | null
  /** A manual playback version may span several projects; never label them as one. */
  projectCount: number
  currentRelease: AlbumBrowseRelease | null
  offset: number
  total: number
  items: AlbumBrowseRelease[]
  /** No external release-list capability is enabled by this library-only read. */
  externalCatalog: 'unavailable'
}
export interface AlbumSourcesPage {
  token: AlbumBrowseToken
  release: AlbumBrowseRelease | null
  offset: number
  total: number
  items: AlbumBrowseSource[]
  /** Providers of the complete selected release, independent of source pagination; max 128. */
  providers: string[]
  providerCount: number
}
export interface AlbumBrowseDatabaseApi {
  albumsBrowse(query: AlbumBrowseQuery, context?: AlbumBrowseReadContext): Promise<AlbumBrowsePage>
  albumsSources(
    query: AlbumSourcesQuery,
    context?: AlbumBrowseReadContext
  ): Promise<AlbumSourcesPage>
  /** Internal playback fence; not exposed as a public request. */
  albumsContainsSource(
    scope: AlbumBrowseScope,
    sourceId: string,
    context?: AlbumBrowseReadContext
  ): Promise<boolean>
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number) =>
  typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0')
const uint = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0

export function validAlbumBrowseScope(value: unknown): value is AlbumBrowseScope {
  return (
    record(value) &&
    Object.keys(value).every((key) => ['entityId', 'releaseId', 'token'].includes(key)) &&
    text(value.entityId, 128) &&
    text(value.releaseId, 256) &&
    validGenreBrowseToken(value.token)
  )
}

export function validAlbumBrowsePayload(name: string, value: unknown): boolean {
  if (!record(value) || !['albums.browse', 'albums.sources'].includes(name)) return false
  const source = name === 'albums.sources'
  return (
    Object.keys(value).every((key) =>
      ['entityId', 'offset', 'limit', 'token', ...(source ? ['releaseId'] : [])].includes(key)
    ) &&
    text(value.entityId, 128) &&
    (value.offset === undefined || uint(value.offset)) &&
    (value.limit === undefined ||
      (uint(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 200)) &&
    (source
      ? text(value.releaseId, 256) && validGenreBrowseToken(value.token)
      : value.token === undefined || validGenreBrowseToken(value.token))
  )
}
