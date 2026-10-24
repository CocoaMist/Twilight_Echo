import { computed, shallowRef, watch } from 'vue'
import {
  sameFocusToken,
  type MusicFocusCreate,
  type MusicFocusDelete,
  type MusicFocusFacetsPage,
  type MusicFocusFacetsQuery,
  type MusicFocusFacet,
  type MusicFocusPage,
  type MusicFocusPageQuery,
  type MusicFocusPlay,
  type MusicFocusPlayResult,
  type MusicFocusPlayStatus,
  type MusicFocusQuery,
  type MusicFocusRename,
  type MusicFocusSaved,
  type MusicFocusSavedListQuery,
  type MusicFocusSavedPage,
  type MusicFocusUpdate
} from '../../../../shared/musicFocus.ts'
import type { GenrePage, GenreQuery } from '../../../../shared/musicGenres.ts'
import type { MusicTagsListPage, MusicTagsListQuery } from '../../../../shared/musicTags.ts'
import {
  changeFocusNode,
  compileFocusDraft,
  focusDraft,
  newFocusNode,
  removeFocusNode,
  type FocusDraft,
  type FocusDraftKind
} from './musicFocusDraft.ts'

export const FOCUS_PAGE_SIZE = 20
export const FOCUS_SAVED_PAGE_SIZE = 10
export const validFocusName = (value: string) =>
  !!value.trim() && value.length <= 80 && !value.includes('\0')
export const FOCUS_FACETS: Array<{ value: MusicFocusFacet; label: string }> = [
  { value: 'genre', label: '流派' },
  { value: 'provider', label: '来源' },
  { value: 'personalRating', label: '个人星级' },
  { value: 'preference', label: '收藏状态' },
  { value: 'releaseYear', label: '具体发行年' },
  { value: 'projectYear', label: '项目首发年' },
  { value: 'language', label: '歌曲语言' },
  { value: 'region', label: '发行地区' },
  { value: 'albumType', label: '专辑类型' },
  { value: 'versionAttribute', label: '版本属性' },
  { value: 'format', label: '格式' },
  { value: 'bitDepth', label: '位深' },
  { value: 'sampleRate', label: '采样率' },
  { value: 'management', label: '管理状态' }
]
export interface MusicFocusApi {
  query(query: MusicFocusPageQuery, signal: AbortSignal): Promise<MusicFocusPage>
  facets(query: MusicFocusFacetsQuery, signal: AbortSignal): Promise<MusicFocusFacetsPage>
  saved(query: MusicFocusSavedListQuery, signal: AbortSignal): Promise<MusicFocusSavedPage>
  create(query: MusicFocusCreate): Promise<unknown>
  rename(query: MusicFocusRename): Promise<unknown>
  update(query: MusicFocusUpdate): Promise<unknown>
  delete(query: MusicFocusDelete): Promise<unknown>
  play(query: MusicFocusPlay, signal: AbortSignal, requestId: string): Promise<MusicFocusPlayResult>
  playStatus(
    query: { requestId: string; epoch: string },
    signal: AbortSignal
  ): Promise<MusicFocusPlayStatus>
  genres(query: GenreQuery, signal: AbortSignal): Promise<GenrePage>
  tags(query: MusicTagsListQuery, signal: AbortSignal): Promise<MusicTagsListPage>
  now?(): number
}
type SavedIntent =
  | { kind: 'create'; name: string; query: MusicFocusQuery }
  | { kind: 'rename'; id: string; name: string }
  | { kind: 'update'; id: string; query: MusicFocusQuery }
  | { kind: 'delete'; id: string; name: string }
export const focusIntentLabel = (intent: SavedIntent) =>
  intent.kind === 'create'
    ? `创建“${intent.name}”`
    : intent.kind === 'rename'
      ? `重命名为“${intent.name}”`
      : intent.kind === 'delete'
        ? `删除“${intent.name}”`
        : '更新保存的条件'
