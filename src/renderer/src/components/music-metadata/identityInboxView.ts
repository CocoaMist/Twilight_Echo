import { shallowRef } from 'vue'
import type { CatalogEntityReference, CatalogKind } from '../../../../shared/musicCatalog.ts'
import type {
  IdentificationInboxPage,
  IdentificationInboxQuery,
  IdentificationCandidate
} from '../../../../shared/musicIdentification.ts'

export const IDENTITY_INBOX_PAGE_SIZE = 20
interface State {
  page: IdentificationInboxPage | null
  selected: CatalogEntityReference | null
  kind: CatalogKind | ''
  filter: IdentificationCandidate['state']
  loading: boolean
  error: string
}
export function createIdentityInboxView(
  read: (query: IdentificationInboxQuery, signal: AbortSignal) => Promise<IdentificationInboxPage>
) {
  const state = shallowRef<State>({
    page: null,
    selected: null,
    kind: '',
    filter: 'candidate',
    loading: false,
    error: ''
  })
  let request: AbortController | null = null,
    disposed = false
  async function load(
    offset = state.value.page?.offset ?? 0,
    clearSelection = false
  ): Promise<void> {
    if (disposed) return
    request?.abort()
    const current = new AbortController()
    request = current
    state.value = {
      ...state.value,
      page: null,
      loading: true,
      error: '',
      ...(clearSelection ? { selected: null } : {})
    }
    try {
      const page = await read(
        {
          offset,
          limit: IDENTITY_INBOX_PAGE_SIZE,
          state: state.value.filter,
          ...(state.value.kind ? { kind: state.value.kind } : {})
        },
        current.signal
      )
      if (disposed || request !== current) return
      if (offset > 0 && offset >= page.total) return load(0, clearSelection)
      state.value = { ...state.value, page, loading: false }
    } catch (error) {
      if (!disposed && request === current)
        state.value = {
          ...state.value,
          loading: false,
          error: error instanceof Error ? error.message : String(error)
        }
    }
  }
  return {
    state,
    refresh: (clearSelection = false) => load(state.value.page?.offset ?? 0, clearSelection),
    page: (offset: number) => load(offset, true),
    filter(kind: State['kind'], filter: State['filter']) {
      state.value = { ...state.value, kind, filter }
      return load(0, true)
    },
    select(entity: CatalogEntityReference | null) {
      if (
        !disposed &&
        (!entity || state.value.page?.items.some((item) => item.entity.id === entity.id))
      )
        state.value = { ...state.value, selected: entity }
    },
    dispose() {
      disposed = true
      request?.abort()
      request = null
    }
  }
}
