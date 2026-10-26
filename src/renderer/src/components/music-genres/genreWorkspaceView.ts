import { computed, shallowRef } from 'vue'
import type {
  GenreEdit,
  GenreMap,
  GenreMutationResult,
  GenrePage,
  GenreQuery,
  GenreUnmappedItem,
  GenreUnmappedPage,
  GenreUnmappedQuery,
  MusicGenreNode
} from '../../../../shared/musicGenres.ts'

export const GENRE_WORKSPACE_PAGE_SIZE = 20
export interface GenreDraft {
  mode: 'create' | 'update' | 'createMap'
  genreId?: string
  name: string
  nameEn: string
  parentId: string | null
  parentLabel: string
}
interface State {
  opened: boolean
  tree: GenrePage | null
  unmapped: GenreUnmappedPage | null
  revision: number | null
  treeOffset: number
  unmappedOffset: number
  breadcrumbs: Array<{ id: string; name: string }>
  search: string
  rawSearch: string
  includeIgnored: boolean
  loadingTree: boolean
  loadingUnmapped: boolean
  treeError: string
  unmappedError: string
  saving: boolean
  blocked: boolean
  error: string
  notice: string
  draft: GenreDraft | null
  pickingParent: boolean
  selectedRaw: GenreUnmappedItem | null
  mapTarget: MusicGenreNode | null
}
const empty = (): State => ({
  opened: false,
  tree: null,
  unmapped: null,
  revision: null,
  treeOffset: 0,
  unmappedOffset: 0,
  breadcrumbs: [],
  search: '',
  rawSearch: '',
  includeIgnored: false,
  loadingTree: false,
  loadingUnmapped: false,
  treeError: '',
  unmappedError: '',
  saving: false,
  blocked: false,
  error: '',
  notice: '',
  draft: null,
  pickingParent: false,
  selectedRaw: null,
  mapTarget: null
})
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
const sameRaw = (a: GenreUnmappedItem, b: GenreUnmappedItem) =>
  a.provider === b.provider && a.normalized === b.normalized

