import { computed, shallowRef, watch } from 'vue'
import type { EntityMetadataArtworkOverride, EntityMetadataDetail, EntityMetadataLanguage, EntityMetadataSourcePreference } from '../../../../shared/entityMetadata.ts'
import { parsePersonalMusicArtwork, PERSONAL_MUSIC_ARTWORK_MAX_BYTES } from '../../../../shared/personalMusicArtwork.ts'

type Mode = 'source' | EntityMetadataArtworkOverride['mode']
const empty = () => ({ entityId: null as string | null, revision: 0, mode: null as Mode | null,
  provider: null as string | null, dataUrl: '', reading: false, saving: false, review: false, error: '', notice: '' })

/** One explicit write at a time; unknown receipts retain the draft and require reconciliation. */
export function createEntityPersonalMetadataEditor(input: {
  scope(): string
  selected(): string | null
  detail(): EntityMetadataDetail | null
  available(): boolean
  language(): EntityMetadataLanguage
  sourcePreference(request: EntityMetadataSourcePreference): Promise<unknown>
  artworkOverride(request: EntityMetadataArtworkOverride): Promise<unknown>
  refresh(): Promise<void>
}) {
  const state = shallowRef(empty())
  let generation = 0, disposed = false
  const current = computed(() => input.available() && input.detail()?.entityId === input.selected() ? input.detail() : null)
  const attached = computed(() => !!current.value && state.value.entityId === current.value.entityId)
  const needsReview = computed(() => state.value.review || (attached.value && current.value!.revision !== state.value.revision))
  const canSubmit = computed(() => !disposed && !!state.value.mode && attached.value && !needsReview.value &&
    !state.value.saving && !state.value.reading && (state.value.mode !== 'value' || !!parsePersonalMusicArtwork(state.value.dataUrl)))
  function reset() { generation++; state.value = empty() }
  const stop = watch([input.scope, input.selected], ([scope, selected], previous) => {
    if (scope !== previous?.[0] || (selected && state.value.entityId && selected !== state.value.entityId)) reset()
  }, { immediate: true, flush: 'sync' })
  function begin(mode: Mode) {
    if (disposed || state.value.saving || state.value.reading || !current.value) return false
    generation++
    state.value = { ...empty(), entityId: current.value.entityId, revision: current.value.revision,
      mode, provider: current.value.sourcePreference?.provider ?? null }
    return true
  }
  return {
    state, current, attached, needsReview, canSubmit,
    begin,
    provider(provider: string | null) {
      if (!state.value.mode && !begin('source')) return
      if (state.value.mode === 'source' && !state.value.saving)
        state.value = { ...state.value, provider, error: '' }
    },
    async loadArtwork(file: { size: number; type: string }, read: () => Promise<string>) {
      if (!begin('value')) return
      const token = generation
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size < 1 || file.size > PERSONAL_MUSIC_ARTWORK_MAX_BYTES) {
        state.value = { ...state.value, error: '请选择不超过 2 MiB 的静态 PNG、JPEG 或 WebP 图片。' }
        return
      }
      state.value = { ...state.value, reading: true }
      try {
        const dataUrl = await read()
        if (disposed || generation !== token) return
        const parsed = parsePersonalMusicArtwork(dataUrl)
        if (!parsed || parsed.bytes !== file.size || parsed.mime !== file.type) throw new Error('图片内容或尺寸无效，请选择有效的位图。')
        state.value = { ...state.value, dataUrl, reading: false }
      } catch (error) {
        if (!disposed && generation === token) state.value = { ...state.value, reading: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    acceptLatest() {
      if (!disposed && attached.value && !state.value.saving && !state.value.reading)
        state.value = { ...state.value, revision: current.value!.revision, review: false, error: '' }
    },
    cancel() { if (!state.value.saving) reset() },
    async submit() {
      if (!canSubmit.value) return
      const token = generation, draft = state.value
      const request = { entityId: draft.entityId!, revision: draft.revision, language: input.language() }
      state.value = { ...draft, saving: true, error: '' }
      try {
        if (draft.mode === 'source') await input.sourcePreference({ ...request, provider: draft.provider })
        else await input.artworkOverride({ ...request, mode: draft.mode as EntityMetadataArtworkOverride['mode'],
          ...(draft.mode === 'value' ? { dataUrl: draft.dataUrl } : {}) })
        if (disposed || generation !== token) return
        state.value = { ...empty(), notice: draft.mode === 'source' ? '资料源首选已保存' : draft.mode === 'clear' ? '已隐藏资料图片' : draft.mode === 'reset' ? '已恢复自动图片' : '资料图片已保存' }
        await input.refresh().catch(() => {})
      } catch (error) {
        if (disposed || generation !== token) return
        state.value = { ...state.value, saving: false, review: true,
          error: (error as { code?: string })?.code === 'STALE_REVISION' ? '资料已变化，草稿已保留。请核对最新资料。' :
            `保存结果未确认，草稿已保留：${error instanceof Error ? error.message : String(error)}` }
        await input.refresh().catch(() => {})
      }
    },
    dispose() { disposed = true; generation++; stop() }
  }
}
