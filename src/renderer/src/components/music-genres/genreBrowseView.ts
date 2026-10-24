import { computed, shallowRef } from 'vue'
import type {
  UnifiedPlaybackRequest,
  UnifiedPlaybackResult
} from '../../../../shared/musicUnifiedPlayback.ts'
import type {
  GenreEvidencePage,
  GenreEvidenceQuery,
  GenreOverride,
  GenrePage,
  GenreQuery,
  GenreSelection,
  GenreTarget,
  MusicGenreNode
} from '../../../../shared/musicGenres.ts'
import type {
  GenreBrowseItem,
  GenreBrowseMember,
  GenreBrowsePage,
  GenreBrowseQuery,
  GenreBrowseToken,
  GenreFacetsPage,
  GenreFacetsQuery,
  GenreMembersPage,
  GenreMembersQuery
} from '../../../../shared/musicGenreBrowse.ts'
import {
  classificationFacetLabel,
  type ClassificationDimension,
  type ClassificationFilter
} from '../../../../shared/musicClassificationDimensions.ts'

export const GENRE_BROWSE_PAGE_SIZE = 20
export const genreProviderLabel = (provider: string) => (provider === 'local' ? '本地' : provider)
export const genreOriginLabel = (origin: string) =>
  ({ manual: '人工指定', source: '来源标签', external: '补充资料', none: '暂无分类' })[origin] ??
  origin
export const genreClassificationLabel = (classification: string) =>
  ({ direct: '直接分类', 'from-tracks': '来自曲目', none: '暂无流派' })[classification] ??
  classification
export const genreAvailabilityLabel = (availability: string) =>
  ({ indexed: '已索引', unknown: '待检查', missing: '来源缺失' })[availability] ?? availability
export const GENRE_DIMENSION_LABELS: Record<ClassificationDimension, string> = {
  language: '歌曲语言',
  region: '发行地区',
  projectYear: '项目首发年',
  releaseYear: '具体发行年',
  albumType: '专辑类型',
  versionAttribute: '版本属性',
  format: '格式',
  bitDepth: '位深',
  sampleRate: '采样率',
  management: '管理状态'
}
export const genreFilterLabel = (filter: ClassificationFilter) =>
  `${GENRE_DIMENSION_LABELS[filter.dimension]}：${filter.values.map((value) => classificationFacetLabel(filter.dimension, value)).join(' / ')}`

interface State {
  token: GenreBrowseToken | null
  tree: GenrePage | null
  treeSearch: string
  breadcrumbs: Array<{ id: string; name: string }>
  selectedGenre: { id: string; name: string } | null
  kind: 'recording' | 'release'
  includeDescendants: boolean
  source: string
  search: string
  filters: ClassificationFilter[]
  facetDimension: ClassificationDimension | null
  facetSearch: string
  facetDraft: string[]
  facets: GenreFacetsPage | null
  page: GenreBrowsePage | null
  selectedEntity: { id: string; title: string } | null
  members: GenreMembersPage | null
  evidenceTarget: GenreTarget | null
  evidenceLabel: string
  evidence: GenreEvidencePage | null
  draftGenreIds: string[] | null
  draftNames: Record<string, string>
  saving: boolean
  notice: string
  loadingTree: boolean
  loadingPage: boolean
  loadingMembers: boolean
  loadingEvidence: boolean
  loadingFacets: boolean
  blocked: boolean
  error: string
  playingId: string | null
  playError: string
  unifiedResult: UnifiedPlaybackResult | null
  providerPreference: 'default' | 'local' | 'streaming'
}
const empty = (): State => ({
  token: null,
  tree: null,
  treeSearch: '',
  breadcrumbs: [],
  selectedGenre: null,
  kind: 'recording',
  includeDescendants: true,
  source: '',
  search: '',
  filters: [],
  facetDimension: null,
  facetSearch: '',
  facetDraft: [],
  facets: null,
  page: null,
  selectedEntity: null,
  members: null,
  evidenceTarget: null,
  evidenceLabel: '',
  evidence: null,
  draftGenreIds: null,
  draftNames: {},
  saving: false,
  notice: '',
  loadingTree: false,
  loadingPage: false,
  loadingMembers: false,
  loadingEvidence: false,
  loadingFacets: false,
  blocked: false,
  error: '',
  playingId: null,
  playError: '',
  unifiedResult: null,
  providerPreference: 'default'
})
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const sameToken = (a: GenreBrowseToken, b: GenreBrowseToken) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every(
    (key) => a[key as keyof GenreBrowseToken] === b[key as keyof GenreBrowseToken]
  )

