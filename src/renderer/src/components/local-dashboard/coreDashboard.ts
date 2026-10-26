import type { CorePlayerClient } from '../../stores/player/corePlayerTypes.ts'
import type { Track } from '../../types/music.ts'
import type { LibraryCollectionSummary } from '../../../../shared/libraryDatabase.ts'

export interface CoreDashboardData {
  revision: number
  total: number
  duration: number
  albumCount: number
  artistCount: number
  first: Track[]
  recent: Track[]
  albums: LibraryCollectionSummary[]
}

/** Presentation shelves are bounded reads; Core resolves history and playback identities. */
export async function readCoreDashboard(core: Pick<CorePlayerClient, 'query'>): Promise<CoreDashboardData> {
  const first = await core.query('library.tracks', { sort: 'playlist', limit: 6 })
  const revision = first.revision
  const [recent, albums, artists] = await Promise.all([
    core.query('library.tracks', { sort: 'insertion', direction: 'desc', limit: 6, contentRevision: revision }),
    core.query('library.collections', { kind: 'albums', query: { collectionSort: 'trackCount', direction: 'desc', limit: 5, contentRevision: revision } }),
    core.query('library.collections', { kind: 'artists', query: { collectionCountOnly: true, contentRevision: revision } })
  ])
  const artwork = await core.query('library.artwork', { ids: [...new Set([...first.tracks, ...recent.tracks].map(track => track.id))], revision })
  if ([recent.revision, albums.revision, artists.revision, artwork.revision].some(value => value !== revision))
    throw new Error('曲库已变化，请刷新首页')
  const covers = new Map(artwork.items.map(item => [item.id, item.cover]))
  const display = (track: Track): Track => ({ ...track, cover: covers.get(track.id) ?? null })
  return {
    revision, total: first.total, duration: first.totalDuration ?? 0,
    albumCount: albums.total, artistCount: artists.total,
    first: first.tracks.map(display), recent: recent.tracks.map(display), albums: albums.items
  }
}
