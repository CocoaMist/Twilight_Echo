export interface MediaProviderAlbumSummary {
  id: number | string
  name: string
  artist?: string
  cover: string | null
  coverSource?: string | null
  coverSmall?: string | null
  coverSmallSource?: string | null
  trackCount: number
  publishTime?: number
  releaseType?: string
  isExplicit?: boolean
}

export interface MediaProviderArtistSummary {
  id: number | string
  name: string
  picUrl: string | null
  /** Durable origin paired with a session-scoped image grant. */
  picUrlSource?: string | null
  picUrlSmall?: string | null
  picUrlSmallSource?: string | null
  albumSize?: number
  musicSize?: number
}

export interface MediaProviderPlaylistSummary {
  id: number | string
  name: string
  cover: string | null
  /** Durable remote origin when `cover` is a session-scoped twilight-media grant. */
  coverSource?: string | null
  coverSmall?: string | null
  coverSmallSource?: string | null
  trackCount: number
  playCount?: number
  creatorName?: string
  /** True when the signed-in user owns (created) the playlist. */
  owned?: boolean
}
