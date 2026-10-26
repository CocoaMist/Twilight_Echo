import { computed, shallowRef } from 'vue'
import type { MusicPreferenceResolution } from '../../../../shared/musicPreferences.ts'
import { validMusicPreferenceChoice } from '../../../../shared/musicPreferences.ts'
import type { MusicRatingResolution } from '../../../../shared/musicRatings.ts'
import type {
  IdentificationHistoryItem,
  IdentificationHistoryPage,
  IdentificationHistoryQuery,
  IdentificationHistoryReview,
  IdentificationRestorePreview
} from '../../../../shared/musicIdentification.ts'

export const IDENTITY_HISTORY_PAGE_SIZE = 6
export interface IdentityHistoryApi {
  history(
    query: IdentificationHistoryQuery,
    signal: AbortSignal
  ): Promise<IdentificationHistoryPage>
  preview(
    query: IdentificationHistoryReview,
    signal: AbortSignal
  ): Promise<IdentificationRestorePreview>
  restore(query: IdentificationHistoryReview): Promise<unknown>
  changed(): Promise<void>
}
interface State {
  opened: boolean
  page: IdentificationHistoryPage | null
  offset: number
  preview: IdentificationRestorePreview | null
  ratingChoice: MusicRatingResolution['choice'] | null
  preferenceChoice: MusicPreferenceResolution['choice'] | null
  loading: boolean
  previewLoading: boolean
  saving: boolean
  error: string
  notice: string
}
const empty = (): State => ({
  opened: false,
  page: null,
  offset: 0,
  preview: null,
  ratingChoice: null,
  preferenceChoice: null,
  loading: false,
  previewLoading: false,
  saving: false,
  error: '',
  notice: ''
})
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function createIdentityHistoryView(api: IdentityHistoryApi) {
  const state = shallowRef(empty())
  let entityId: string | null = null,
    scope = '',
    generation = 0,
    disposed = false
  let reading: AbortController | null = null,
    previewing: AbortController | null = null
  const ready = computed(
    () =>
      !!state.value.page &&
      !state.value.loading &&
      !state.value.previewLoading &&
      !state.value.saving
  )
  const canRestore = computed(
    () =>
      ready.value &&
      !!state.value.preview?.canRestore &&
      !state.value.preview.stale &&
      (!state.value.preview.ratingImpact?.conflict || !!state.value.ratingChoice) &&
      (!state.value.preview.preferenceImpact?.conflict || !!state.value.preferenceChoice)
  )
  function cancelPreview() {
    previewing?.abort()
    previewing = null
    state.value = {
      ...state.value,
      preview: null,
      ratingChoice: null,
      preferenceChoice: null,
      previewLoading: false
    }
  }
  async function load(offset = state.value.offset) {
    if (!entityId || disposed || !state.value.opened) return
    reading?.abort()
    cancelPreview()
    const request = new AbortController()
    reading = request
    state.value = { ...state.value, page: null, offset, loading: true }
    try {
      const page = await api.history(
        { entityId, offset, limit: IDENTITY_HISTORY_PAGE_SIZE },
        request.signal
      )
      if (disposed || reading !== request) return
      if (offset > 0 && offset >= page.total) return load(0)
      state.value = { ...state.value, page, loading: false }
    } catch (error) {
      if (!disposed && reading === request)
        state.value = { ...state.value, loading: false, error: message(error) }
    }
  }
  return {
    state,
    ready,
    canRestore,
    setContext(id: string | null, nextScope: string) {
      if (disposed || (id === entityId && nextScope === scope)) return
      generation++
      reading?.abort()
      reading = null
      cancelPreview()
      entityId = id
      scope = nextScope
      state.value = empty()
    },
    toggle() {
      if (state.value.saving) return Promise.resolve()
      const opened = !state.value.opened
      state.value = { ...state.value, opened, error: '', notice: '' }
      if (!opened) {
        reading?.abort()
        reading = null
        cancelPreview()
        state.value = { ...state.value, loading: false }
        return Promise.resolve()
      }
      return load(0)
    },
    refresh() {
      state.value = { ...state.value, error: '' }
      return load()
    },
    invalidate(cancelMutation = false) {
      if (cancelMutation) generation++
      reading?.abort()
      reading = null
      cancelPreview()
      state.value = {
        ...state.value,
        page: null,
        loading: false,
        saving: cancelMutation ? false : state.value.saving,
        notice: '身份、评分、偏好或曲库已变化，请重新读取历史后再复核。'
      }
    },
    choosePreference(choice: MusicPreferenceResolution['choice']) {
      if (
        !state.value.saving &&
        state.value.preview?.preferenceImpact?.conflict &&
        validMusicPreferenceChoice(choice, state.value.preview.preferenceImpact)
      )
        state.value = { ...state.value, preferenceChoice: choice }
    },
    chooseRating(choice: MusicRatingResolution['choice']) {
      if (
        !state.value.saving &&
        state.value.preview?.ratingImpact?.conflict &&
        ['current', 'target', 'clear'].includes(choice)
      )
        state.value = { ...state.value, ratingChoice: choice }
    },
    page(offset: number) {
      return ready.value ? load(offset) : Promise.resolve()
    },
    async review(item: IdentificationHistoryItem) {
      const page = state.value.page
      if (!ready.value || !entityId || !page || !item.hasSnapshot) return
      cancelPreview()
      const request = new AbortController()
      previewing = request
      state.value = { ...state.value, previewLoading: true, error: '', notice: '' }
      try {
        const preview = await api.preview(
          {
            entityId,
            historySeq: item.seq,
            linkRevision: page.current.link?.revision ?? 0,
            inputVersion: page.inputVersion
          },
          request.signal
        )
        if (!disposed && previewing === request)
          state.value = { ...state.value, preview, previewLoading: false }
      } catch (error) {
        if (!disposed && previewing === request)
          state.value = { ...state.value, previewLoading: false, error: message(error) }
      }
    },
    async restore() {
      if (!canRestore.value || disposed) return
      const preview = state.value.preview!,
        query = { ...preview.request },
        token = generation
      const impact = preview.ratingImpact
      if (impact)
        query.ratingResolution = {
          revision: impact.revision,
          choice: state.value.ratingChoice ?? (impact.action === 'carry' ? 'current' : 'target')
        }
      const preferenceImpact = preview.preferenceImpact
      if (preferenceImpact)
        query.preferenceResolution = {
          revision: preferenceImpact.revision,
          choice:
            state.value.preferenceChoice ??
            (preferenceImpact.action === 'carry' ? 'current' : 'target')
        }
      state.value = { ...state.value, saving: true, error: '', notice: '' }
      try {
        await api.restore(query)
        if (disposed || token !== generation) return
        state.value = { ...state.value, notice: '已恢复历史身份关联' }
      } catch (error) {
        if (disposed || token !== generation) return
        state.value = {
          ...state.value,
          error:
            (error as { code?: string })?.code === 'STALE_REVISION'
              ? '关联或来源已变化，请重新读取历史并核对。'
              : `操作结果未确认：${message(error)}。请核对重新读取的状态后再操作。`
        }
      }
      if (disposed || token !== generation) return
      // A committed command can lose its receipt. Reconcile with reads, never replay.
      cancelPreview()
      await load()
      if (disposed || token !== generation) return
      await api.changed().catch(() => {})
      if (!disposed && token === generation) state.value = { ...state.value, saving: false }
    },
    cancel() {
      if (!state.value.saving) cancelPreview()
    },
    dispose() {
      disposed = true
      generation++
      reading?.abort()
      reading = null
      previewing?.abort()
      previewing = null
    }
  }
}

const states: Record<IdentificationHistoryItem['state'], string> = {
  confirmed: '确认关联',
  replaced: '被替换',
  rejected: '拒绝候选',
  detached: '解除关联'
}
export const identityHistoryStateLabel = (state: IdentificationHistoryItem['state']) =>
  states[state]
