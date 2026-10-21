import { shallowRef, watch } from 'vue'
import {
  LIBRARY_CACHE_PAGES,
  type LibraryCollectionKind,
  type LibraryCollectionPage,
  type LibraryDatabaseApi,
  type LibraryQuery
} from '../../../../shared/libraryDatabase.ts'
import { LibraryResultPageCache } from './libraryResultPageCache.ts'
import { createLibraryResultWindow } from './libraryResultWindow.ts'

/** Continuous summary windows retain total height, not full collection members. */
export function createLibraryCollectionWindow(
  api: Pick<LibraryDatabaseApi, 'queryCollections'>,
  capacity = LIBRARY_CACHE_PAGES
) {
  let kind: LibraryCollectionKind | null = null
  const cache = new LibraryResultPageCache<LibraryCollectionPage>(
    {
      readPage(query) {
        if (!kind) return Promise.reject(new Error('未选择分类'))
        return api.queryCollections(kind, query)
      },
      itemCount: (page) => page.items.length,
      validatePage(page) {
        if (
          !page.letterOffsets ||
          Object.values(page.letterOffsets).some(
            (index) => !Number.isSafeInteger(index) || index < 0 || index >= page.total
          )
        )
          throw new Error('数据库返回了无效的分类索引')
      }
    },
    capacity
  )
  const window = createLibraryResultWindow(cache, (page) => page.items)
  const letterOffsets = shallowRef<Record<string, number>>({})
  const stop = watch(
    () => window.state.value.page,
    (page) => {
      if (page) letterOffsets.value = page.letterOffsets
    },
    { flush: 'sync' }
  )
  return {
    ...window,
    letterOffsets,
    get cacheState() {
      return cache.state
    },
    setQuery(
      next: LibraryCollectionKind | null,
      query: LibraryQuery = {},
      preservePosition = false
    ) {
      kind = next
      if (!preservePosition) letterOffsets.value = {}
      window.setQuery(next ? query : null, preservePosition)
    },
    dispose() {
      stop()
      window.dispose()
      letterOffsets.value = {}
    }
  }
}