export function createGenreBrowseView(api: {
  tree(query: GenreQuery, signal: AbortSignal): Promise<GenrePage>
  browse(query: GenreBrowseQuery, signal: AbortSignal): Promise<GenreBrowsePage>
  members(query: GenreMembersQuery, signal: AbortSignal): Promise<GenreMembersPage>
  evidence(query: GenreEvidenceQuery, signal: AbortSignal): Promise<GenreEvidencePage>
  facets(query: GenreFacetsQuery, signal: AbortSignal): Promise<GenreFacetsPage>
  override(request: GenreOverride): Promise<GenreSelection>
  changed(): void
  play(sourceId: string, revision: number): Promise<unknown>
  playUnified?(request: UnifiedPlaybackRequest, signal: AbortSignal): Promise<UnifiedPlaybackResult>
}) {
  const state = shallowRef<State>(empty())
  const busy = computed(
    () =>
      state.value.saving ||
      state.value.loadingTree ||
      state.value.loadingPage ||
      state.value.loadingMembers ||
      state.value.loadingEvidence ||
      state.value.loadingFacets
  )
  const ready = computed(() => !busy.value && !state.value.blocked && !!state.value.token)
  const canEditTarget = computed(() => {
    const target = state.value.evidenceTarget
    return (
      ready.value &&
      !!state.value.evidence &&
      !!target &&
      !!state.value.members?.items.some((member) =>
        [member.sourceTarget, member.collectionTarget].some(
          (item) => item?.kind === target.kind && item.id === target.id
        )
      )
    )
  })
  let disposed = false,
    scope = '',
    generation = 0
  let expiryTimer: ReturnType<typeof setTimeout> | null = null
  const requests: Partial<
    Record<'tree' | 'page' | 'members' | 'evidence' | 'facets' | 'unified', AbortController>
  > = {}
  function abort() {
    for (const request of Object.values(requests)) request?.abort()
    for (const key of Object.keys(requests)) delete requests[key as keyof typeof requests]
  }
  function clearExpiry() {
    if (expiryTimer) clearTimeout(expiryTimer)
    expiryTimer = null
  }
  function invalidate() {
    if (disposed || !state.value.token) return
    clearExpiry()
    abort()
    state.value = {
      ...state.value,
      blocked: true,
      playingId: null,
      unifiedResult: null,
      page: null,
      members: null,
      facets: null,
      evidence: null,
      tree: null,
      loadingTree: false,
      loadingPage: false,
      loadingMembers: false,
      loadingEvidence: false,
      loadingFacets: false,
      error: '分类资料或音乐库已更新，请重新读取；当前选择和人工集合已保留。'
    }
  }
  function scheduleExpiry(token: GenreBrowseToken) {
    clearExpiry()
    if (token.expiresAt === null) return
    const remaining = token.expiresAt - Date.now()
    if (remaining <= 0) {
      invalidate()
      return
    }
    expiryTimer = setTimeout(
      () => {
        expiryTimer = null
        if (state.value.token !== token) return
        if (Date.now() >= token.expiresAt!) invalidate()
        else scheduleExpiry(token)
      },
      Math.min(remaining, 2_147_483_647)
    )
  }
  function begin(key: keyof typeof requests) {
    requests[key]?.abort()
    return (requests[key] = new AbortController())
  }
  const current = (key: keyof typeof requests, request: AbortController) =>
    !disposed && requests[key] === request
  function fail(error: unknown) {
    invalidate()
    state.value = {
      ...state.value,
      blocked: true,
      error: `读取未完成：${message(error)}。请重新读取；当前选择已保留。`
    }
  }
  function accept(token: GenreBrowseToken) {
    if (token.expiresAt !== null && token.expiresAt <= Date.now()) throw new Error('分类资料已到期')
    if (state.value.token && !sameToken(state.value.token, token))
      throw new Error('分类或音乐库已变化')
    state.value = { ...state.value, token }
    scheduleExpiry(token)
  }
  function filter(): Omit<GenreBrowseQuery, 'kind' | 'offset' | 'limit'> {
    const s = state.value
    return {
      ...(s.selectedGenre
        ? { genreId: s.selectedGenre.id, includeDescendants: s.includeDescendants }
        : {}),
      ...(s.source ? { source: s.source } : {}),
      ...(s.search ? { search: s.search } : {}),
      ...(s.filters.length
        ? {
            filters: s.filters.map((item) => ({
              dimension: item.dimension,
              values: [...item.values]
            }))
          }
        : {}),
      ...(s.token ? { token: s.token } : {})
    }
  }
  async function loadTree(offset = 0) {
    if (disposed) return
    const request = begin('tree'),
      s = state.value
    state.value = { ...s, loadingTree: true }
    try {
      const page = await api.tree(
        {
          ...(s.treeSearch
            ? { search: s.treeSearch }
            : { parentId: s.breadcrumbs.at(-1)?.id ?? null }),
          offset,
          limit: GENRE_BROWSE_PAGE_SIZE,
          ...(s.token ? { revision: s.token.genresRevision } : {})
        },
        request.signal
      )
      if (!current('tree', request)) return
      if (state.value.token && state.value.token.genresRevision !== page.revision)
        throw new Error('分类已变化')
      state.value = { ...state.value, tree: page }
    } catch (error) {
      if (current('tree', request)) fail(error)
    } finally {
      if (current('tree', request)) {
        delete requests.tree
        state.value = { ...state.value, loadingTree: false }
      }
    }
  }
  async function loadPage(offset = 0) {
    if (disposed) return
    const request = begin('page')
    state.value = { ...state.value, loadingPage: true }
    try {
      const page = await api.browse(
        { kind: state.value.kind, ...filter(), offset, limit: GENRE_BROWSE_PAGE_SIZE },
        request.signal
      )
      if (!current('page', request)) return
      accept(page.token)
      state.value = { ...state.value, page }
    } catch (error) {
      if (current('page', request)) fail(error)
    } finally {
      if (current('page', request)) {
        delete requests.page
        state.value = { ...state.value, loadingPage: false }
      }
    }
  }
  async function loadMembers(offset = 0) {
    const selected = state.value.selectedEntity
    if (disposed || !selected || !state.value.token) return
    const request = begin('members')
    state.value = { ...state.value, loadingMembers: true }
    try {
      const page = await api.members(
        { entityId: selected.id, ...filter(), offset, limit: GENRE_BROWSE_PAGE_SIZE },
        request.signal
      )
      if (!current('members', request)) return
      accept(page.token)
      state.value = { ...state.value, members: page }
    } catch (error) {
      if (current('members', request)) fail(error)
    } finally {
      if (current('members', request)) {
        delete requests.members
        state.value = { ...state.value, loadingMembers: false }
      }
    }
  }
  async function loadFacets(offset = 0) {
    const s = state.value
    if (disposed || !s.facetDimension || !s.token) return
    const request = begin('facets')
    state.value = { ...s, loadingFacets: true }
    try {
      const page = await api.facets(
        {
          kind: s.kind,
          ...filter(),
          dimension: s.facetDimension,
          ...(s.facetSearch ? { facetSearch: s.facetSearch } : {}),
          offset,
          limit: GENRE_BROWSE_PAGE_SIZE
        },
        request.signal
      )
      if (!current('facets', request)) return
      accept(page.token)
      state.value = { ...state.value, facets: page }
    } catch (error) {
      if (current('facets', request)) fail(error)
    } finally {
      if (current('facets', request)) {
        delete requests.facets
        state.value = { ...state.value, loadingFacets: false }
      }
    }
  }
  async function loadResults(context = generation) {
    await loadPage()
    if (!disposed && context === generation && !state.value.blocked && state.value.facetDimension)
      await loadFacets()
  }
  async function loadEvidence(offset = 0) {
    const s = state.value
    if (disposed || !s.evidenceTarget || !s.token) return
    const request = begin('evidence')
    state.value = { ...s, loadingEvidence: true }
    try {
      const page = await api.evidence(
        {
          target: s.evidenceTarget,
          revision: s.token.genresRevision,
          offset,
          limit: GENRE_BROWSE_PAGE_SIZE
        },
        request.signal
      )
      if (!current('evidence', request)) return
      if (page.revision !== state.value.token?.genresRevision) throw new Error('分类已变化')
      state.value = {
        ...state.value,
        evidence: page,
        draftGenreIds: state.value.draftGenreIds ?? [...page.selection.genreIds]
      }
    } catch (error) {
      if (current('evidence', request)) fail(error)
    } finally {
      if (current('evidence', request)) {
        delete requests.evidence
        state.value = { ...state.value, loadingEvidence: false }
      }
    }
  }
  function clearMembers() {
    requests.unified?.abort()
    delete requests.unified
    requests.members?.abort()
    delete requests.members
    requests.evidence?.abort()
    delete requests.evidence
    state.value = {
      ...state.value,
      selectedEntity: null,
      members: null,
      evidenceTarget: null,
      evidence: null,
      draftGenreIds: null,
      draftNames: {},
      evidenceLabel: '',
      loadingMembers: false,
      loadingEvidence: false,
      playError: '',
      playingId: null,
      unifiedResult: null,
      notice: ''
    }
  }
  async function refresh() {
    if (disposed || state.value.playingId || state.value.saving) return
    const context = ++generation
    clearExpiry()
    abort()
    state.value = {
      ...state.value,
      token: null,
      unifiedResult: null,
      blocked: false,
      error: '',
      loadingTree: false,
      loadingPage: false,
      loadingMembers: false,
      loadingEvidence: false,
      loadingFacets: false,
      page: null,
      tree: null,
      members: null,
      evidence: null,
      facets: null
    }
    await loadResults(context)
    if (disposed || context !== generation || state.value.blocked) return
    await loadTree()
    if (disposed || context !== generation || state.value.blocked) return
    if (state.value.selectedEntity) await loadMembers()
    if (context === generation && !state.value.blocked && state.value.evidenceTarget)
      await loadEvidence()
  }
  async function override(genreIds: string[] | null) {
    const s = state.value
    if (
      !canEditTarget.value ||
      !s.evidenceTarget ||
      !s.evidence ||
      !s.token ||
      s.draftGenreIds === null
    )
      return
    const context = generation
    state.value = { ...s, saving: true, error: '', notice: '' }
    try {
      const result = await api.override({
        target: s.evidenceTarget,
        revision: s.token.genresRevision,
        genreIds
      })
      api.changed()
      if (disposed || context !== generation) return
      state.value = {
        ...state.value,
        saving: false,
        draftGenreIds: [...result.genreIds],
        notice:
          genreIds === null
            ? '已恢复此目标的自动分类。'
            : genreIds.length
              ? '已保存此目标的人工流派集合。'
              : '已明确清空此目标的流派。'
      }
      await refresh()
    } catch (error) {
      if (!disposed && context === generation)
        state.value = {
          ...state.value,
          saving: false,
          blocked: true,
          error: `保存未确认：${message(error)}。请重新读取后核对；人工集合已保留。`
        }
    }
  }
  return {
    state,
    busy,
    ready,
    canEditTarget,
    refresh,
    invalidate,
    setScope(next: string) {
      if (disposed || scope === next) return
      scope = next
      generation++
      clearExpiry()
      abort()
      state.value = empty()
      void refresh()
    },
    observeRevisions(revisions: {
      genresRevision?: number | null
      catalogRevision?: number | null
      contentRevision?: number | null
    }) {
      const token = state.value.token
      if (!token || disposed || state.value.saving) return
      if (
        Object.entries(revisions).some(
          ([key, value]) => value != null && value !== token[key as keyof GenreBrowseToken]
        )
      ) {
        invalidate()
      }
    },
    async selectGenre(node: Pick<MusicGenreNode, 'id' | 'name'> | null) {
      if (!ready.value) return
      clearMembers()
      state.value = {
        ...state.value,
        selectedGenre: node ? { id: node.id, name: node.name } : null
      }
      await loadResults()
    },
    async setFilters(
      patch: Partial<Pick<State, 'kind' | 'includeDescendants' | 'source' | 'search'>>
    ) {
      if (!ready.value) return
      clearMembers()
      state.value = {
        ...state.value,
        ...patch,
        ...(patch.search !== undefined ? { search: patch.search.trim().slice(0, 512) } : {})
      }
      await loadResults()
    },
    async browseTree(node: Pick<MusicGenreNode, 'id' | 'name'> | null) {
      if (!ready.value) return
      state.value = {
        ...state.value,
        treeSearch: '',
        breadcrumbs: node
          ? [
              ...(state.value.treeSearch ? [] : state.value.breadcrumbs),
              { id: node.id, name: node.name }
            ]
          : []
      }
      await loadTree()
    },
    async breadcrumb(index: number) {
      if (!ready.value) return
      state.value = {
        ...state.value,
        treeSearch: '',
        breadcrumbs: state.value.breadcrumbs.slice(0, index + 1)
      }
      await loadTree()
    },
    async searchTree(value: string) {
      if (!ready.value) return
      state.value = { ...state.value, treeSearch: value.trim().slice(0, 512) }
      await loadTree()
    },
    treePage: (offset: number) => (ready.value ? loadTree(Math.max(0, offset)) : Promise.resolve()),
    page: (offset: number) => (ready.value ? loadPage(Math.max(0, offset)) : Promise.resolve()),
    membersPage: (offset: number) =>
      ready.value ? loadMembers(Math.max(0, offset)) : Promise.resolve(),
    evidencePage: (offset: number) =>
      ready.value ? loadEvidence(Math.max(0, offset)) : Promise.resolve(),
    facetsPage: (offset: number) =>
      ready.value ? loadFacets(Math.max(0, offset)) : Promise.resolve(),
    async chooseDimension(dimension: ClassificationDimension | null) {
      if (!ready.value) return
      state.value = {
        ...state.value,
        facetDimension: dimension,
        facetSearch: '',
        facetDraft: [
          ...(state.value.filters.find((filter) => filter.dimension === dimension)?.values ?? [])
        ],
        facets: null
      }
      if (dimension) await loadFacets()
    },
    async searchFacets(value: string) {
      if (!ready.value) return
      state.value = { ...state.value, facetSearch: value.trim().slice(0, 512) }
      await loadFacets()
    },
    toggleFacet(value: string) {
      if (!ready.value || !state.value.facets?.items.some((item) => item.value === value)) return
      const values = state.value.facetDraft
      if (!values.includes(value) && values.length >= 64) return
      state.value = {
        ...state.value,
        facetDraft: values.includes(value)
          ? values.filter((item) => item !== value)
          : [...values, value]
      }
    },
    removeFacetDraft(value: string) {
      if (ready.value)
        state.value = {
          ...state.value,
          facetDraft: state.value.facetDraft.filter((item) => item !== value)
        }
    },
    async applyFacets() {
      const s = state.value
      if (!ready.value || !s.facetDimension) return
      clearMembers()
      state.value = {
        ...state.value,
        filters: [
          ...s.filters.filter((item) => item.dimension !== s.facetDimension),
          ...(s.facetDraft.length
            ? [{ dimension: s.facetDimension, values: [...s.facetDraft] }]
            : [])
        ]
      }
      await loadResults()
    },
    async removeFilter(dimension: ClassificationDimension) {
      if (!ready.value) return
      clearMembers()
      state.value = {
        ...state.value,
        filters: state.value.filters.filter((item) => item.dimension !== dimension),
        ...(state.value.facetDimension === dimension ? { facetDraft: [] } : {})
      }
      await loadResults()
    },
    async selectEntity(item: GenreBrowseItem) {
      if (!ready.value || !state.value.page?.items.some((row) => row.id === item.id)) return
      clearMembers()
      state.value = { ...state.value, selectedEntity: { id: item.id, title: item.title } }
      await loadMembers()
    },
    async showEvidence(member: GenreBrowseMember, collection = false) {
      const currentMember = state.value.members?.items.find(
        (row) => row.sourceId === member.sourceId
      )
      if (!ready.value || !currentMember) return
      const target = collection ? currentMember.collectionTarget : currentMember.sourceTarget
      if (!target) return
      const summary = collection
        ? currentMember.collectionClassification?.genres
        : currentMember.sourceClassification.genres
      state.value = {
        ...state.value,
        evidenceTarget: target,
        evidenceLabel: `${genreProviderLabel(currentMember.provider)} · ${currentMember.title} · ${collection ? '专辑分类' : '歌曲分类'}`,
        evidence: null,
        draftGenreIds: null,
        draftNames: Object.fromEntries(
          (summary?.items ?? []).map((genre) => [genre.id, genre.name])
        ),
        notice: ''
      }
      await loadEvidence()
    },
    addGenre(node: Pick<MusicGenreNode, 'id' | 'name'>) {
      const s = state.value
      if (
        !ready.value ||
        !s.evidenceTarget ||
        s.draftGenreIds === null ||
        s.draftGenreIds.includes(node.id) ||
        s.draftGenreIds.length >= 200
      )
        return
      state.value = {
        ...s,
        draftGenreIds: [...s.draftGenreIds, node.id],
        draftNames: { ...s.draftNames, [node.id]: node.name },
        notice: ''
      }
    },
    removeGenre(id: string) {
      if (ready.value && state.value.draftGenreIds)
        state.value = {
          ...state.value,
          draftGenreIds: state.value.draftGenreIds.filter((genre) => genre !== id),
          notice: ''
        }
    },
    saveOverride: () =>
      state.value.draftGenreIds !== null
        ? override([...state.value.draftGenreIds])
        : Promise.resolve(),
    clearOverride: () => override([]),
    resetOverride: () => override(null),
    setProviderPreference(value: 'default' | 'local' | 'streaming') {
      if (!state.value.playingId) state.value = { ...state.value, providerPreference: value }
    },
    async playUnified(member: GenreBrowseMember) {
      const s = state.value
      if (
        !api.playUnified ||
        !ready.value ||
        s.playingId ||
        !s.token ||
        !s.selectedEntity ||
        !s.members?.items.some((row) => row.sourceId === member.sourceId)
      )
        return
      const request = begin('unified'),
        context = generation
      state.value = { ...s, playingId: member.sourceId, playError: '', unifiedResult: null }
      try {
        const providers = s.page?.providers ?? []
        const providerOrder =
          s.providerPreference === 'local'
            ? ['local']
            : s.providerPreference === 'streaming' &&
                providers.filter((id) => id !== 'local').length <= 128
              ? providers.filter((id) => id !== 'local')
              : undefined
        const result = await api.playUnified(
          {
            sourceId: member.sourceId,
            revision: s.token.catalogRevision,
            ...(providerOrder ? { providerOrder } : {}),
            scope: { ...filter(), entityId: s.selectedEntity.id, token: s.token }
          },
          request.signal
        )
        if (current('unified', request) && generation === context && !request.signal.aborted)
          state.value = { ...state.value, unifiedResult: result }
      } catch (error) {
        if (current('unified', request) && generation === context && !request.signal.aborted) {
          if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'STALE_REVISION'
          )
            invalidate()
          state.value = { ...state.value, playError: message(error) }
        }
      } finally {
        if (current('unified', request) && generation === context)
          state.value = { ...state.value, playingId: null }
      }
    },
    async play(member: GenreBrowseMember) {
      const s = state.value
      const currentMember = s.members?.items.find((row) => row.sourceId === member.sourceId)
      if (
        !ready.value ||
        s.playingId ||
        !s.token ||
        !currentMember ||
        currentMember.availability === 'missing'
      )
        return
      const context = generation
      state.value = { ...s, playingId: member.sourceId, playError: '', unifiedResult: null }
      try {
        await api.play(member.sourceId, s.token.catalogRevision)
      } catch (error) {
        if (!disposed && generation === context)
          state.value = {
            ...state.value,
            playError: `此来源播放失败：${message(error)}。可明确选择其他来源重试。`
          }
      } finally {
        if (!disposed && generation === context) state.value = { ...state.value, playingId: null }
      }
    },
    dispose() {
      disposed = true
      generation++
      clearExpiry()
      abort()
    }
  }
}
