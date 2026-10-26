import type { CoreTrackView } from './coreViews.ts'
import type { UnifiedSearchResult, UnifiedSearchTrackItem } from './unifiedMusicSearch.ts'
import type { LibraryQuery } from './libraryDatabase.ts'

export interface CoreMusicSearchQuery {
  query: string
  scope?: 'all' | 'local'
  limit?: number
  offset?: number
  contentRevision?: number
  versionsRevision?: number
  networkRevision?: number
}
export type CoreSearchTrackItem = Omit<UnifiedSearchTrackItem, 'track'> & { track: CoreTrackView }
export interface CoreMusicSearchPage extends Omit<UnifiedSearchResult, 'items' | 'logicalItems'> {
  items: CoreSearchTrackItem[]
  logicalItems: Array<{
    id: string
    title: string
    artist: string
    album: string
    preferredTrack: CoreTrackView
    variants: Array<Omit<CoreSearchTrackItem, 'kind'>>
    preferenceUnavailable?: boolean
  }>
  versionsRevision: number
  networkRevision?: number
  playbackQuery?: LibraryQuery
}

export type CoreCollectionKind = 'albums' | 'artists' | 'playlists'
export type CoreCollectionSearchMethod = 'searchAlbums' | 'searchArtists' | 'searchPlaylists'
export interface CoreCollectionSearchQuery {
  kind: CoreCollectionKind
  query: string
  scope?: 'all' | 'local'
  providerId?: string
  limit?: number
  offset?: number
  contentRevision?: number
  playlistsRevision?: number
}
/** Artwork is read through the controlled media path, like song/library views. */
export interface CoreSearchCollection {
  cover?: string | null
  picUrl?: string | null
  kind: CoreCollectionKind
  id: string | number
  name: string
  providerId: string
  providerName: string
  artist?: string
  trackCount?: number
  musicSize?: number
  albumSize?: number
  publishTime?: number
  releaseType?: string
  isExplicit?: boolean
  playCount?: number
  creatorName?: string
  owned?: boolean
}
export interface CoreCollectionSearchPage {
  items: CoreSearchCollection[]
  total: number
  offset: number
  hasMore: boolean
  libraryRevision?: number
  playlistsRevision?: number
  warning?: string
}
