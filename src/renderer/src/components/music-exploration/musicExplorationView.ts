import { computed, shallowRef, watch } from 'vue'
import type { MusicCreditRole } from '../../../../shared/musicCredits.ts'
import type {
  MusicExplorationDetail, MusicExplorationDetailQuery, MusicExplorationLookupQuery,
  MusicExplorationReference, MusicExplorationItem, MusicExplorationPage, MusicExplorationQuery,
  MusicExplorationRelationsQuery, MusicExplorationRelationsPage, MusicExplorationParticipationQuery,
  MusicExplorationPerformanceSave, MusicExplorationPerformanceDelete, MusicExplorationToken,
  MusicExplorationRelationItem
} from '../../../../shared/musicExploration.ts'

export const EXPLORATION_PAGE_SIZE = 12
export const explorationKindLabel = { artist: '人物', work: '作品', performance: '演绎', recording: '录音', release: '具体发行', album_project: '专辑项目' }
export const explorationRoles: Array<{ value: MusicCreditRole; label: string }> = [
  { value: 'primary_artist', label: '主艺人' }, { value: 'vocal', label: '演唱' }, { value: 'instrument', label: '演奏' },
  { value: 'composer', label: '作曲' }, { value: 'lyricist', label: '作词' }, { value: 'producer', label: '制作' },
  { value: 'arranger', label: '编曲' }, { value: 'conductor', label: '指挥' }, { value: 'mix', label: '混音' },
  { value: 'mastering', label: '母带' }, { value: 'recording_engineer', label: '录音工程' }, { value: 'other', label: '其他角色' }
]
export interface MusicExplorationApi {
  detail(query: MusicExplorationDetailQuery, signal: AbortSignal): Promise<MusicExplorationDetail>
  lookup(query: MusicExplorationLookupQuery, signal: AbortSignal): Promise<MusicExplorationDetail>
  query(query: MusicExplorationQuery, signal: AbortSignal): Promise<MusicExplorationPage>
  relations(query: MusicExplorationRelationsQuery, signal: AbortSignal): Promise<MusicExplorationRelationsPage>
  participation(query: MusicExplorationParticipationQuery, signal: AbortSignal): Promise<MusicExplorationRelationsPage>
  save(query: MusicExplorationPerformanceSave): Promise<unknown>
  delete(query: MusicExplorationPerformanceDelete): Promise<unknown>
}
type Anchor = { entityId: string } | { reference: MusicExplorationReference }
interface Editor { id?: string; workId: string; title: string; recordings: MusicExplorationItem[] }
const empty = () => ({
  detail: null as MusicExplorationDetail | null, relations: null as MusicExplorationRelationsPage | null,
  scope: 'library' as 'library' | 'catalog', role: '' as '' | MusicCreditRole,
  loading: false, saving: false, blocked: false, error: '', notice: '', trail: [] as Anchor[],
  editor: null as Editor | null, picker: null as MusicExplorationPage | null, pickerLoading: false,
  pickerSearch: '', pickerScope: 'library' as 'library' | 'catalog', deleteId: null as string | null,
  uncertain: false
})
const message = (e: unknown) => e instanceof Error ? e.message : String(e)
const sameToken = (a: MusicExplorationToken, b: MusicExplorationToken) =>
  (Object.keys(a) as Array<keyof MusicExplorationToken>).every(k => a[k] === b[k])
const stale = () => Object.assign(new Error('人物作品或音乐库已变化，请重新读取'), { code: 'STALE_REVISION' })

