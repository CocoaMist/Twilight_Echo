import { computed, shallowRef, watch } from 'vue'
import type {
  EntityMetadataDetail,
  EntityMetadataLanguage,
  EntityMetadataOverride
} from '../../../../shared/entityMetadata.ts'

type Mode = EntityMetadataOverride['mode']
interface EditorState {
  entityId: string | null
  revision: number
  mode: Mode | null
  value: string
  language: EntityMetadataLanguage
  saving: boolean
  review: boolean
  error: string
  notice: string
}
const empty = (): EditorState => ({
  entityId: null,
  revision: 0,
  mode: null,
  value: '',
  language: 'zh-Hans',
  saving: false,
  review: false,
  error: '',
  notice: ''
})

/** A draft belongs to one entity, context and revision. Reads never rebase a draft. */
export function createEntityIntroductionEditor(input: {
  scope(): string
  selected(): string | null
  detail(): EntityMetadataDetail | null
  available(): boolean
  language(): EntityMetadataLanguage
  override(request: EntityMetadataOverride): Promise<unknown>
  refresh(): Promise<void>
}) {
  const state = shallowRef(empty())
  let generation = 0
  let disposed = false
  const current = computed(() => {
    const detail = input.detail()
    return input.available() && detail?.entityId === input.selected() ? detail : null
  })
  const attached = computed(
    () => !!current.value && current.value.entityId === state.value.entityId
  )
  const needsReview = computed(
    () => state.value.review || (attached.value && current.value!.revision !== state.value.revision)
  )
  const valid = computed(
    () =>
      state.value.mode !== 'value' ||
      (!!state.value.value.trim() &&
        state.value.value.length <= 20000 &&
        !state.value.value.includes('\0'))
  )
  const canSubmit = computed(
    () =>
      !disposed &&
      !!state.value.mode &&
      attached.value &&
      !state.value.saving &&
      !needsReview.value &&
      valid.value
  )
  function reset() {
    generation++
    state.value = empty()
  }
  const stop = watch(
    [input.scope, input.selected],
    ([scope, selected], previous) => {
      if (
        scope !== previous?.[0] ||
        (selected && state.value.entityId && selected !== state.value.entityId)
      )
        reset()
    },
    { immediate: true, flush: 'sync' }
  )
  return {
    state,
    current,
    attached,
    needsReview,
    valid,
    canSubmit,
    begin(mode: Mode) {
      if (disposed || state.value.saving || !current.value) return
      generation++
      const detail = current.value
      state.value = {
        ...empty(),
        mode,
        entityId: detail.entityId,
        revision: detail.revision,
        // External/imported prose keeps its attribution. Only an existing manual value is a draft.
        value: mode === 'value' && detail.override?.mode === 'value' ? detail.override.value : '',
        language: detail.override?.language ?? input.language()
      }
    },
    value(value: string) {
      if (!disposed && state.value.mode === 'value' && !state.value.saving)
        state.value = { ...state.value, value, error: '' }
    },
    language(language: EntityMetadataLanguage) {
      if (!disposed && state.value.mode === 'value' && !state.value.saving)
        state.value = { ...state.value, language }
    },
    acceptLatest() {
      if (disposed || !attached.value || state.value.saving || !state.value.mode) return
      state.value = { ...state.value, revision: current.value!.revision, review: false, error: '' }
    },
    cancel() {
      if (!state.value.saving) reset()
    },
    async submit() {
      if (!canSubmit.value) return
      const token = generation
      const { entityId, revision, mode, value, language } = state.value
      state.value = { ...state.value, saving: true, error: '', notice: '' }
      try {
        await input.override({
          entityId: entityId!,
          revision,
          mode: mode!,
          language,
          ...(mode === 'value' ? { value } : {})
        })
        if (disposed || generation !== token) return
        state.value = {
          ...state.value,
          mode: null,
          saving: false,
          notice:
            mode === 'clear' ? '已清空介绍' : mode === 'reset' ? '已恢复自动资料' : '介绍已保存'
        }
        // Always reread with the actual source/account context, never display a command's raw result.
        await input.refresh().catch(() => {})
      } catch (error) {
        if (disposed || generation !== token) return
        const code = (error as { code?: string })?.code
        state.value = {
          ...state.value,
          saving: false,
          review: true,
          error:
            code === 'STALE_REVISION'
              ? '资料已变化，草稿已保留。请核对最新资料后再保存。'
              : `保存结果未确认，草稿已保留：${error instanceof Error ? error.message : String(error)}`
        }
        // A lost receipt may follow a committed write. Reconcile, do not replay it.
        await input.refresh().catch(() => {})
      }
    },
    dispose() {
      disposed = true
      generation++
      stop()
    }
  }
}
