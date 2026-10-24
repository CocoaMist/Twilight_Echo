import { shallowRef } from 'vue'
import type { CatalogEntity, CatalogPage, CatalogQuery } from '../../../../shared/musicCatalog.ts'
export const TRACK_RATING_CHOICES_PAGE_SIZE = 6
export function createTrackRatingsView(
  query: (query: CatalogQuery, signal: AbortSignal) => Promise<CatalogPage>
) {
  const state = shallowRef({
    page: null as CatalogPage | null,
    selected: null as CatalogEntity | null,
    loading: false,
    blocked: false,
    error: ''
  })
  let context: { provider: string; id: string } | null = null,
    scope = '',
    disposed = false
  let reading: AbortController | null = null
  async function load(offset = 0, revision?: number) {
    if (!context || disposed) return
    reading?.abort()
    const request = new AbortController(),
      selectedId = state.value.selected?.id
    reading = request
    state.value = {
      ...state.value,
      page: null,
      selected: null,
      loading: true,
      blocked: false,
      error: ''
    }
    try {
      const page = await query(
        {
          kind: 'recording',
          context: { type: 'track', ...context },
          source: context.provider,
          offset,
          limit: TRACK_RATING_CHOICES_PAGE_SIZE,
          revision
        },
        request.signal
      )
      if (disposed || reading !== request) return
      if (offset > 0 && offset >= page.total) return load()
      state.value = {
        ...state.value,
        page,
        loading: false,
        selected:
          page.items.find((item) => item.id === selectedId) ??
          (page.total === 1 ? (page.items[0] ?? null) : null)
      }
    } catch (error) {
      if (!disposed && reading === request)
        state.value = {
          ...state.value,
          loading: false,
          error: error instanceof Error ? error.message : String(error)
        }
    }
  }
  return {
    state,
    refresh: () => load(),
    page: (offset: number) => load(offset, state.value.page?.revision),
    setContext(next: { provider: string; id: string }, nextScope: string) {
      if (JSON.stringify(next) === JSON.stringify(context) && scope === nextScope)
        return Promise.resolve()
      context = next
      scope = nextScope
      state.value = { page: null, selected: null, loading: false, blocked: false, error: '' }
      return load()
    },
    select(entity: CatalogEntity) {
      if (
        !state.value.blocked &&
        !state.value.loading &&
        state.value.page?.items.some((item) => item.id === entity.id)
      )
        state.value = { ...state.value, selected: entity }
    },
    invalidate() {
      reading?.abort()
      reading = null
      state.value = { ...state.value, page: null, selected: null, loading: false, blocked: true }
    },
    dispose() {
      disposed = true
      reading?.abort()
      reading = null
    }
  }
}
