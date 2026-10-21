import type { LibraryDatabaseApi, LibraryTrackRecord } from '../../../../shared/libraryDatabase.ts'
import { LIBRARY_CACHE_PAGES } from '../../../../shared/libraryDatabase.ts'
import { LibraryPageCache } from './libraryPageCache.ts'
import { createLibraryResultWindow } from './libraryResultWindow.ts'

/** Continuous tracks retain the established public lookup and cursor contract. */
export function createLibraryTrackWindow(
  api: Pick<LibraryDatabaseApi, 'queryTracks'>,
  capacity = LIBRARY_CACHE_PAGES
) {
  const cache = new LibraryPageCache(api, capacity)
  const window = createLibraryResultWindow(cache, (page) => page.tracks)
  return {
    ...window,
    trackAt: window.itemAt,
    pageForTrack: (track: LibraryTrackRecord) => window.pageForItem(track),
    indexOfTrack: window.indexOfItem,
    get cacheState() {
      return cache.state
    }
  }
}