interface ChoiceState {
  nodeId: string
  kind: 'genre' | 'tag' | 'provider'
  search: string
  loading: boolean
  page: { offset: number; total: number; items: Array<{ id: string; name: string }> } | null
  error: string
}
interface State {
  opened: boolean
  draft: FocusDraft
  page: MusicFocusPage | null
  facets: MusicFocusFacetsPage | null
  facet: MusicFocusFacet
  evaluated: MusicFocusQuery | null
  blocked: boolean
  loading: boolean
  error: string
  notice: string
  saved: MusicFocusSavedPage | null
  savedSearch: string
  savedLoading: boolean
  savedBlocked: boolean
  savedError: string
  selectedId: string | null
  selectedName: string
  selectedSaved: MusicFocusSaved | null
  name: string
  renameId: string | null
  renameName: string
  deleteItem: MusicFocusSaved | null
  intent: SavedIntent | null
  saving: boolean
  playing: boolean
  playUncertain: boolean
  playReceipt: { requestId: string; epoch: string } | null
  playStatus: MusicFocusPlayStatus | null
  playChecking: boolean
  playNotice: string
  playError: string
  choice: ChoiceState | null
}
const initial = (): State => ({
  opened: false,
  draft: focusDraft(),
  page: null,
  facets: null,
  facet: 'genre',
  evaluated: null,
  blocked: false,
  loading: false,
  error: '',
  notice: '',
  saved: null,
  savedSearch: '',
  savedLoading: false,
  savedBlocked: false,
  savedError: '',
  selectedId: null,
  selectedName: '',
  selectedSaved: null,
  name: '',
  renameId: null,
  renameName: '',
  deleteItem: null,
  intent: null,
  saving: false,
  playing: false,
  playUncertain: false,
  playReceipt: null,
  playStatus: null,
  playChecking: false,
  playNotice: '',
  playError: '',
  choice: null
})
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const stale = (error: unknown) =>
  ['STALE_REVISION', 'STALE_EPOCH'].includes((error as { code?: string })?.code ?? '')

