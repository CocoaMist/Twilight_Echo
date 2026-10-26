import type { TrackData as Track } from './track.ts'

export type PlaylistPersistenceState = 'idle' | 'pending' | 'error'
export interface PlaylistPersistenceStatus {
  state: PlaylistPersistenceState
  dirty: boolean
  failureCount: number
  lastError: string | null
  canRetry?: false
}

/** Await each bounded page. An optional final guard runs synchronously at
 * publication, after the producer has completed and before any live mutation. */
export type PlaylistPageProducer<T> = (
  append: (items: readonly T[]) => Promise<void>
) => Promise<void | (() => void)>

export type PlaylistTrackPageProducer = PlaylistPageProducer<Track>

/** Original configured IDs (entry IDs for imports), never playback/variant IDs. */
export type PlaylistTrackIdPageProducer = PlaylistPageProducer<string>

export interface PlaylistMember {
  id: string
  /** An exact-ID snapshot from a bounded source page, for legacy ID-only
   * definitions that have no stored snapshot. A relinked variant is not exact. */
  track?: Track
}
export type PlaylistMemberPageProducer = PlaylistPageProducer<PlaylistMember>

export interface PlaylistFavoritePageState {
  count: number
  favoriteCount: number
}

export type PlaylistTrackPageCreator = (
  name: string,
  produce: PlaylistTrackPageProducer,
  signal?: AbortSignal
) => Promise<string>

export interface Playlist {
  id: string
  name: string
  trackIds: string[]
  /** Session-only external import; omitted from playlist persistence until saved. */
  transient?: boolean
  trackSnapshots?: Record<string, Track>
  /** Imported occurrences are authoritative; trackIds remains the legacy contract. */
  imported?: import('./externalPlaylist.ts').ImportedPlaylistData
  /** User-selected data URL or cached cover handle. */
  cover?: string | null
  isDefault?: boolean
  createdAt: string
  updatedAt?: string
  /**
   * 聚合歌单：跨音源收歌，同一首歌的多个音源在视图里合并成一行。缺省即普通本地
   * 歌单，所以旧的 playlists.json 无需迁移。
   */
  kind?: 'aggregate'
  /** 非空表示置顶，按时间倒序排在列表最前。 */
  pinnedAt?: string | null
  /** 该聚合歌单里被隐藏的音源 id。 */
  hiddenSources?: string[]
  /** 行锚点 trackId → 用户为这一行选定的音源 id。 */
  variantPreferences?: Record<string, string>
}

export interface LibraryItem {
  id?: string
  name: string
  trackCount: number
  tracks: Track[]
  cover: string | null
  coverSource?: string | null
  releaseDate?: string
  artist?: string
  path?: string
}

export interface PlaylistImportApplyResult {
  playlistId: string
  importedCount: number
  unresolvedEntries: number
  warnings: string[]
}

export interface PlaylistBatchMoveResult {
  moved: number
  sourceRemoved: number
}

export interface PlaylistPersistenceNotice {
  kind: 'revision-conflict-recovered'
  message: string
  authoritativeRevision: number
  recoveredAt: string
}

export interface DerivedTrackGroup {
  tracks: Track[]
  cover: string | null
  coverSource?: string | null
  artist?: string
}

export function isAggregatePlaylist(playlist: { kind?: string }): boolean {
  return playlist.kind === 'aggregate'
}
