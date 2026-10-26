import type { CoreLibraryReadApi } from './coreLibraryApi.ts'
import type { CoreTrackView } from '../../../../shared/coreViews.ts'
import { LIBRARY_CACHE_PAGES } from '../../../../shared/libraryDatabase.ts'
import { LibraryPageCache } from './libraryPageCache.ts'
import { createLibraryResultWindow } from './libraryResultWindow.ts'

/** Continuous tracks retain the established public lookup and cursor contract. */
export function createLibraryTrackWindow(api: CoreLibraryReadApi, capacity = LIBRARY_CACHE_PAGES) {
  const cache = new LibraryPageCache(api, capacity)
  const window = createLibraryResultWindow(cache, (page) => page.tracks)
  return {
    ...window,
    trackAt: window.itemAt,
    pageForTrack: (track: CoreTrackView) => window.pageForItem(track),
    indexOfTrack: window.indexOfItem,
    get cacheState() {
      return cache.state
    }
  }
}
