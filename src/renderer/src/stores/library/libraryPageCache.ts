import {
  LIBRARY_CACHE_PAGES,
  type LibraryDatabaseApi,
  type LibraryPage
} from '../../../../shared/libraryDatabase.ts'
import { LibraryResultPageCache } from './libraryResultPageCache.ts'

/** Track-specific occurrence validation over the shared bounded page transport. */
export class LibraryPageCache extends LibraryResultPageCache<LibraryPage> {
  constructor(api: Pick<LibraryDatabaseApi, 'queryTracks'>, capacity = LIBRARY_CACHE_PAGES) {
    super(
      {
        readPage: (query) => api.queryTracks(query),
        itemCount: (page) => page.tracks.length,
        validatePage(page, query) {
          if (
            query.playlistView !== undefined &&
            (!Array.isArray(page.entryIds) ||
              page.entryIds.length !== page.tracks.length ||
              new Set(page.entryIds).size !== page.entryIds.length ||
              page.entryIds.some((id) => !/^(0|[1-9]\d*)$/.test(id)))
          )
            throw new Error('Database returned an invalid library page')
        }
      },
      capacity
    )
  }
  override get state() {
    const state = super.state
    return { ...state, cachedTracks: state.cachedItems }
  }
}