export function createGenreWorkspaceView(api: {
  tree(query: GenreQuery, signal: AbortSignal): Promise<GenrePage>
  unmapped(query: GenreUnmappedQuery, signal: AbortSignal): Promise<GenreUnmappedPage>
  edit(request: GenreEdit): Promise<GenreMutationResult>
  map(request: GenreMap): Promise<GenreMutationResult>
  changed(): void
}) {
  const state = shallowRef<State>(empty())
  let disposed = false,
    generation = 0,
    scope = ''
  let treeRequest: AbortController | null = null,
    rawRequest: AbortController | null = null
  const busy = computed(
    () => state.value.saving || state.value.loadingTree || state.value.loadingUnmapped
  )
  const ready = computed(
    () =>
      state.value.opened &&
      state.value.revision !== null &&
      !!state.value.tree &&
      !!state.value.unmapped &&
      !busy.value &&
      !state.value.blocked &&
      !state.value.treeError &&
      !state.value.unmappedError
  )
  const canSave = computed(
    () =>
      ready.value &&
      !!state.value.draft?.name.trim() &&
      !!state.value.draft.nameEn.trim() &&
      (state.value.draft.mode !== 'createMap' || !!state.value.selectedRaw)
  )
  const canMap = computed(() => ready.value && !!state.value.selectedRaw && !!state.value.mapTarget)

  function abortReads() {
    treeRequest?.abort()
    rawRequest?.abort()
    treeRequest = null
    rawRequest = null
  }
  function acceptRevision(revision: number) {
    if (state.value.revision !== null && state.value.revision !== revision)
      throw new Error('分类已发生变化，请重新读取后再操作。')
    state.value = { ...state.value, revision }
  }
  async function loadTree(offset = state.value.treeOffset) {
    if (disposed || !state.value.opened) return
    treeRequest?.abort()
    const request = new AbortController()
    treeRequest = request
    const current = state.value
    state.value = { ...current, loadingTree: true, treeError: '' }
    try {
      const page = await api.tree(
        {
          ...(current.search
            ? { search: current.search }
            : { parentId: current.breadcrumbs.at(-1)?.id ?? null }),
          offset,
          limit: GENRE_WORKSPACE_PAGE_SIZE,
          ...(current.revision !== null ? { revision: current.revision } : {})
        },
        request.signal
      )
      if (disposed || treeRequest !== request) return
      acceptRevision(page.revision)
      if (offset > 0 && offset >= page.total) return loadTree(0)
      state.value = { ...state.value, tree: page, treeOffset: page.offset }
    } catch (error) {
      if (!disposed && treeRequest === request)
        state.value = { ...state.value, treeError: errorMessage(error) }
    } finally {
      if (!disposed && treeRequest === request) {
        treeRequest = null
        state.value = { ...state.value, loadingTree: false }
      }
    }
  }
  async function loadRaw(offset = state.value.unmappedOffset) {
    if (disposed || !state.value.opened) return
    rawRequest?.abort()
    const request = new AbortController()
    rawRequest = request
    const current = state.value
    state.value = { ...current, loadingUnmapped: true, unmappedError: '' }
    try {
      const page = await api.unmapped(
        {
          search: current.rawSearch,
          includeIgnored: current.includeIgnored,
          offset,
          limit: GENRE_WORKSPACE_PAGE_SIZE,
          ...(current.revision !== null ? { revision: current.revision } : {})
        },
        request.signal
      )
      if (disposed || rawRequest !== request) return
      acceptRevision(page.revision)
      if (offset > 0 && offset >= page.total) return loadRaw(0)
      const selectedRaw = state.value.selectedRaw
      state.value = {
        ...state.value,
        unmapped: page,
        unmappedOffset: page.offset,
        selectedRaw: selectedRaw
          ? (page.items.find((item) => sameRaw(item, selectedRaw)) ?? null)
          : null
      }
    } catch (error) {
      if (!disposed && rawRequest === request)
        state.value = { ...state.value, unmappedError: errorMessage(error) }
    } finally {
      if (!disposed && rawRequest === request) {
        rawRequest = null
        state.value = { ...state.value, loadingUnmapped: false }
      }
    }
  }
  async function refresh(revision: number | null = null) {
    if (disposed || !state.value.opened || state.value.saving) return
    abortReads()
    state.value = {
      ...state.value,
      revision,
      blocked: false,
      error: '',
      treeError: '',
      unmappedError: ''
    }
    await Promise.all([loadTree(), loadRaw()])
  }
  async function mutate(
    work: () => Promise<GenreMutationResult>,
    success: string,
    clearDraft: boolean
  ) {
    if (!ready.value) return
    const context = generation
    state.value = { ...state.value, saving: true, error: '', notice: '' }
    try {
      const result = await work()
      api.changed()
      if (disposed || context !== generation) return
      state.value = {
        ...state.value,
        saving: false,
        notice: success,
        draft: clearDraft ? null : state.value.draft,
        pickingParent: false,
        selectedRaw: null,
        mapTarget: null
      }
      await refresh(result.revision)
    } catch (error) {
      if (!disposed && context === generation)
        state.value = {
          ...state.value,
          saving: false,
          blocked: true,
          error: `操作未确认：${errorMessage(error)} 请重新读取并核对后再操作；输入已保留。`
        }
    }
  }
  return {
    state,
    busy,
    ready,
    canSave,
    canMap,
    observeRevision(revision: number | null | undefined) {
      if (
        disposed ||
        revision == null ||
        !state.value.opened ||
        state.value.saving ||
        state.value.revision === null ||
        state.value.revision === revision
      )
        return
      state.value = {
        ...state.value,
        blocked: true,
        error: '分类已在其他位置更新，请重新读取并核对后再操作；输入已保留。'
      }
    },
    setScope(next: string) {
      if (disposed || scope === next) return
      scope = next
      generation++
      abortReads()
      const opened = state.value.opened
      state.value = { ...empty(), opened }
      if (opened) void refresh()
    },
    async toggle() {
      if (disposed || state.value.saving) return
      const opened = !state.value.opened
      state.value = { ...state.value, opened, loadingTree: false, loadingUnmapped: false }
      if (!opened) abortReads()
      else await refresh()
    },
    refresh,
    treePage: (offset: number) => (busy.value ? Promise.resolve() : loadTree(Math.max(0, offset))),
    rawPage: (offset: number) => (busy.value ? Promise.resolve() : loadRaw(Math.max(0, offset))),
    async search(value: string) {
      if (busy.value) return
      state.value = { ...state.value, search: value.trim().slice(0, 512) }
      await loadTree(0)
    },
    async filterRaw(value: string, includeIgnored: boolean) {
      if (busy.value) return
      state.value = {
        ...state.value,
        rawSearch: value.trim().slice(0, 512),
        includeIgnored,
        selectedRaw: null,
        mapTarget: null
      }
      await loadRaw(0)
    },
    async browse(node: MusicGenreNode | null) {
      if (busy.value) return
      const breadcrumbs = !node
        ? []
        : [...(state.value.search ? [] : state.value.breadcrumbs), { id: node.id, name: node.name }]
      state.value = { ...state.value, breadcrumbs, search: '' }
      await loadTree(0)
    },
    async breadcrumb(index: number) {
      if (busy.value) return
      state.value = {
        ...state.value,
        breadcrumbs: state.value.breadcrumbs.slice(0, index + 1),
        search: ''
      }
      await loadTree(0)
    },
    select(node: MusicGenreNode) {
      if (busy.value) return
      state.value = {
        ...state.value,
        draft: {
          mode: 'update',
          genreId: node.id,
          name: node.name,
          nameEn: node.nameEn,
          parentId: node.parentId,
          parentLabel: node.parentId
            ? (state.value.breadcrumbs.find((p) => p.id === node.parentId)?.name ??
              '当前上级（未更改）')
            : '无上级（根流派）'
        },
        pickingParent: false,
        notice: ''
      }
    },
    create(forRaw = false) {
      if (!ready.value || (forRaw && !state.value.selectedRaw)) return
      const parent = state.value.breadcrumbs.at(-1)
      state.value = {
        ...state.value,
        draft: {
          mode: forRaw ? 'createMap' : 'create',
          name: forRaw ? state.value.selectedRaw!.value : '',
          nameEn: '',
          parentId: parent?.id ?? null,
          parentLabel: parent?.name ?? '无上级（根流派）'
        },
        pickingParent: false
      }
    },
    patchDraft(patch: Partial<Pick<GenreDraft, 'name' | 'nameEn'>>) {
      if (state.value.draft && !state.value.saving)
        state.value = { ...state.value, draft: { ...state.value.draft, ...patch } }
    },
    pickParent() {
      if (ready.value && state.value.draft) state.value = { ...state.value, pickingParent: true }
    },
    parentAllowed(node: MusicGenreNode) {
      const id = state.value.draft?.genreId
      return !id || (node.id !== id && !node.ancestorIds.includes(id))
    },
    setParent(node: MusicGenreNode | null) {
      if (!ready.value || !state.value.draft) return
      const id = state.value.draft.genreId
      if (node && id && (node.id === id || node.ancestorIds.includes(id))) return
      state.value = {
        ...state.value,
        draft: {
          ...state.value.draft,
          parentId: node?.id ?? null,
          parentLabel: node?.name ?? '无上级（根流派）'
        },
        pickingParent: false
      }
    },
    cancelDraft() {
      if (!state.value.saving) state.value = { ...state.value, draft: null, pickingParent: false }
    },
    selectRaw(item: GenreUnmappedItem) {
      if (!ready.value) return
      state.value = {
        ...state.value,
        selectedRaw: item,
        mapTarget: null,
        draft: state.value.draft?.mode === 'createMap' ? null : state.value.draft,
        notice: ''
      }
    },
    chooseMapTarget(node: MusicGenreNode) {
      if (ready.value && state.value.selectedRaw) state.value = { ...state.value, mapTarget: node }
    },
    save() {
      const draft = state.value.draft,
        revision = state.value.revision
      if (!canSave.value || !draft || revision === null) return Promise.resolve()
      const values = {
        name: draft.name.trim(),
        nameEn: draft.nameEn.trim(),
        parentId: draft.parentId
      }
      if (draft.mode === 'createMap') {
        const raw = state.value.selectedRaw!
        return mutate(
          () => api.map({ revision, provider: raw.provider, value: raw.value, create: values }),
          '已创建流派并映射此来源原词。',
          true
        )
      }
      const request: GenreEdit =
        draft.mode === 'update'
          ? { action: 'update', revision, genreId: draft.genreId!, ...values }
          : { action: 'create', revision, ...values }
      return mutate(
        () => api.edit(request),
        draft.mode === 'update' ? '流派层级已更新。' : '流派已创建。',
        true
      )
    },
    map() {
      if (!canMap.value) return Promise.resolve()
      const raw = state.value.selectedRaw!,
        target = state.value.mapTarget!,
        revision = state.value.revision!
      return mutate(
        () => api.map({ revision, provider: raw.provider, value: raw.value, genreId: target.id }),
        '此来源原词已映射。',
        false
      )
    },
    ignore(ignored = true) {
      const raw = state.value.selectedRaw,
        revision = state.value.revision
      if (!ready.value || !raw || revision === null) return Promise.resolve()
      return mutate(
        () =>
          api.map({ revision, provider: raw.provider, value: raw.value, genreId: null, ignored }),
        ignored ? '已忽略此来源原词，原始内容仍保留。' : '已恢复为待整理原词。',
        false
      )
    },
    dispose() {
      disposed = true
      generation++
      abortReads()
    }
  }
}
