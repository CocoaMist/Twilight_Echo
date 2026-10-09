import type { Track } from '../../types/music'

export type LocalTransitionName = 'local-page-down' | 'local-page-up'

export type GridItem = {
  id?: string
  name: string
  trackCount?: number
  cover?: string | null
  coverSource?: string | null
  releaseDate?: string
  path?: string
  artist?: string
  tracks?: Track[]
  trackIds?: string[]
  trackSnapshots?: Record<string, Track>
  isDefault?: boolean
}

export type PlaylistActions = {
  removeTrack: (trackId: string) => void
  addToPlaylist: (playlistName: string, trackId: string, trackSnapshot?: Track) => void
  removeFromPlaylist: (playlistName: string, trackId: string) => void
  rematchTrack?: (track: Track) => Promise<void> | void
  rematchMetadata?: (track: Track) => Promise<void> | void
  clearMetadataMatch?: (track: Track) => Promise<void> | void
  createPlaylist: (name: string) => void
  deletePlaylist: (playlistId: string) => void
  playNext?: (track: Track) => void
  viewArtist?: (track: Track) => void
  viewAlbum?: (track: Track) => void
  /** 把右键选中的曲目加进某个聚合歌单。 */
  addToAggregatePlaylist?: (playlistId: string) => void
  /** 打开「新建聚合歌单并加入」对话框。 */
  createAggregatePlaylist?: () => void
}

export type TrackPlayback = {
  playTrack: (track: Track, queue?: Track[]) => void
}
