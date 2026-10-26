import type { TrackData } from './track.ts'
import type {
  MediaProviderAlbumSummary,
  MediaProviderArtistSummary,
  MediaProviderPlaylistSummary
} from './providerSearch.ts'
import { getTrackSearchBlob } from './trackSearchText.ts'
import { getPinyinInitials } from './pinyinInitials.ts'
import { SymSpellIndex, getMaxSymSpellTolerance } from './searchRelevance.ts'

export interface LocalAlbumSearchItem {
  id?: string
  name: string
  artist?: string
  cover: string | null
  coverSource?: string | null
  trackCount: number
}

const albumSearchText = new WeakMap<LocalAlbumSearchItem, string>()

export type LocalPlaylistSearchItem = {
  id: number | string
  name: string
} & ({ count: number } | { trackIds: readonly string[] })

export interface LocalArtistSearchItem {
  name: string
  cover: string | null
  trackCount: number
}

interface PageBounds {
  limit: number
  offset: number
}

export function normalizeLocalStreamingQuery(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function normalizePageBounds(limit: number = 30, offset: number = 0): PageBounds {
  return {
    limit: Math.max(0, limit),
    offset: Math.max(0, offset)
  }
}

function collectPagedMatches<T, R>(
  items: readonly T[],
  query: string,
  limit: number | undefined,
  offset: number | undefined,
  matches: (item: T, query: string) => boolean,
  mapResult: (item: T) => R
): { items: R[]; total: number } {
  const page: R[] = []
  const bounds = normalizePageBounds(limit, offset)
  let total = 0

  for (const item of items) {
    if (!matches(item, query)) continue
    if (total >= bounds.offset && page.length < bounds.limit) {
      page.push(mapResult(item))
    }
    total++
  }

  return { items: page, total }
}

export function searchLocalStreamingSongs<T extends Pick<TrackData, 'title' | 'artist' | 'album'>>(
  tracks: readonly T[],
  keywords: string,
  limit?: number,
  offset?: number
): { tracks: T[]; total: number } {
  const query = normalizeLocalStreamingQuery(keywords.trim())
  if (!query) return { tracks: [], total: 0 }

  const result = collectPagedMatches(
    tracks,
    query,
    limit,
    offset,
    (track, q) => getTrackSearchBlob(track).includes(q),
    (track) => track
  )

  return { tracks: result.items, total: result.total }
}

export function searchLocalStreamingPlaylists(
  playlists: readonly LocalPlaylistSearchItem[],
  keywords: string,
  limit?: number,
  offset?: number
): { playlists: MediaProviderPlaylistSummary[]; total: number } {
  const query = normalizeLocalStreamingQuery(keywords.trim())
  if (!query) return { playlists: [], total: 0 }

  const result = collectPagedMatches(
    playlists,
    query,
    limit,
    offset,
    (playlist, q) => normalizeLocalStreamingQuery(playlist.name).includes(q),
    (playlist): MediaProviderPlaylistSummary => ({
      id: playlist.id,
      name: playlist.name,
      cover: null,
      trackCount: 'count' in playlist ? playlist.count : playlist.trackIds.length
    })
  )

  return { playlists: result.items, total: result.total }
}

export function searchLocalStreamingAlbums(
  albums: readonly LocalAlbumSearchItem[],
  keywords: string,
  limit?: number,
  offset?: number
): { albums: MediaProviderAlbumSummary[]; total: number } {
  const queries = keywords.trim().split(/\s+/u).map(normalizeLocalStreamingQuery).filter(Boolean)
  if (!queries.length) return { albums: [], total: 0 }
  const runSearch = (activeQueries: string[]) =>
    collectPagedMatches(
      albums,
      keywords,
      limit,
      offset,
      (album) => {
        if (!album.id) return false
        let text = albumSearchText.get(album)
        if (text === undefined) {
          text = [
            normalizeLocalStreamingQuery(album.name),
            normalizeLocalStreamingQuery(album.artist ?? ''),
            getPinyinInitials(album.name),
            getPinyinInitials(album.artist ?? '')
          ].join('\u0000')
          albumSearchText.set(album, text)
        }
        return activeQueries.every((query) => text.includes(query))
      },
      (album): MediaProviderAlbumSummary => ({
        id: album.id!,
        name: album.name,
        artist: album.artist,
        cover: album.cover,
        coverSource: album.coverSource,
        trackCount: album.trackCount
      })
    )
  let result = runSearch(queries)
  if (result.total === 0 && queries.some((q) => getMaxSymSpellTolerance(q) > 0)) {
    const symSpell = new SymSpellIndex()
    for (const album of albums) {
      if (!album.id) continue
      symSpell.addText(album.name, 3)
      if (album.artist) symSpell.addText(album.artist, 2)
    }
    const suggestion = symSpell.suggestQuery(keywords)
    if (suggestion) {
      result = runSearch(suggestion.tokens)
    }
  }
  return { albums: result.items, total: result.total }
}

export function searchLocalStreamingArtists(
  artists: readonly LocalArtistSearchItem[],
  keywords: string,
  limit?: number,
  offset?: number
): { artists: MediaProviderArtistSummary[]; total: number } {
  const query = normalizeLocalStreamingQuery(keywords.trim())
  if (!query) return { artists: [], total: 0 }

  const runSearch = (activeQuery: string) =>
    collectPagedMatches(
      artists,
      activeQuery,
      limit,
      offset,
      (artist, q) => normalizeLocalStreamingQuery(artist.name).includes(q),
      (artist): MediaProviderArtistSummary => ({
        id: artist.name,
        name: artist.name,
        picUrl: artist.cover,
        musicSize: artist.trackCount
      })
    )
  let result = runSearch(query)
  if (result.total === 0 && getMaxSymSpellTolerance(query) > 0) {
    const symSpell = new SymSpellIndex()
    for (const artist of artists) {
      symSpell.addText(artist.name, 3)
    }
    const suggestion = symSpell.suggestQuery(keywords)
    if (suggestion) {
      result = runSearch(normalizeLocalStreamingQuery(suggestion.correctedQuery))
    }
  }

  return { artists: result.items, total: result.total }
}
