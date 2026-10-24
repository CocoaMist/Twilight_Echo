import { computed, shallowRef, watch } from 'vue'
import type { CoreSnapshot } from '../../../../shared/coreProtocol.ts'
import type {
  CatalogEntity,
  CatalogKind,
  CatalogPage,
  CatalogQuery,
  CatalogReferenceContext,
  CatalogSourcePage,
  CatalogSourceQuery
} from '../../../../shared/musicCatalog.ts'
import type {
  EntityMetadataDetail,
  EntityMetadataLanguage
} from '../../../../shared/entityMetadata.ts'

export const METADATA_REFERENCE_PAGE_SIZE = 6
export interface EntityMetadataContext {
  context: CatalogReferenceContext
  kind: CatalogKind
  sourceProvider: string
}
export interface EntityMetadataReadApi {
  catalog(query: CatalogQuery, signal: AbortSignal): Promise<CatalogPage>
  sources(query: CatalogSourceQuery, signal: AbortSignal): Promise<CatalogSourcePage>
  detail(
    entityId: string,
    language: EntityMetadataLanguage,
    sourceProvider: string,
    signal: AbortSignal
  ): Promise<EntityMetadataDetail>
}
export interface EntityMetadataViewState {
  page: CatalogPage | null
  samples: Record<string, string>
  selected: CatalogEntity | null
  detail: EntityMetadataDetail | null
  loading: boolean
  detailLoading: boolean
  error: string
  detailError: string
  detailNotice: string
}
const empty = (): EntityMetadataViewState => ({
  page: null,
  samples: {},
  selected: null,
  detail: null,
  loading: false,
  detailLoading: false,
  error: '',
  detailError: '',
  detailNotice: ''
})
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Read-only view of existing identities. Opening a page never starts a network lookup. */
export function createEntityMetadataView(api: EntityMetadataReadApi) {
  const state = shallowRef<EntityMetadataViewState>(empty())
  let current: EntityMetadataContext | null = null,
    language: EntityMetadataLanguage = 'zh-Hans'
  let pageRequest: AbortController | null = null,
    detailRequest: AbortController | null = null
  let disposed = false
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  function applyExpiry(detail: EntityMetadataDetail, request: AbortController) {
    clearTimeout(expiryTimer)
    if (disposed || detailRequest !== request) return
    const expired = detail.facts.filter(f => f.usage?.expiresAt !== undefined && f.usage.expiresAt <= Date.now())
    const facts = detail.facts.filter(f => !expired.includes(f))
    const expiredIntroduction = detail.introduction?.origin === 'external' && expired.some(f =>
      f.value === detail.introduction?.value && f.attribution.provider === detail.introduction.attribution?.provider &&
      f.attribution.externalId === detail.introduction.attribution?.externalId && f.attribution.revision === detail.introduction.attribution?.revision)
    const options = (detail.sourceOptions ?? []).filter(provider => facts.some(f =>
      ['introduction', 'description'].includes(f.field) && f.attribution.provider === provider))
    const next = expired.length ? { ...detail, facts, introduction: expiredIntroduction ? null : detail.introduction,
      sourceOptions: options, ...(detail.sourcePreference ? { sourcePreference: { ...detail.sourcePreference,
        available: !detail.sourcePreference.provider || options.includes(detail.sourcePreference.provider) } } : {}) } : detail
    state.value = { ...state.value, detail: next, detailLoading: false,
      detailNotice: expired.length ? '部分自动资料已到期，请重新读取。' : state.value.detailNotice }
    const expiry = Math.min(...facts.flatMap(f => f.usage?.expiresAt === undefined ? [] : [f.usage.expiresAt]))
    if (Number.isFinite(expiry)) expiryTimer = setTimeout(() => applyExpiry(next, request), Math.min(2147483647, Math.max(1, expiry - Date.now())))
  }
  async function select(entity: CatalogEntity | null) {
    clearTimeout(expiryTimer)
    detailRequest?.abort()
    const request = new AbortController()
    detailRequest = request
    state.value = {
      ...state.value,
      selected: entity,
      detail: null,
      detailError: '',
      detailNotice: '',
      detailLoading: !!entity
    }
    if (!entity || !current || disposed) return
    try {
      const detail = await api.detail(entity.id, language, current.sourceProvider, request.signal)
      if (!disposed && detailRequest === request) applyExpiry(detail, request)
    } catch (error) {
      if (!disposed && detailRequest === request)
        state.value = { ...state.value, detailError: message(error), detailLoading: false }
    }
  }
  async function load(offset = 0, revision?: number) {
    if (!current || disposed) return
    pageRequest?.abort()
    const request = new AbortController(),
      previous = state.value.selected
    pageRequest = request
    void select(null)
    state.value = { ...state.value, loading: true, error: '' }
    try {
      const page = await api.catalog(
        {
          kind: current.kind,
          context: current.context,
          source: current.sourceProvider,
          offset,
          limit: METADATA_REFERENCE_PAGE_SIZE,
          revision
        },
        request.signal
      )
      if (disposed || pageRequest !== request) return
      if (offset > 0 && offset >= page.total) return load()
      const samples = Object.fromEntries(
        await Promise.all(
          page.items.map(async (entity) => {
            const sources = await api.sources(
              { entityId: entity.id, revision: page.revision, limit: 1 },
              request.signal
            )
            const sample = sources.items[0]
            return [
              entity.id,
              sample
                ? [sample.track.title, sample.track.album, sample.provider]
                    .filter(Boolean)
                    .join(' · ')
                : ''
            ]
          })
        )
      )
      if (disposed || pageRequest !== request) return
      state.value = { ...empty(), page, samples }
      const selected =
        page.items.find((item) => item.id === previous?.id) ??
        (page.total === 1 ? page.items[0] : null)
      await select(selected ?? null)
    } catch (error) {
      if (!disposed && pageRequest === request) state.value = { ...empty(), error: message(error) }
    }
  }
  return {
    state,
    setContext(context: EntityMetadataContext | null, nextLanguage: EntityMetadataLanguage) {
      clearTimeout(expiryTimer)
      pageRequest?.abort()
      detailRequest?.abort()
      pageRequest = null
      detailRequest = null
      current = context
      language = nextLanguage
      state.value = empty()
      return context ? load() : Promise.resolve()
    },
    select,
    page: (offset: number) => load(offset, state.value.page?.revision),
    refresh: () => load(state.value.page?.offset ?? 0),
    refreshDetail: () => select(state.value.selected),
    dispose() {
      clearTimeout(expiryTimer)
      disposed = true
      pageRequest?.abort()
      detailRequest?.abort()
      pageRequest = null
      detailRequest = null
    }
  }
}

