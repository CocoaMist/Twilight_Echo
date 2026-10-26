import { shallowRef } from 'vue'
import type { CatalogEntityReference } from '../../../../shared/musicCatalog.ts'
import type {
  MusicRatingsTargetsPage,
  MusicRatingsTargetsQuery
} from '../../../../shared/musicRatings.ts'

export const RATING_TARGET_PAGE_SIZE = 6
/** Manual playback versions are navigation anchors, never personal rating targets. */
export function createRatingTargetsView(
  query: (query: MusicRatingsTargetsQuery, signal: AbortSignal) => Promise<MusicRatingsTargetsPage>
) {
  const state = shallowRef({
    page: null as MusicRatingsTargetsPage | null,
    selected: null as CatalogEntityReference | null,
    loading: false,
    blocked: false,
    error: ''
  })
  let entityId: string | null = null,
    scope = '',
    trackContext: { provider: string; id: string } | undefined,
    disposed = false,
    reading: AbortController | null = null
  async function load(offset = 0) {
    if (!entityId || disposed) return
    reading?.abort()
    const request = new AbortController(),
      selectedId = state.value.selected?.id
    reading = request
    state.value = { ...state.value, page: null, loading: true, blocked: false, error: '' }
    try {
      const page = await query(
        {
          entityId,
          offset,
          limit: RATING_TARGET_PAGE_SIZE,
          ...(trackContext ? { trackContext } : {})
        },
        request.signal
      )
      if (disposed || reading !== request) return
      if (offset > 0 && offset >= page.total) return load(0)
      state.value = {
        page,
        selected:
          page.items.find((item) => item.id === selectedId) ??
          (page.total === 1 ? (page.items[0] ?? null) : null),
        loading: false,
        blocked: false,
        error: ''
      }
    } catch (error) {
      if (!disposed && reading === request)
        state.value = {
          ...state.value,
          selected: null,
          loading: false,
          error: error instanceof Error ? error.message : String(error)
        }
    }
  }
  return {
    state,
    refresh: () => load(),
    page: load,
    setContext(id: string, nextScope: string, nextTrackContext?: { provider: string; id: string }) {
      if (
        entityId === id &&
        scope === nextScope &&
        JSON.stringify(trackContext) === JSON.stringify(nextTrackContext)
      )
        return Promise.resolve()
      entityId = id
      scope = nextScope
      trackContext = nextTrackContext ? { ...nextTrackContext } : undefined
      state.value = { page: null, selected: null, loading: false, blocked: false, error: '' }
      return load()
    },
    select(target: CatalogEntityReference) {
      if (
        !state.value.blocked &&
        !state.value.loading &&
        state.value.page?.items.some((item) => item.id === target.id)
      )
        state.value = { ...state.value, selected: target }
    },
    invalidate() {
      reading?.abort()
      reading = null
      state.value = { ...state.value, page: null, loading: false, blocked: true }
    },
    dispose() {
      disposed = true
      reading?.abort()
      reading = null
    }
  }
}
