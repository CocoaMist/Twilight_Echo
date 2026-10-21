import type { LibraryQuery } from '../../../shared/libraryDatabase.ts'
import type { LibraryViewState } from './libraryViewPreferences.ts'

/** View preferences have the same sort/filter meaning in both storage modes. */
export function libraryTrackQuery(state: LibraryViewState, search: string): LibraryQuery {
  const f = state.filters
  return {
    search: search.trim(),
    sort: state.sortKey,
    direction: state.sortDirection,
    filters: {
      ...(f.lossless ? { lossless: true } : {}),
      ...(f.dsd ? { dsd: true } : {}),
      ...(f.sampleRate !== null ? { sampleRate: f.sampleRate } : {}),
      ...(f.bitDepth !== null ? { bitDepth: f.bitDepth } : {}),
      ...(f.folder !== null ? { folder: f.folder } : {}),
      ...(f.provider !== null ? { provider: f.provider } : {})
    }
  }
}

/** Preserve link identities, including structured artist credits and recursive folders. */
export function libraryDetailScope(category: string, filter: string | null): LibraryQuery | null {
  if (!filter && category === 'allSongs') return {}
  const prefixes = { artists: 'artist:', albums: 'album:', genres: 'genre:', folders: 'folder:' }
  const prefix = prefixes[category as keyof typeof prefixes]
  if (!prefix || !filter?.startsWith(prefix) || filter.length === prefix.length) return null
  const value = filter.slice(prefix.length)
  switch (category) {
    case 'artists':
      return { artist: value }
    case 'albums':
      return { albumId: value }
    case 'genres':
      return { genre: value }
    case 'folders':
      return { folder: value, recursive: true }
    default:
      return null
  }
}
