import { shallowRef } from 'vue'
import type { LibraryDatabaseApi } from '../../../../shared/libraryDatabase.ts'

/** The home router must not infer an empty SQLite library from a compatibility
 * array that is still loading (or has deliberately not been loaded). */
export function createLibraryHomeStatus(options: {
  getStorageMode(): Promise<'json' | 'sqlite'>
  api: Pick<LibraryDatabaseApi, 'getMetadata'>
}) {
  const state = shallowRef({
    mode: null as 'json' | 'sqlite' | null,
    total: null as number | null,
    error: ''
  })
  let active = false,
    pending = false,
    disposed = false,
    revision = -1,
    minimumRevision = -1
  function refresh(nextRevision?: number): void {
    if (
      disposed ||
      (nextRevision !== undefined && nextRevision <= Math.max(revision, minimumRevision))
    )
      return
    if (nextRevision !== undefined) minimumRevision = nextRevision
    pending = true
    pump()
  }
  function pump(): void {
    if (disposed || active || !pending) return
    active = true
    pending = false
    state.value = { ...state.value, error: '' }
    void (async () => {
      try {
        const mode = state.value.mode ?? (await options.getStorageMode())
        if (disposed) return
        if (mode !== 'json' && mode !== 'sqlite') throw new Error('无法确认曲库存储')
        state.value = { ...state.value, mode }
        if (mode === 'json') return
        const metadata = await options.api.getMetadata()
        if (disposed) return
        if (metadata.revision < minimumRevision) {
          if (pending) return
          throw new Error('曲库在读取首页期间发生变化，请重试')
        }
        revision = metadata.revision
        state.value = { mode, total: metadata.trackCount, error: '' }
      } catch (error) {
        if (!disposed)
          state.value = {
            ...state.value,
            error: error instanceof Error ? error.message : String(error)
          }
      } finally {
        active = false
        pump()
      }
    })()
  }
  return {
    state,
    refresh,
    dispose() {
      disposed = true
      pending = false
    }
  }
}