/** Exact IDs and typed references are the only navigation keys. Draft edits never discover relations. */
export function createMusicExplorationView(api: MusicExplorationApi) {
  const state = shallowRef(empty())
  let anchor: Anchor | null = null, context = '', generation = 0, disposed = false
  let reading: AbortController | null = null, picking: AbortController | null = null
  let expiry: ReturnType<typeof setTimeout> | null = null
  const ready = computed(() => !!state.value.detail?.entity && !state.value.loading && !state.value.saving && !state.value.blocked)
  const canSave = computed(() => ready.value && !!state.value.editor?.title.trim() && !!state.value.editor.recordings.length && !state.value.uncertain)
  function abort() { reading?.abort(); reading = null; picking?.abort(); picking = null }
  function clearExpiry() { if (expiry !== null) clearTimeout(expiry); expiry = null }
  function armExpiry(value: MusicExplorationToken) {
    clearExpiry()
    if (value.expiresAt === null) return
    const check = () => {
      if (disposed) return
      const remaining = value.expiresAt! - Date.now()
      if (remaining > 0) { expiry = setTimeout(check, Math.min(remaining, 2147483647)); return }
      invalidate()
      state.value = { ...state.value, notice: '资料许可已到期，请重新读取关系。' }
    }
    expiry = setTimeout(check, Math.max(0, Math.min(value.expiresAt - Date.now(), 2147483647)))
  }
  function token() {
    const value = state.value.detail?.token
    if (!value || state.value.blocked || (value.expiresAt !== null && value.expiresAt <= Date.now())) throw stale()
    return value
  }
  async function refresh(offset = 0, fresh = true) {
    if (!anchor || disposed || state.value.saving) return
    abort()
    const request = new AbortController(), version = generation
    reading = request
    const previous = state.value.detail
    state.value = { ...state.value, loading: true, blocked: false, error: '', picker: null }
    try {
      const detail = 'entityId' in anchor
        ? await api.detail({ entityId: anchor.entityId, ...(!fresh && previous ? { token: previous.token } : {}) }, request.signal)
        : await api.lookup({ reference: anchor.reference, ...(!fresh && previous ? { token: previous.token } : {}) }, request.signal)
      if (disposed || reading !== request || version !== generation) return
      let relations: MusicExplorationRelationsPage | null = null
      if (detail.entity) {
        const query = { entityId: detail.entity.id, token: detail.token, scope: state.value.scope, offset, limit: EXPLORATION_PAGE_SIZE,
          ...(state.value.role ? { roles: [state.value.role] } : {}) }
        relations = detail.entity.kind === 'artist'
          ? await api.participation(query, request.signal)
          : await api.relations({ ...query, direction: 'both' }, request.signal)
        if (!sameToken(detail.token, relations.token)) throw stale()
      }
      if (disposed || reading !== request || version !== generation) return
      state.value = { ...state.value, detail, relations, loading: false, blocked: false }
      armExpiry(detail.token)
    } catch (error) {
      if (!disposed && reading === request && version === generation)
        state.value = { ...state.value, detail: null, relations: null, loading: false, blocked: true, error: `读取失败：${message(error)}` }
    }
  }
  async function navigate(entity: MusicExplorationItem) {
    if (!ready.value || !anchor) return
    const trail = [...state.value.trail, anchor]
    anchor = { entityId: entity.id }; generation++; abort(); clearExpiry()
    state.value = { ...empty(), scope: state.value.scope, trail }
    await refresh()
  }
  async function collect(entityId: string, expected: MusicExplorationToken, signal: AbortSignal) {
    const items: MusicExplorationRelationItem[] = []
    for (let offset = 0; ; offset += 100) {
      const page = await api.relations({ entityId, direction: 'both', scope: 'catalog', token: expected, offset, limit: 100 }, signal)
      if (!sameToken(page.token, expected)) throw stale()
      if (page.total > 401) throw new Error('演绎关系过多，无法在此编辑')
      items.push(...page.items)
      if (offset + page.items.length >= page.total) return items
      if (!page.items.length) throw stale()
    }
  }
  async function editPerformance(id: string) {
    if (!ready.value) return
    const expected = token(), request = new AbortController(), version = generation
    reading?.abort(); reading = request
    state.value = { ...state.value, loading: true, error: '' }
    try {
      const detail = await api.detail({ entityId: id, token: expected }, request.signal)
      if (!detail.entity || !sameToken(detail.token, expected)) throw stale()
      const edges = await collect(id, expected, request.signal)
      const work = edges.find(x => x.relation.kind === 'work_performance' && x.relation.to.id === id && x.relation.origin === 'manual')
      if (!work) throw new Error('只能编辑人工建立的演绎')
      const seen = new Set<string>()
      const recordings = edges.filter(x => x.relation.kind === 'performance_recording' && x.relation.from.id === id)
        .sort((a, b) => a.relation.order - b.relation.order).filter(x => {
          if (seen.has(x.relation.id)) return false
          seen.add(x.relation.id); return true
        }).map(x => ({ ...x.relation.to, inLibrary: x.entity.inLibrary, sourceCount: x.entity.sourceCount }))
      if (recordings.length > 200) throw new Error('每个演绎最多200条录音关系')
      if (disposed || reading !== request || version !== generation) return
      state.value = { ...state.value, loading: false, editor: { id, workId: work.relation.from.id, title: detail.entity.title, recordings }, picker: null, uncertain: false }
    } catch (error) {
      if (!disposed && reading === request && version === generation)
        state.value = { ...state.value, loading: false, error: `无法编辑：${message(error)}` }
    }
  }
  async function choose(offset = 0, fresh = false) {
    if (!ready.value || !state.value.editor) return
    picking?.abort(); const request = new AbortController(); picking = request
    state.value = { ...state.value, pickerLoading: true, error: '' }
    try {
      const page = await api.query({ kinds: ['recording'], scope: state.value.pickerScope, search: state.value.pickerSearch,
        offset, limit: EXPLORATION_PAGE_SIZE, token: !fresh && state.value.picker ? state.value.picker.token : token() }, request.signal)
      if (!sameToken(page.token, token())) throw stale()
      if (!disposed && picking === request) state.value = { ...state.value, picker: page, pickerLoading: false }
    } catch (error) {
      if (!disposed && picking === request) state.value = { ...state.value, picker: null, pickerLoading: false, error: `录音列表读取失败：${message(error)}` }
    }
  }
  async function mutate(remove = false) {
    if (!ready.value || state.value.uncertain) return
    const editor = state.value.editor, deleteId = state.value.deleteId
    if (remove ? !deleteId : !canSave.value || !editor) return
    let expected: MusicExplorationToken
    try { expected = token() } catch { invalidate(); return }
    const version = generation
    abort(); state.value = { ...state.value, saving: true, error: '', notice: '' }
    try {
      if (remove) await api.delete({ id: deleteId!, revision: expected.revision })
      else await api.save({ ...(editor!.id ? { id: editor!.id } : {}), workId: editor!.workId, title: editor!.title.trim(),
        recordingIds: editor!.recordings.map(item => item.id), revision: expected.revision })
      if (disposed || version !== generation) return
      state.value = { ...state.value, saving: false, editor: null, deleteId: null, notice: remove ? '人工演绎已删除；录音仍保留。' : '人工演绎已保存。' }
      await refresh()
    } catch (error) {
      if (disposed || version !== generation) return
      const uncertain = (error as { code?: string })?.code !== 'STALE_REVISION'
      state.value = { ...state.value, saving: false, blocked: true, detail: null, relations: null, uncertain,
        error: uncertain ? `提交结果未确认：${message(error)}。请重新读取关系核对，不会自动重试。` : '关系已变化，编辑内容已保留，请重新读取。' }
    }
  }
  function invalidate(epoch = false) {
    if (disposed || !anchor) return
    if (epoch) generation++
    abort(); clearExpiry(); state.value = { ...state.value, detail: null, relations: null, picker: null, loading: false, pickerLoading: false,
      blocked: true, saving: epoch ? false : state.value.saving, uncertain: state.value.uncertain || (epoch && state.value.saving) }
  }
  return {
    state, ready, canSave, refresh, navigate, editPerformance, choose, invalidate,
    page: (offset: number) => refresh(Math.max(0, offset), false),
    setScope(scope: 'library' | 'catalog') { if (!ready.value) return; state.value = { ...state.value, scope }; return refresh() },
    setRole(role: '' | MusicCreditRole) { if (!ready.value) return; state.value = { ...state.value, role }; return refresh() },
    async back() { if (!state.value.trail.length || state.value.saving) return; const trail = [...state.value.trail]; anchor = trail.pop()!; generation++; abort(); clearExpiry(); state.value = { ...empty(), trail }; await refresh() },
    newPerformance() { const entity = state.value.detail?.entity; if (ready.value && entity?.kind === 'work') state.value = { ...state.value, editor: { workId: entity.id, title: '', recordings: [] }, picker: null, uncertain: false } },
    title(title: string) { if (!state.value.saving && state.value.editor) state.value = { ...state.value, editor: { ...state.value.editor, title: title.slice(0, 512) } } },
    addRecording(item: MusicExplorationItem) { const editor = state.value.editor; if (ready.value && editor && item.kind === 'recording' && editor.recordings.length < 200) state.value = { ...state.value, editor: { ...editor, recordings: [...editor.recordings, item] } } },
    removeRecording(index: number) { const editor = state.value.editor; if (ready.value && editor) state.value = { ...state.value, editor: { ...editor, recordings: editor.recordings.filter((_, i) => i !== index) } } },
    moveRecording(index: number, delta: number) { const editor = state.value.editor; if (!ready.value || !editor) return; const recordings = [...editor.recordings], next = index + delta; if (next < 0 || next >= recordings.length) return; [recordings[index], recordings[next]] = [recordings[next], recordings[index]]; state.value = { ...state.value, editor: { ...editor, recordings } } },
    pickerSearch(search: string) { if (!state.value.saving) state.value = { ...state.value, pickerSearch: search.slice(0,512), picker: null } },
    pickerScope(pickerScope: 'library' | 'catalog') { if (!state.value.saving) state.value = { ...state.value, pickerScope, picker: null } },
    cancelEditor() { if (!state.value.saving) state.value = { ...state.value, editor: null, deleteId: null, picker: null, uncertain: false } },
    requestDelete(id: string) { if (ready.value) state.value = { ...state.value, deleteId: id } },
    cancelDelete() { if (!state.value.saving) state.value = { ...state.value, deleteId: null } },
    acknowledgeUnknown() { if (ready.value) state.value = { ...state.value, uncertain: false, notice: '已核对关系；再次提交需手动确认。' } },
    save: () => mutate(), confirmDelete: () => mutate(true),
    setContext(entityId: string | undefined, reference: MusicExplorationReference | undefined, scope: string) {
      const next = entityId ? { entityId } : reference ? { reference } : null, key = JSON.stringify([scope, next])
      if (key === context || disposed) return
      context = key; generation++; abort(); clearExpiry(); anchor = next; state.value = empty(); return refresh()
    },
    dispose() { disposed = true; generation++; abort(); clearExpiry() }
  }
}

export function observeMusicExplorationView(view: ReturnType<typeof createMusicExplorationView>, input: {
  entityId(): string | undefined; reference(): MusicExplorationReference | undefined; scope(): string
  snapshot(): { epoch: string; explorationRevision?: number | null; catalogRevision?: number | null; libraryRevision?: number | null; entityMetadataRevision?: number | null; pluginsRevision?: number | null; settingsRevision?: number | null } | null
}) {
  const fields = ['epoch','explorationRevision','catalogRevision','libraryRevision','entityMetadataRevision','pluginsRevision','settingsRevision'] as const
  const known = Array<boolean>(fields.length + 1).fill(false); let initialized = false
  return watch(() => [JSON.stringify([input.entityId(), input.reference(), input.scope()]), ...fields.map(key => input.snapshot()?.[key])], (values, previous) => {
    const changed = values.map((value, i) => { const result = known[i] && value !== previous?.[i]; if (value != null) known[i] = true; return result })
    if (!initialized || changed[0]) { initialized = true; void view.setContext(input.entityId(), input.reference(), input.scope()) }
    else if (changed.slice(1).some(Boolean)) view.invalidate(changed[1])
  }, { immediate: true, flush: 'sync' })
}
