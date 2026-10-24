import { computed, shallowRef } from 'vue'
import type { MusicPreferenceResolution } from '../../../../shared/musicPreferences.ts'
import { validMusicPreferenceChoice } from '../../../../shared/musicPreferences.ts'
import type { MusicRatingResolution } from '../../../../shared/musicRatings.ts'
import type {
  IdentificationCandidate,
  IdentificationCandidatesQuery,
  IdentificationDecision,
  IdentificationPreview,
  IdentificationReview,
  IdentificationStart,
  MusicIdentityDetail
} from '../../../../shared/musicIdentification.ts'

export const IDENTITY_CANDIDATE_PAGE_SIZE = 6
export type IdentityCandidateState = IdentificationCandidate['state']
export interface IdentityReviewApi {
  detail(entityId: string, signal: AbortSignal): Promise<MusicIdentityDetail>
  candidates(
    query: IdentificationCandidatesQuery,
    signal: AbortSignal
  ): Promise<{ total: number; items: IdentificationCandidate[] }>
  preview(query: IdentificationReview, signal: AbortSignal): Promise<IdentificationPreview>
  decide(query: IdentificationDecision): Promise<unknown>
  detach(query: { linkId: string; revision: number }): Promise<unknown>
  start(query: IdentificationStart): Promise<unknown>
  newId(): string
  changed(): Promise<void>
}
interface State {
  identity: MusicIdentityDetail | null
  candidates: { total: number; items: IdentificationCandidate[] } | null
  offset: number
  filter: IdentityCandidateState
  preview: IdentificationPreview | null
  ratingChoice: MusicRatingResolution['choice'] | null
  preferenceChoice: MusicPreferenceResolution['choice'] | null
  detaching: boolean
  loading: boolean
  previewLoading: boolean
  saving: boolean
  error: string
  actionError: string
  notice: string
}
const empty = (): State => ({
  identity: null,
  candidates: null,
  offset: 0,
  filter: 'candidate',
  preview: null,
  ratingChoice: null,
  preferenceChoice: null,
  detaching: false,
  loading: false,
  previewLoading: false,
  saving: false,
  error: '',
  actionError: '',
  notice: ''
})
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Review saved IDs and versions; opening this view never starts recognition. */
export function createIdentityReviewView(api: IdentityReviewApi) {
  const state = shallowRef(empty())
  let entityId: string | null = null,
    scope = '',
    generation = 0,
    disposed = false
  let reading: AbortController | null = null,
    previewing: AbortController | null = null
  const ready = computed(
    () =>
      !!state.value.identity &&
      !state.value.loading &&
      !state.value.saving &&
      !state.value.previewLoading
  )
  function clearPreview() {
    previewing?.abort()
    previewing = null
    state.value = {
      ...state.value,
      preview: null,
      ratingChoice: null,
      preferenceChoice: null,
      previewLoading: false,
      detaching: false
    }
  }
  async function load(offset = state.value.offset) {
    if (!entityId || disposed) return
    reading?.abort()
    clearPreview()
    const request = new AbortController()
    reading = request
    state.value = {
      ...state.value,
      identity: null,
      candidates: null,
      loading: true,
      offset,
      error: ''
    }
    try {
      const [identity, candidates] = await Promise.all([
        api.detail(entityId, request.signal),
        api.candidates(
          { entityId, state: state.value.filter, offset, limit: IDENTITY_CANDIDATE_PAGE_SIZE },
          request.signal
        )
      ])
      if (disposed || reading !== request) return
      if (offset > 0 && offset >= candidates.total) return load(0)
      state.value = { ...state.value, identity, candidates, loading: false }
    } catch (error) {
      if (!disposed && reading === request)
        state.value = { ...state.value, loading: false, error: message(error) }
    }
  }
  async function mutate(action: () => Promise<unknown>, notice: string) {
    if (!ready.value || disposed) return
    const token = generation
    state.value = { ...state.value, saving: true, actionError: '', notice: '' }
    try {
      await action()
      if (disposed || token !== generation) return
      state.value = { ...state.value, notice }
    } catch (error) {
      if (disposed || token !== generation) return
      state.value = {
        ...state.value,
        actionError:
          (error as { code?: string })?.code === 'STALE_REVISION'
            ? '关联或候选已变化，请重新读取并核对候选。'
            : `操作结果未确认：${message(error)}。请核对重新读取的状态后再操作。`
      }
    }
    if (disposed || token !== generation) return
    // A receipt may be lost after commit. Read current state; never replay a command.
    clearPreview()
    await load()
    if (disposed || token !== generation) return
    await api.changed().catch(() => {})
    if (!disposed && token === generation) state.value = { ...state.value, saving: false }
  }
  const canConfirm = computed(
    () =>
      ready.value &&
      !!state.value.preview?.canConfirm &&
      !state.value.preview.stale &&
      (!state.value.preview.ratingImpact?.conflict || !!state.value.ratingChoice) &&
      (!state.value.preview.preferenceImpact?.conflict || !!state.value.preferenceChoice)
  )
  const canReject = computed(
    () =>
      ready.value &&
      !!state.value.preview &&
      !state.value.preview.stale &&
      state.value.preview.candidate.state !== 'rejected' &&
      !(
        state.value.preview.candidate.state === 'confirmed' && state.value.preview.action === 'keep'
      )
  )
  return {
    state,
    ready,
    canConfirm,
    canReject,
    setContext(id: string | null, nextScope: string) {
      if (disposed) return Promise.resolve()
      if (id === entityId && nextScope === scope) return load()
      generation++
      reading?.abort()
      reading = null
      clearPreview()
      entityId = id
      scope = nextScope
      state.value = empty()
      return id ? load(0) : Promise.resolve()
    },
    refresh: () => load(),
    invalidate(cancelMutation = false) {
      if (cancelMutation) generation++
      reading?.abort()
      reading = null
      clearPreview()
      state.value = {
        ...state.value,
        identity: null,
        candidates: null,
        loading: false,
        saving: cancelMutation ? false : state.value.saving,
        notice: '身份、评分、偏好或曲库已变化，请读取最新身份后再复核。'
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
    page: (offset: number) => (ready.value ? load(offset) : Promise.resolve()),
    filter(value: IdentityCandidateState) {
      if (!ready.value) return Promise.resolve()
      state.value = { ...state.value, filter: value }
      return load(0)
    },
    async review(candidate: IdentificationCandidate) {
      if (!ready.value || disposed || candidate.entityId !== entityId) return
      clearPreview()
      const request = new AbortController()
      previewing = request
      state.value = { ...state.value, previewLoading: true, actionError: '', notice: '' }
      try {
        const preview = await api.preview(
          {
            candidateId: candidate.id,
            revision: candidate.revision,
            linkRevision: state.value.identity!.link?.revision ?? 0
          },
          request.signal
        )
        if (!disposed && previewing === request)
          state.value = {
            ...state.value,
            preview,
            identity: preview.current,
            previewLoading: false
          }
      } catch (error) {
        if (!disposed && previewing === request)
          state.value = {
            ...state.value,
            previewLoading: false,
            actionError: `候选读取失败：${message(error)}`
          }
      }
    },
    decide(decision: IdentificationDecision['decision']) {
      if (!(decision === 'confirm' ? canConfirm.value : canReject.value)) return Promise.resolve()
      const preview = state.value.preview!
      const query: IdentificationDecision = {
        candidateId: preview.candidate.id,
        revision: preview.candidate.revision,
        linkRevision: preview.current.link?.revision ?? 0,
        decision
      }
      const impact = preview.ratingImpact
      if (decision === 'confirm' && impact)
        query.ratingResolution = {
          revision: impact.revision,
          choice: state.value.ratingChoice ?? (impact.action === 'carry' ? 'current' : 'target')
        }
      const preferenceImpact = preview.preferenceImpact
      if (decision === 'confirm' && preferenceImpact)
        query.preferenceResolution = {
          revision: preferenceImpact.revision,
          choice:
            state.value.preferenceChoice ??
            (preferenceImpact.action === 'carry' ? 'current' : 'target')
        }
      return mutate(
        () => api.decide(query),
        decision === 'confirm' ? '身份关联已确认' : '候选已拒绝；可在“已拒绝”中重新复核'
      )
    },
    beginDetach() {
      if (ready.value && state.value.identity?.link?.state === 'confirmed') {
        clearPreview()
        state.value = { ...state.value, detaching: true, actionError: '', notice: '' }
      }
    },
    detach() {
      const link = state.value.identity?.link
      if (!state.value.detaching || link?.state !== 'confirmed') return Promise.resolve()
      return mutate(
        () => api.detach({ linkId: link.id, revision: link.revision }),
        '已解除身份关联'
      )
    },
    start() {
      if (!ready.value || !entityId) return Promise.resolve()
      const query = { entityId, batchId: api.newId() }
      return mutate(() => api.start(query), '已提交后台识别；结果到达后可在此复核')
    },
    cancel() {
      if (!state.value.saving) clearPreview()
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

const labels: Record<string, string> = {
  name: '名称',
  title: '标题',
  artist_credit: '艺人署名',
  artist_alias: '艺人别名',
  duration: '时长',
  isrc: 'ISRC',
  barcode: '条形码',
  catalog_number: '目录号',
  verified_identity: '已校验身份',
  provider_native_id: '平台原生 ID',
  explicit_id: '明确外部 ID',
  cross_reference: '交叉引用',
  complete_track_validation: '完整曲目校验',
  track_positions: '碟号与曲序',
  full_titles: '完整曲名',
  all_track_artists: '全部曲目艺人',
  pressing_disambiguation: '具体发行区分依据',
  external_references_belong_to_different_targets: '外部引用分属不同身份',
  conflicting_ids_in_same_namespace: '同一来源存在冲突 ID',
  history_confirmation_snapshot_unavailable: '此记录缺少可恢复的确认快照，请重新识别',
  history_target_unavailable: '历史身份已不可用，请重新识别',
  history_references_changed: '历史外部引用已变化，请重新识别'
}
export const identityEvidenceLabel = (key: string): string => labels[key] ?? key
const kinds: Record<string, string> = {
  artist: '人物',
  recording: '录音',
  release: '具体发行',
  album_project: '专辑作品'
}
export const identityKindLabel = (kind: string): string => kinds[kind] ?? kind
