import { shallowRef } from 'vue'
import {
  LIBRARY_PAGE_SIZE,
  type LibraryDatabaseApi,
  type LibraryPage,
  type LibraryQuery
} from '../../../../shared/libraryDatabase.ts'
import { LibraryPageCache } from './libraryPageCache.ts'

export interface LibraryTrackPageState {
  page: LibraryPage | null
  total: number | null
  requestedPage: number
  loading: boolean
  error: string
  /** Changes before every query/page/revision change, including a cached read. */
  generation: number
}

/** Explicit pages, never a replacement for useMusicStore.tracks. Fast navigation
 * retains only the latest demand; two old RPCs still count against the read bound. */
export function createLibraryTrackPages(
  api: Pick<LibraryDatabaseApi, 'queryTracks'>,
  capacity?: number
) {
  const cache = new LibraryPageCache(api, capacity)
  // Explicit page navigation preserves selections; query/revision/retry does not.
  const selectionEpoch = shallowRef(0)
  const state = shallowRef<LibraryTrackPageState>({
    page: null,
    total: null,
    requestedPage: 0,
    loading: false,
    error: '',
    generation: 0
  })
  let query: LibraryQuery | null = null
  let desired: { generation: number; page: number; anchorId?: string } | null = null
  let active = 0
  let disposed = false
  let minimumRevision = 0

  function request(page: number, anchorId?: string): void {
    if (disposed || !query) return
    if (!Number.isSafeInteger(page) || page < 0) throw new Error('无效的曲库页码')
    const generation = state.value.generation + 1
    desired = { generation, page, anchorId }
    state.value = {
      page: null,
      total: state.value.total,
      requestedPage: page,
      loading: true,
      error: '',
      generation
    }
    pump()
  }

  function pump(): void {
    if (disposed || active >= 2 || !desired) return
    const demand = desired
    desired = null
    active++
    void (async () => {
      try {
        const page = await (demand.anchorId
          ? cache.locate(demand.anchorId, demand.page)
          : cache.load(demand.page))
        if (disposed || demand.generation !== state.value.generation) return
        if (!page) throw new Error('曲库在读取期间发生变化，请重试')
        if (page.revision > minimumRevision) selectionEpoch.value++
        minimumRevision = Math.max(minimumRevision, page.revision)
        const lastPage = Math.max(0, Math.ceil(page.total / LIBRARY_PAGE_SIZE) - 1)
        if (page.offset / LIBRARY_PAGE_SIZE > lastPage) {
          request(lastPage)
          return
        }
        state.value = {
          ...state.value,
          page,
          total: page.total,
          requestedPage: page.offset / LIBRARY_PAGE_SIZE,
          loading: false,
          error: demand.anchorId && page.anchorIndex === -1 ? '当前歌曲不在此查询结果中' : ''
        }
      } catch (error) {
        if (!disposed && demand.generation === state.value.generation)
          state.value = {
            ...state.value,
            loading: false,
            error: error instanceof Error ? error.message : String(error)
          }
      } finally {
        active--
        pump()
      }
    })()
  }

  function setQuery(value: LibraryQuery | null, preservePage = false): void {
    selectionEpoch.value++
    const page = preservePage ? state.value.requestedPage : 0
    const total = preservePage ? state.value.total : null
    query = value ? structuredClone(value) : null
    cache.setQuery(query ?? {})
    desired = null
    state.value = {
      page: null,
      total,
      requestedPage: page,
      loading: false,
      error: '',
      generation: state.value.generation + 1
    }
    if (query) request(page)
  }

  function invalidate(revision?: number): void {
    if (revision !== undefined && revision <= minimumRevision) return
    selectionEpoch.value++
    if (revision !== undefined) {
      minimumRevision = revision
      cache.invalidate(revision)
    } else cache.setQuery(query ?? {})
    request(state.value.requestedPage)
  }

  return {
    state,
    selectionEpoch,
    setQuery,
    goToPage: (page: number) => request(page),
    locate: (id: string) => request(state.value.requestedPage, id),
    retry: () => {
      selectionEpoch.value++
      request(state.value.requestedPage)
    },
    invalidate,
    get cacheState() {
      return cache.state
    },
    dispose() {
      disposed = true
      desired = null
      cache.dispose()
    }
  }
}
