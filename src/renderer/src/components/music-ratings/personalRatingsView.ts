import { computed, shallowRef, watch } from 'vue'
import type {
  MusicRatingValue,
  MusicRatingsDetail,
  MusicRatingsHistoryPage,
  MusicRatingsHistoryQuery,
  MusicRatingsSet
} from '../../../../shared/musicRatings.ts'

export const RATINGS_HISTORY_PAGE_SIZE = 6
export const ratingLabel = (value: MusicRatingValue | null | undefined): string =>
  value?.steps == null ? '未评分' : `${value.steps / 2} 星`
export interface PersonalRatingsApi {
  detail(entityId: string, signal: AbortSignal): Promise<MusicRatingsDetail>
  set(request: MusicRatingsSet): Promise<unknown>
  history(query: MusicRatingsHistoryQuery, signal: AbortSignal): Promise<MusicRatingsHistoryPage>
}
const empty = () => ({
  detail: null as MusicRatingsDetail | null,
  draft: undefined as number | null | undefined,
  loading: false,
  saving: false,
  blocked: false,
  error: '',
  notice: '',
  historyOpened: false,
  history: null as MusicRatingsHistoryPage | null,
  historyLoading: false,
  historyError: ''
})
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A draft is never presented as saved. Domain changes withdraw old receipts. */
export function createPersonalRatingsView(api: PersonalRatingsApi) {
  const state = shallowRef(empty())
  let entityId: string | null = null,
    scope = '',
    generation = 0,
    disposed = false
  let reading: AbortController | null = null,
    historyReading: AbortController | null = null
  const ready = computed(
    () =>
      !!state.value.detail && !state.value.blocked && !state.value.loading && !state.value.saving
  )
  const canSave = computed(
    () =>
      ready.value &&
      state.value.draft !== undefined &&
      state.value.draft !== (state.value.detail?.value?.steps ?? null)
  )
  function cancelReads() {
    reading?.abort()
    reading = null
    historyReading?.abort()
    historyReading = null
  }
  async function refresh(preserveDraft = true) {
    if (!entityId || disposed || state.value.saving) return
    cancelReads()
    const request = new AbortController()
    reading = request
    state.value = {
      ...state.value,
      detail: null,
      history: null,
      loading: true,
      blocked: false,
      error: '',
      notice: ''
    }
    try {
      const detail = await api.detail(entityId, request.signal)
      if (disposed || reading !== request) return
      state.value = {
        ...state.value,
        detail,
        loading: false,
        draft: preserveDraft ? state.value.draft : undefined
      }
      if (state.value.historyOpened) await history()
    } catch (error) {
      if (!disposed && reading === request)
        state.value = { ...state.value, loading: false, error: `评分读取失败：${message(error)}` }
    }
  }
  async function history(offset = 0) {
    if (!ready.value || !entityId || !state.value.historyOpened) return
    historyReading?.abort()
    const request = new AbortController()
    historyReading = request
    state.value = { ...state.value, history: null, historyLoading: true, historyError: '' }
    try {
      const page = await api.history(
        { entityId, offset, limit: RATINGS_HISTORY_PAGE_SIZE },
        request.signal
      )
      if (disposed || historyReading !== request) return
      if (offset > 0 && offset >= page.total) return history(0)
      state.value = { ...state.value, history: page, historyLoading: false }
    } catch (error) {
      if (!disposed && historyReading === request)
        state.value = { ...state.value, historyLoading: false, historyError: message(error) }
    }
  }
  async function save() {
    if (!canSave.value || !entityId) return
    const request: MusicRatingsSet = {
      entityId,
      token: state.value.detail!.token,
      steps: state.value.draft!
    }
    const token = generation
    cancelReads()
    state.value = { ...state.value, saving: true, error: '', notice: '', history: null }
    try {
      await api.set(request)
      if (disposed || token !== generation) return
      state.value = { ...state.value, saving: false }
      await refresh(false)
      if (disposed || token !== generation) return
      if (state.value.detail)
        state.value = {
          ...state.value,
          notice: request.steps === null ? '评分已清除' : '评分已保存'
        }
    } catch (error) {
      if (disposed || token !== generation) return
      state.value = {
        ...state.value,
        saving: false,
        detail: null,
        blocked: true,
        error:
          (error as { code?: string })?.code === 'STALE_REVISION'
            ? '评分或身份已变化，草稿已保留，请重新读取后再保存。'
            : `保存结果未确认：${message(error)}。草稿已保留，请重新读取核对。`
      }
    }
  }
  return {
    state,
    ready,
    canSave,
    refresh,
    save,
    history,
    setContext(id: string | null, nextScope: string) {
      if (disposed || (entityId === id && scope === nextScope)) return Promise.resolve()
      generation++
      cancelReads()
      entityId = id
      scope = nextScope
      state.value = empty()
      return refresh(false)
    },
    invalidate(cancelMutation = false) {
      if (disposed || !entityId) return
      if (cancelMutation) generation++
      cancelReads()
      state.value = {
        ...state.value,
        detail: null,
        history: null,
        loading: false,
        historyLoading: false,
        saving: cancelMutation ? false : state.value.saving,
        blocked: true,
        notice: '',
        error: ''
      }
    },
    choose(steps: number) {
      if (ready.value && Number.isInteger(steps) && steps >= 1 && steps <= 10)
        state.value = { ...state.value, draft: steps, notice: '' }
    },
    clear() {
      if (!ready.value) return Promise.resolve()
      state.value = { ...state.value, draft: null, notice: '' }
      return save()
    },
    discardDraft() {
      if (!state.value.saving) state.value = { ...state.value, draft: undefined }
    },
    toggleHistory() {
      const opened = !state.value.historyOpened
      state.value = { ...state.value, historyOpened: opened }
      if (!opened) {
        historyReading?.abort()
        historyReading = null
        return Promise.resolve()
      }
      return history()
    },
    dispose() {
      disposed = true
      generation++
      cancelReads()
    }
  }
}

export function observePersonalRatingsView(
  view: ReturnType<typeof createPersonalRatingsView>,
  input: {
    entityId(): string | null
    scope(): string
    snapshot(): {
      epoch: string
      ratingsRevision?: number | null
      entityMetadataRevision?: number | null
      catalogRevision?: number | null
      libraryRevision?: number | null
    } | null
  }
) {
  let initialized = false
  const known = Array<boolean>(7).fill(false)
  return watch(
    [
      () => input.entityId(),
      () => input.scope(),
      () => input.snapshot()?.epoch,
      () => input.snapshot()?.ratingsRevision,
      () => input.snapshot()?.entityMetadataRevision,
      () => input.snapshot()?.catalogRevision,
      () => input.snapshot()?.libraryRevision
    ] as const,
    (value, previous) => {
      const changed = value.map((item, index) => {
        const differs = known[index] && item !== previous?.[index]
        if (item != null) known[index] = true
        return differs
      })
      if (!initialized || value[0] !== previous?.[0] || value[1] !== previous?.[1]) {
        initialized = true
        void view.setContext(value[0], value[1])
      } else if (changed.slice(2).some(Boolean)) view.invalidate(changed[2])
    },
    { immediate: true, flush: 'sync' }
  )
}
