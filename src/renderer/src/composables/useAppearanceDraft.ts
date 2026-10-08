import { reactive } from 'vue'
import { cloneAppearance, type AppearanceDraft } from '../../../shared/appAppearance.ts'

export function useAppearanceDraft(options: {
  confirmed: () => AppearanceDraft
  persist: (draft: AppearanceDraft) => Promise<unknown>
  preview: (draft: AppearanceDraft | null) => Promise<void>
}) {
  const state = reactive({
    draft: cloneAppearance(options.confirmed()),
    saving: false,
    error: '',
    fullWindow: false
  })
  let session = 0
  function begin(): void {
    session++
    state.draft = cloneAppearance(options.confirmed())
    state.error = ''
    state.fullWindow = false
  }
  async function preview(fullWindow: boolean): Promise<void> {
    state.fullWindow = fullWindow
    await options.preview(fullWindow ? cloneAppearance(state.draft) : null)
  }
  async function cancel(): Promise<void> {
    session++
    state.fullWindow = false
    await options.preview(null)
  }
  async function save(): Promise<boolean> {
    if (state.saving) return false
    const revision = session
    state.saving = true
    state.error = ''
    try {
      await options.persist(cloneAppearance(state.draft))
      if (session !== revision) return false
      await preview(false)
      return true
    } catch (error) {
      if (session === revision) {
        state.error = error instanceof Error ? error.message : '保存失败，请重试'
        await preview(false)
      }
      return false
    } finally {
      state.saving = false
    }
  }
  return { state, begin, preview, cancel, save }
}