/** Editing never evaluates implicitly; results, counts and playback share the last accepted token. */
export function createMusicFocusView(api: MusicFocusApi) {
  const state = shallowRef(initial()),
    compiled = computed(() => compileFocusDraft(state.value.draft)),
    editable = computed(() => !state.value.saving),
    ready = computed(
      () =>
        !!state.value.page && !state.value.loading && !state.value.blocked && !state.value.saving
    ),
    savedReady = computed(
      () =>
        !!state.value.saved &&
        !state.value.savedLoading &&
        !state.value.savedBlocked &&
        !state.value.saving
    )
  let disposed = false,
    generation = 0,
    context = '',
    initialized = false
  let coreEpoch: string | null = null
  let reading: AbortController | null = null,
    savedReading: AbortController | null = null,
    playing: AbortController | null = null,
    choosing: AbortController | null = null,
    reconciling: AbortController | null = null
  let expiry: ReturnType<typeof setTimeout> | undefined
  const now = () => api.now?.() ?? Date.now()
  function clearExpiry() {
    if (expiry) clearTimeout(expiry)
    expiry = undefined
  }
  function abortReads() {
    reading?.abort()
    reading = null
    clearExpiry()
  }
  function cancelPlay() {
    if (!playing) return
    playing.abort()
    playing = null
    state.value = {
      ...state.value,
      playing: false,
      playUncertain: true,
      playStatus: null,
      playNotice: '已请求取消准备，请查询本次播放请求的提交结果。'
    }
  }
  function withdraw() {
    abortReads()
    cancelPlay()
    state.value = { ...state.value, page: null, facets: null, evaluated: null, loading: false }
  }
  function invalidate(epoch = false) {
    if (disposed || !initialized) return
    if (epoch) {
      generation++
      reconciling?.abort()
      reconciling = null
    }
    withdraw()
    savedReading?.abort()
    savedReading = null
    choosing?.abort()
    choosing = null
    state.value = {
      ...state.value,
      blocked: true,
      error: '',
      saved: null,
      selectedSaved: null,
      savedBlocked: true,
      savedLoading: false,
      deleteItem: null,
      choice: null,
      saving: epoch ? false : state.value.saving,
      ...(epoch
        ? {
            playChecking: false,
            playStatus: null,
            playUncertain: state.value.playUncertain || !!state.value.playReceipt
          }
        : {})
    }
  }
  function armExpiry() {
    clearExpiry()
    const expiresAt = state.value.page?.token.expiresAt
    if (expiresAt != null)
      expiry = setTimeout(
        () => {
          if (!disposed) invalidate()
        },
        Math.max(0, Math.min(2_147_483_647, expiresAt - now()))
      )
  }
  async function evaluate(offset = 0, fresh = true) {
    if (disposed || !initialized || state.value.saving || !compiled.value.query) return
    if (!fresh && !ready.value) return
    const query = fresh ? compiled.value.query : state.value.evaluated!,
      token = fresh ? undefined : state.value.page!.token,
      request = new AbortController(),
      turn = generation
    abortReads()
    cancelPlay()
    reading = request
    state.value = {
      ...state.value,
      loading: true,
      page: null,
      facets: null,
      evaluated: null,
      blocked: false,
      error: '',
      notice: ''
    }
    const active = () => !disposed && reading === request && turn === generation
    try {
      const page = await api.query(
        { query, offset, limit: FOCUS_PAGE_SIZE, ...(token ? { token } : {}) },
        request.signal
      )
      if (!active()) return
      if (token && !sameFocusToken(page.token, token))
        throw Object.assign(new Error('查询快照已变化'), { code: 'STALE_REVISION' })
      const facets = await api.facets(
        { query, token: page.token, facet: state.value.facet, offset: 0, limit: FOCUS_PAGE_SIZE },
        request.signal
      )
      if (!active()) return
      if (
        !sameFocusToken(facets.token, page.token) ||
        (page.token.expiresAt != null && page.token.expiresAt <= now())
      )
        throw Object.assign(new Error('查询快照已变化'), { code: 'STALE_REVISION' })
      state.value = {
        ...state.value,
        page,
        facets,
        evaluated: structuredClone(query),
        loading: false
      }
      reading = null
      armExpiry()
    } catch (error) {
      if (!active()) return
      reading = null
      state.value = {
        ...state.value,
        page: null,
        facets: null,
        evaluated: null,
        loading: false,
        blocked: true,
        error: stale(error) ? '查询依据已变化，请刷新结果。' : `Focus 读取失败：${message(error)}`
      }
    }
  }
  async function readSaved(offset = 0, fresh = true) {
    if (disposed || !initialized || state.value.saving || (!fresh && !savedReady.value)) return
    savedReading?.abort()
    const request = new AbortController(),
      turn = generation,
      revision = fresh ? undefined : state.value.saved!.savedRevision
    savedReading = request
    state.value = {
      ...state.value,
      savedLoading: true,
      savedError: '',
      savedBlocked: false,
      saved: null,
      selectedSaved: null
    }
    const active = () => !disposed && savedReading === request && turn === generation
    try {
      const page = await api.saved(
        {
          search: state.value.savedSearch,
          offset,
          limit: FOCUS_SAVED_PAGE_SIZE,
          ...(revision == null ? {} : { savedRevision: revision })
        },
        request.signal
      )
      if (!active()) return
      if (revision != null && page.savedRevision !== revision)
        throw Object.assign(new Error('保存查询列表已变化'), { code: 'STALE_REVISION' })
      const selectedSaved = page.items.find((item) => item.id === state.value.selectedId) ?? null
      state.value = {
        ...state.value,
        saved: page,
        savedLoading: false,
        selectedSaved,
        selectedName: selectedSaved?.name ?? state.value.selectedName
      }
      savedReading = null
    } catch (error) {
      if (!active()) return
      savedReading = null
      state.value = {
        ...state.value,
        saved: null,
        savedLoading: false,
        selectedSaved: null,
        savedBlocked: true,
        savedError: `保存查询读取失败：${message(error)}`
      }
    }
  }
  const currentSaved = (id: string) =>
    state.value.saved?.items.find((item) => item.id === id) ??
    (state.value.selectedSaved?.id === id ? state.value.selectedSaved : null)
  const canSaveIntent = computed(
    () =>
      savedReady.value &&
      !!state.value.intent &&
      (state.value.intent.kind === 'create' || !!currentSaved(state.value.intent.id))
  )
  async function saveIntent() {
    const intent = state.value.intent
    if (!intent || !canSaveIntent.value) return
    const turn = generation,
      item = intent.kind === 'create' ? null : currentSaved(intent.id)!
    withdraw()
    savedReading?.abort()
    savedReading = null
    state.value = { ...state.value, saving: true, savedError: '', notice: '', deleteItem: null }
    try {
      if (intent.kind === 'create')
        await api.create({
          name: intent.name,
          query: intent.query,
          savedRevision: state.value.saved!.savedRevision
        })
      else if (intent.kind === 'rename')
        await api.rename({ id: intent.id, name: intent.name, nameRevision: item!.nameRevision })
      else if (intent.kind === 'update')
        await api.update({ id: intent.id, query: intent.query, queryRevision: item!.queryRevision })
      else
        await api.delete({
          id: intent.id,
          nameRevision: item!.nameRevision,
          queryRevision: item!.queryRevision
        })
      if (disposed || turn !== generation) return
      state.value = {
        ...state.value,
        saving: false,
        intent: null,
        renameId: null,
        renameName: '',
        name: intent.kind === 'create' ? '' : state.value.name,
        ...(intent.kind === 'delete' && state.value.selectedId === intent.id
          ? { selectedId: null, selectedName: '', selectedSaved: null }
          : {}),
        notice: '查询已保存；下次打开按当前音乐库重新计算。'
      }
      await readSaved()
    } catch (error) {
      if (disposed || turn !== generation) return
      state.value = {
        ...state.value,
        saving: false,
        saved: null,
        selectedSaved: null,
        savedBlocked: true,
        savedError: stale(error)
          ? '保存查询已变化，条件和操作已保留。请重新读取并核对目标。'
          : `保存结果未确认：${message(error)}。条件和操作已保留，请重新读取核对。`
      }
    }
  }
  function perform(intent: SavedIntent) {
    if (!savedReady.value) return Promise.resolve()
    state.value = { ...state.value, intent }
    return saveIntent()
  }
  async function play(sourceId?: string) {
    const s = state.value
    if (
      !ready.value ||
      !s.page?.total ||
      !s.evaluated ||
      s.playing ||
      s.playUncertain ||
      s.evaluated.scope === 'catalog'
    )
      return
    if (!coreEpoch) {
      state.value = { ...s, playError: 'Core 尚未就绪，请重新连接后播放。' }
      return
    }
    if (sourceId && !s.page.items.some((item) => item.sourceId === sourceId && item.playable))
      return
    if (s.page.token.expiresAt != null && s.page.token.expiresAt <= now()) {
      invalidate()
      return
    }
    const request = new AbortController(),
      turn = generation,
      receipt = { requestId: crypto.randomUUID(), epoch: coreEpoch }
    reconciling?.abort()
    reconciling = null
    playing = request
    state.value = {
      ...s,
      playing: true,
      playError: '',
      playNotice: '',
      playReceipt: receipt,
      playStatus: null,
      playChecking: false
    }
    try {
      const result = await api.play(
        { query: s.evaluated, token: s.page.token, ...(sourceId ? { sourceId } : {}) },
        request.signal,
        receipt.requestId
      )
      if (disposed || playing !== request || turn !== generation) return
      playing = null
      state.value = {
        ...state.value,
        playing: false,
        playReceipt: null,
        playStatus: null,
        playNotice: `已播放 Focus 集合：${result.total} 首，从第 ${result.selectedIndex + 1} 首开始。`
      }
    } catch (error) {
      if (disposed || playing !== request || turn !== generation) return
      playing = null
      if (stale(error)) invalidate()
      state.value = {
        ...state.value,
        playing: false,
        playUncertain: true,
        playError: stale(error)
          ? '查询依据已变化，请先查询本次播放结果，再刷新条件。'
          : `播放结果未确认：${message(error)}。请查询本次播放请求的提交结果。`
      }
    }
  }
  async function reconcilePlay() {
    const receipt = state.value.playReceipt
    if (disposed || !receipt || state.value.playChecking || playing) return
    const request = new AbortController(),
      turn = generation
    reconciling = request
    state.value = { ...state.value, playChecking: true, playError: '' }
    const active = () =>
      !disposed &&
      reconciling === request &&
      turn === generation &&
      state.value.playReceipt?.requestId === receipt.requestId &&
      state.value.playReceipt?.epoch === receipt.epoch
    try {
      const status = await api.playStatus(receipt, request.signal)
      if (!active()) return
      reconciling = null
      if (status.status === 'pending') {
        state.value = {
          ...state.value,
          playChecking: false,
          playStatus: status,
          playUncertain: true,
          playNotice: '本次播放请求仍在处理中，请稍后再次查询。'
        }
      } else if (status.status === 'not_committed') {
        state.value = {
          ...state.value,
          playChecking: false,
          playStatus: status,
          playUncertain: false,
          playReceipt: null,
          playNotice: '本次播放未提交，原队列未被此请求替换。'
        }
      } else if (status.status === 'committed') {
        const result = status.result
        state.value = {
          ...state.value,
          playChecking: false,
          playStatus: status,
          playUncertain: status.playback === 'pending',
          playReceipt: status.playback === 'pending' ? receipt : null,
          playNotice: `本次 Focus 队列已提交：${result.total} 首，从第 ${result.selectedIndex + 1} 首开始。${
            status.playback === 'confirmed'
              ? '播放已启动。'
              : status.playback === 'failed'
                ? '播放状态未确认，请查看当前播放状态；不要重复提交本次请求。'
                : '播放启动仍在处理中，可再次查询。'
          }`
        }
      } else {
        state.value = {
          ...state.value,
          playChecking: false,
          playStatus: status,
          playUncertain: true,
          playNotice: '当前 Core 无法确定本次请求是否提交。请人工核对当前队列后，再决定下一次操作。'
        }
      }
    } catch (error) {
      if (!active()) return
      reconciling = null
      state.value = {
        ...state.value,
        playChecking: false,
        playUncertain: true,
        playError: `播放结果对账失败：${message(error)}。请再次查询。`
      }
    }
  }
  function edit(change: (draft: FocusDraft) => FocusDraft) {
    if (!editable.value) return
    withdraw()
    choosing?.abort()
    choosing = null
    state.value = {
      ...state.value,
      draft: change(state.value.draft),
      blocked: false,
      error: '',
      notice: '',
      choice: null
    }
  }
  async function lookup(
    nodeId: string,
    kind: 'genre' | 'tag' | 'provider',
    search = '',
    offset = 0
  ) {
    if (disposed || !editable.value) return
    choosing?.abort()
    const request = new AbortController(),
      turn = generation
    choosing = request
    state.value = {
      ...state.value,
      choice: { nodeId, kind, search, page: null, loading: true, error: '' }
    }
    try {
      const result =
        kind === 'genre'
          ? await api.genres({ search, offset, limit: FOCUS_PAGE_SIZE }, request.signal)
          : kind === 'tag'
            ? await api.tags({ search, offset, limit: FOCUS_PAGE_SIZE }, request.signal)
            : await api.facets(
                {
                  query: {
                    version: 1,
                    entity: state.value.draft.entity,
                    scope: state.value.draft.scope
                  },
                  facet: 'provider',
                  offset,
                  limit: FOCUS_PAGE_SIZE
                },
                request.signal
              )
      const page =
        'facet' in result
          ? { ...result, items: result.items.map((item) => ({ id: item.value, name: item.label })) }
          : result
      if (disposed || choosing !== request || turn !== generation) return
      choosing = null
      state.value = {
        ...state.value,
        choice: { nodeId, kind, search, page, loading: false, error: '' }
      }
    } catch (error) {
      if (disposed || choosing !== request || turn !== generation) return
      choosing = null
      state.value = {
        ...state.value,
        choice: { nodeId, kind, search, page: null, loading: false, error: message(error) }
      }
    }
  }
  return {
    state,
    compiled,
    editable,
    ready,
    savedReady,
    canSaveIntent,
    evaluate: () => evaluate(),
    page: (offset: number) => evaluate(offset, false),
    readSaved: () => readSaved(),
    savedPage: (offset: number) => readSaved(offset, false),
    async toggle() {
      if (state.value.saving) return
      state.value = { ...state.value, opened: !state.value.opened }
      if (state.value.opened && !state.value.saved) await readSaved()
    },
    setContext(value: string) {
      if (initialized && value === context) return
      if (!initialized) {
        initialized = true
        context = value
        return
      }
      context = value
      invalidate(true)
    },
    setEpoch(value: string | null) {
      if (coreEpoch === value) return
      const changed = coreEpoch !== null
      coreEpoch = value
      if (changed) invalidate(true)
    },
    invalidate,
    edit,
    setField(id: string, key: string, value: string | boolean) {
      edit((draft) => ({
        ...draft,
        root: changeFocusNode(draft.root, id, (node) => ({
          ...node,
          fields: { ...node.fields, [key]: value }
        }))
      }))
    },
    setKind(id: string, kind: FocusDraftKind) {
      edit((draft) => ({
        ...draft,
        root: changeFocusNode(draft.root, id, (node) => ({
          ...newFocusNode(kind),
          id: node.id,
          ...(['all', 'any'].includes(kind) && ['all', 'any'].includes(node.kind)
            ? { children: node.children }
            : {})
        }))
      }))
    },
    add(id: string, kind: FocusDraftKind = 'source') {
      edit((draft) => ({
        ...draft,
        root: changeFocusNode(draft.root, id, (node) => ({
          ...node,
          children: [...node.children, newFocusNode(kind)]
        }))
      }))
    },
    remove(id: string) {
      edit((draft) => ({ ...draft, root: removeFocusNode(draft.root, id) }))
    },
    lookup,
    choose(id: string, item: { id: string; name: string }) {
      edit((draft) => ({
        ...draft,
        root: changeFocusNode(draft.root, id, (node) => ({
          ...node,
          fields:
            node.kind === 'source'
              ? { ...node.fields, provider: item.id }
              : { ...node.fields, id: item.id, label: item.name }
        }))
      }))
    },
    async chooseFacet(facet: MusicFocusFacet, offset = 0) {
      if (!ready.value) {
        state.value = { ...state.value, facet }
        return
      }
      const s = state.value,
        request = new AbortController(),
        turn = generation
      abortReads()
      reading = request
      state.value = { ...s, facet, facets: null, loading: true }
      try {
        const page = await api.facets(
          { query: s.evaluated!, token: s.page!.token, facet, offset, limit: FOCUS_PAGE_SIZE },
          request.signal
        )
        if (disposed || reading !== request || turn !== generation) return
        if (!sameFocusToken(page.token, s.page!.token))
          throw Object.assign(new Error('查询快照已变化'), { code: 'STALE_REVISION' })
        reading = null
        state.value = { ...state.value, loading: false, facets: page }
        armExpiry()
      } catch (error) {
        if (disposed || reading !== request || turn !== generation) return
        invalidate()
        state.value = { ...state.value, error: `分面读取失败：${message(error)}` }
      }
    },
    setName(name: string) {
      state.value = { ...state.value, name }
    },
    create() {
      return compiled.value.query && validFocusName(state.value.name)
        ? perform({
            kind: 'create',
            name: state.value.name,
            query: structuredClone(compiled.value.query)
          })
        : Promise.resolve()
    },
    async openSaved(item: MusicFocusSaved) {
      if (!savedReady.value) return
      edit(() => focusDraft(item.query))
      state.value = {
        ...state.value,
        selectedId: item.id,
        selectedName: item.name,
        selectedSaved: item,
        renameId: null,
        deleteItem: null
      }
      await evaluate()
    },
    closeSaved() {
      if (editable.value)
        state.value = { ...state.value, selectedId: null, selectedName: '', selectedSaved: null }
    },
    update() {
      return compiled.value.query && state.value.selectedSaved
        ? perform({
            kind: 'update',
            id: state.value.selectedSaved.id,
            query: structuredClone(compiled.value.query)
          })
        : Promise.resolve()
    },
    startRename(item: MusicFocusSaved) {
      if (savedReady.value)
        state.value = { ...state.value, renameId: item.id, renameName: item.name, deleteItem: null }
    },
    setRenameName(renameName: string) {
      state.value = { ...state.value, renameName }
    },
    rename() {
      return state.value.renameId && validFocusName(state.value.renameName)
        ? perform({ kind: 'rename', id: state.value.renameId, name: state.value.renameName })
        : Promise.resolve()
    },
    cancelRename() {
      if (editable.value) state.value = { ...state.value, renameId: null, renameName: '' }
    },
    requestDelete(item: MusicFocusSaved) {
      if (savedReady.value) state.value = { ...state.value, deleteItem: item, renameId: null }
    },
    cancelDelete() {
      if (editable.value) state.value = { ...state.value, deleteItem: null }
    },
    confirmDelete() {
      const item = state.value.deleteItem
      return item ? perform({ kind: 'delete', id: item.id, name: item.name }) : Promise.resolve()
    },
    setSavedSearch(savedSearch: string) {
      savedReading?.abort()
      savedReading = null
      state.value = {
        ...state.value,
        savedSearch,
        saved: null,
        selectedSaved: null,
        savedLoading: false
      }
    },
    saveIntent,
    discardIntent() {
      if (editable.value) state.value = { ...state.value, intent: null }
    },
    play,
    cancelPlay,
    reconcilePlay,
    acknowledgePlay() {
      if (state.value.playStatus?.status !== 'unknown' || state.value.playChecking) return
      state.value = {
        ...state.value,
        playUncertain: false,
        playReceipt: null,
        playStatus: null,
        playError: '',
        playNotice: '当前 Core 无法确认上次提交；已完成人工队列核对。'
      }
    },
    dispose() {
      disposed = true
      generation++
      abortReads()
      savedReading?.abort()
      playing?.abort()
      choosing?.abort()
      reconciling?.abort()
    }
  }
}
export function observeMusicFocusView(
  view: ReturnType<typeof createMusicFocusView>,
  input: {
    scope(): string
    snapshot(): {
      epoch: string
      focusRevision?: number | null
      focusHistoryRevision?: number | null
      catalogRevision?: number | null
      libraryRevision?: number | null
      genresRevision?: number | null
      classificationMetadataRevision?: number | null
      ratingsRevision?: number | null
      preferencesRevision?: number | null
      tagsRevision?: number | null
      tagsLinkRevision?: number | null
      entityMetadataRevision?: number | null
      pluginsRevision?: number | null
      settingsRevision?: number | null
    } | null
  }
) {
  const fields = [
    'epoch',
    'focusRevision',
    'focusHistoryRevision',
    'catalogRevision',
    'libraryRevision',
    'genresRevision',
    'classificationMetadataRevision',
    'ratingsRevision',
    'preferencesRevision',
    'tagsRevision',
    'tagsLinkRevision',
    'entityMetadataRevision',
    'pluginsRevision',
    'settingsRevision'
  ] as const
  const known = Array<boolean>(fields.length + 1).fill(false)
  let initialized = false
  return watch(
    () => [input.scope(), ...fields.map((key) => input.snapshot()?.[key])],
    (values, previous) => {
      const changed = values.map((value, index) => {
        const change = known[index] && value !== previous?.[index]
        if (value != null) known[index] = true
        return change
      })
      view.setEpoch(input.snapshot()?.epoch ?? null)
      if (!initialized || changed[0]) {
        initialized = true
        view.setContext(String(values[0]))
      } else if (changed.slice(2).some(Boolean)) view.invalidate()
    },
    { immediate: true, flush: 'sync' }
  )
}
