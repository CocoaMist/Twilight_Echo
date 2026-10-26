import { computed, shallowRef, watch } from 'vue'
import type {
  MusicPreferenceState,
  MusicPreferenceValue,
  MusicPreferencesDetail,
  MusicPreferencesSet
} from '../../../../shared/musicPreferences.ts'

export const preferenceLabel = (value: MusicPreferenceValue | null | undefined, organizationOnly = false): string =>
  value?.state === 'favorite' ? '喜欢' : value?.state === 'ban' ? organizationOnly ? '不推荐' : '禁播' : '无偏好'
export const preferenceOrganizationOnly = (detail: MusicPreferencesDetail | null): boolean =>
  detail?.kind === 'work' || (detail?.kind === 'artist' && detail.scope === 'entity')
export interface PersonalPreferencesApi {
  detail(entityId: string, signal: AbortSignal): Promise<MusicPreferencesDetail>
  set(request: MusicPreferencesSet): Promise<unknown>
}
const empty = () => ({
  detail: null as MusicPreferencesDetail | null,
  organizationOnly: false,
  draft: undefined as MusicPreferenceState | undefined,
  loading: false,
  saving: false,
  blocked: false,
  error: '',
  notice: ''
})
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Preferences are Core-owned. A lost receipt requires a read, never command replay. */
export function createPersonalPreferencesView(api: PersonalPreferencesApi) {
  const state = shallowRef(empty())
  let entityId: string | null = null,
    scope = '',
    generation = 0,
    disposed = false
  let reading: AbortController | null = null
  const ready = computed(
    () =>
      !!state.value.detail && !state.value.loading && !state.value.saving && !state.value.blocked
  )
  const canSave = computed(
    () =>
      ready.value &&
      state.value.draft !== undefined &&
      state.value.draft !== (state.value.detail?.value?.state ?? 'none')
  )
  function cancelRead() {
    reading?.abort()
    reading = null
  }
  async function refresh() {
    if (!entityId || disposed || state.value.saving) return
    cancelRead()
    const request = new AbortController()
    reading = request
    state.value = {
      ...state.value,
      detail: null,
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
        organizationOnly: preferenceOrganizationOnly(detail),
        loading: false,
        draft: state.value.draft === (detail.value?.state ?? 'none') ? undefined : state.value.draft
      }
    } catch (error) {
      if (!disposed && reading === request)
        state.value = { ...state.value, loading: false, error: `偏好读取失败：${message(error)}` }
    }
  }
  async function save() {
    if (!canSave.value || !entityId) return
    const query: MusicPreferencesSet = {
      entityId,
      token: state.value.detail!.token,
      state: state.value.draft!
    }
    const token = generation
    cancelRead()
    state.value = { ...state.value, saving: true, error: '', notice: '' }
    try {
      await api.set(query)
      if (disposed || token !== generation) return
      state.value = { ...state.value, saving: false }
      await refresh()
      if (disposed || token !== generation) return
      if (
        state.value.detail?.token.targetKey === query.token.targetKey &&
        state.value.detail.value?.state === query.state
      )
        state.value = { ...state.value, draft: undefined, notice: '偏好已保存' }
      else if (!state.value.detail)
        state.value = {
          ...state.value,
          blocked: true,
          notice: '偏好已提交，请重新读取确认当前状态。'
        }
      else
        state.value = {
          ...state.value,
          notice: '已读取当前状态；偏好或身份已变化，请核对后再操作。'
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
            ? '偏好或身份已变化，操作已保留，请重新读取核对。'
            : `保存结果未确认：${message(error)}。操作已保留，请重新读取核对。`
      }
    }
  }
  function set(next: MusicPreferenceState) {
    if (!ready.value || !['none', 'favorite', 'ban'].includes(next)) return Promise.resolve()
    state.value = { ...state.value, draft: next, notice: '' }
    return save()
  }
  return {
    state,
    ready,
    canSave,
    refresh,
    save,
    favorite: () => set('favorite'),
    ban: () => set('ban'),
    cancelFavorite: () =>
      state.value.detail?.value?.state === 'favorite' ? set('none') : Promise.resolve(),
    unban: () => (state.value.detail?.value?.state === 'ban' ? set('none') : Promise.resolve()),
    discardDraft() {
      if (!state.value.saving) state.value = { ...state.value, draft: undefined }
    },
    setContext(id: string | null, nextScope: string) {
      if (disposed || (entityId === id && scope === nextScope)) return Promise.resolve()
      generation++
      cancelRead()
      entityId = id
      scope = nextScope
      state.value = empty()
      return refresh()
    },
    invalidate(cancelMutation = false) {
      if (disposed || !entityId) return
      if (cancelMutation) generation++
      cancelRead()
      state.value = {
        ...state.value,
        detail: null,
        loading: false,
        blocked: true,
        saving: cancelMutation ? false : state.value.saving,
        error: '',
        notice: ''
      }
    },
    dispose() {
      disposed = true
      generation++
      cancelRead()
    }
  }
}

export function observePersonalPreferencesView(
  view: ReturnType<typeof createPersonalPreferencesView>,
  input: {
    entityId(): string | null
    scope(): string
    snapshot(): {
      epoch: string
      preferencesRevision?: number | null
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
      () => input.snapshot()?.preferencesRevision,
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
