import type { Track } from '../../types/music'

export interface Playlist {
  id: string
  name: string
  trackIds: string[]
  trackSnapshots?: Record<string, Track>
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
  artist?: string
}