/** Observe domain revisions, never the playback sequence or position clock. */
export function observeEntityMetadataView(
  view: ReturnType<typeof createEntityMetadataView>,
  input: {
    target(): EntityMetadataContext
    language(): EntityMetadataLanguage
    snapshot(): Pick<
      CoreSnapshot,
      | 'epoch'
      | 'catalogRevision'
      | 'libraryRevision'
      | 'entityMetadataRevision'
      | 'settingsRevision'
    > | null
  }
) {
  const key = computed(() =>
    JSON.stringify([input.target(), input.language(), input.snapshot()?.epoch])
  )
  const stopReferences = watch(
    [
      () => key.value,
      () => input.snapshot()?.catalogRevision,
      () => input.snapshot()?.libraryRevision
    ],
    (value, previous) => {
      if (value[0] !== previous?.[0]) void view.setContext(input.target(), input.language())
      else void view.refresh()
    },
    { immediate: true }
  )
  const stopDetail = watch(
    [() => input.snapshot()?.entityMetadataRevision, () => input.snapshot()?.settingsRevision],
    () => {
      if (!view.state.value.loading) void view.refreshDetail()
    }
  )
  return () => {
    stopReferences()
    stopDetail()
  }
}

export function collectionMetadataContext(
  category: string,
  filter: string | null
): EntityMetadataContext | null {
  if (category === 'artists' && filter?.startsWith('artist:'))
    return {
      context: { type: 'collection', collection: 'artists', id: filter.slice(7) },
      kind: 'artist',
      sourceProvider: 'local'
    }
  if (category === 'albums' && filter?.startsWith('album:'))
    return {
      context: { type: 'collection', collection: 'albums', id: filter.slice(6) },
      kind: 'release',
      sourceProvider: 'local'
    }
  return null
}

export function metadataExternalUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}
