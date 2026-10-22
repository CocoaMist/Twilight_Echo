import { ref, shallowRef } from 'vue'

export type LibraryStorageMode = 'json' | 'sqlite'

/** Discovery failures are not evidence that the profile uses JSON. */
export function createLibraryStorageState(api: { getStorageMode(): Promise<LibraryStorageMode> }) {
  const mode = ref<LibraryStorageMode | null>(null)
  const error = shallowRef('')
  const loading = ref(false)
  let pending: Promise<void> | null = null
  function load(): Promise<void> {
    if (mode.value) return Promise.resolve()
    if (pending) return pending
    loading.value = true
    error.value = ''
    pending = Promise.resolve()
      .then(() => api.getStorageMode())
      .then((result) => {
        if (result !== 'sqlite' && result !== 'json') throw new Error('曲库存储模式无效')
        mode.value = result
      })
      .catch((cause: unknown) => {
        error.value = cause instanceof Error ? cause.message : String(cause)
      })
      .finally(() => {
        loading.value = false
        pending = null
      })
    return pending
  }
  return { mode, error, loading, load }
}
