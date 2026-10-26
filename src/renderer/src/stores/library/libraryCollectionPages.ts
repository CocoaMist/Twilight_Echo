import { shallowRef } from 'vue'
import {
  LIBRARY_CACHE_PAGES,
  LIBRARY_PAGE_SIZE,
  type LibraryCollectionKind,
  type LibraryCollectionPage,
  type LibraryDatabaseApi,
  type LibraryQuery
} from '../../../../shared/libraryDatabase.ts'

export interface LibraryCollectionPageState {
  page: LibraryCollectionPage | null
  total: number | null
  requestedPage: number
  loading: boolean
  error: string
  generation: number
}

/** Summary pages have their own total and query identity; they are never a
 * partial replacement for the legacy collections with complete track members. */
export function createLibraryCollectionPages(
  api: Pick<LibraryDatabaseApi, 'queryCollections'>,
  pageSize = LIBRARY_PAGE_SIZE
) {
  const state = shallowRef<LibraryCollectionPageState>({
    page: null,
    total: null,
    requestedPage: 0,
    loading: false,
    error: '',
    generation: 0
  })
  const cache = new Map<number, LibraryCollectionPage>()
  let selection: { kind: LibraryCollectionKind; query: LibraryQuery } | null = null
  let epoch = 0
  let minimumRevision = 0
  let active = 0
  let disposed = false
  let desired: { generation: number; page: number } | null = null

  function request(page: number, preservePage = false): void {
    if (disposed || !selection) return
    if (!Number.isSafeInteger(page) || page < 0) throw new Error('无效的分类页码')
    const generation = state.value.generation + 1
    desired = { generation, page }
    state.value = {
      ...state.value,
      page: preservePage ? state.value.page : null,
      requestedPage: page,
      loading: true,
      error: '',
      generation
    }
    pump()
  }

  function pump(): void {
    if (disposed || active >= 2 || !desired || !selection) return
    const demand = desired,
      current = selection,
      queryEpoch = epoch
    desired = null
    active++
    void (async () => {
      try {
        let page = cache.get(demand.page)
        if (!page)
          page = await api.queryCollections(current.kind, {
            ...current.query,
            offset: demand.page * pageSize,
            limit: pageSize
          })
        if (disposed || queryEpoch !== epoch) return
        if (page.revision < minimumRevision) throw new Error('曲库在读取期间发生变化，请重试')
        if (
          page.offset !== demand.page * pageSize ||
          page.items.length > pageSize ||
          !Number.isSafeInteger(page.total) ||
          page.total < 0
        )
          throw new Error('数据库返回了无效的分类分页')
        if (page.revision > minimumRevision) {
          minimumRevision = page.revision
          cache.clear()
        }
        cache.delete(demand.page)
        cache.set(demand.page, page)
        while (cache.size > LIBRARY_CACHE_PAGES) cache.delete(cache.keys().next().value!)
        if (demand.generation !== state.value.generation) return
        const lastPage = Math.max(0, Math.ceil(page.total / pageSize) - 1)
        if (demand.page > lastPage) {
          request(lastPage)
          return
        }
        state.value = { ...state.value, page, total: page.total, loading: false }
      } catch (error) {
        if (!disposed && queryEpoch === epoch && demand.generation === state.value.generation)
          state.value = {
            ...state.value,
            page: null,
            loading: false,
            error: error instanceof Error ? error.message : String(error)
          }
      } finally {
        active--
        pump()
      }
    })()
  }

  return {
    state,
    setQuery(kind: LibraryCollectionKind | null, query: LibraryQuery = {}) {
      const { offset: _offset, limit: _limit, anchorId: _anchorId, ...scope } = query
      selection = kind ? { kind, query: structuredClone(scope) } : null
      epoch++
      cache.clear()
      desired = null
      state.value = {
        page: null,
        total: null,
        requestedPage: 0,
        loading: false,
        error: '',
        generation: state.value.generation + 1
      }
      if (selection) request(0)
    },
    goToPage: request,
    retry: () => request(state.value.requestedPage),
    invalidate(revision?: number) {
      if (revision !== undefined && revision <= minimumRevision) return
      if (revision !== undefined) minimumRevision = revision
      epoch++
      cache.clear()
      // A committed revision refreshes this same page. Keep its presentation
      // (not its cache) until the replacement arrives, so album headers do not
      // unmount on every background metadata commit.
      request(state.value.requestedPage, true)
    },
    get cacheState() {
      return {
        cachedPages: cache.size,
        activeRequests: active,
        cachedItems: [...cache.values()].reduce((count, page) => count + page.items.length, 0)
      }
    },
    dispose() {
      disposed = true
      epoch++
      desired = null
      cache.clear()
    }
  }
}
