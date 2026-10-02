import { computed, ref, shallowRef } from 'vue'
import {
  createInitialAppUpdateSnapshot,
  type AppUpdateClient,
  type AppUpdatePreferencePatch,
  type AppUpdateSnapshot
} from '../../../shared/appUpdate.ts'

export function createAppUpdateStore(getApi: () => AppUpdateClient) {
  const state = shallowRef(createInitialAppUpdateSnapshot())
  const error = ref('')
  const pending = ref(false)
  let users = 0,
    generation = 0
  let unsubscribe: (() => void) | null = null
  const connectionError = ref('')
  function friendlyError(failure: unknown): string {
    const message = failure instanceof Error ? failure.message : String(failure)
    if (/No handler registered|is not a function/.test(message)) {
      return '更新服务尚未就绪，请完全退出并重新启动应用后重试。也可打开发布页查看最新版本。'
    }
    return '暂时无法连接更新服务，请稍后重试。'
  }
  const busy = computed(
    () =>
      pending.value ||
      state.value.checking ||
      ['resolving', 'downloading', 'retrying', 'verifying', 'cancelling', 'installing'].includes(
        state.value.progress.phase
      )
  )
  function apply(snapshot: AppUpdateSnapshot): void {
    if (snapshot.revision >= state.value.revision) state.value = snapshot
  }
  function connect(): () => void {
    users++
    if (users === 1) {
      const epoch = ++generation
      try {
        const api = getApi()
        // Subscribe first; revisions prevent a slow snapshot from overwriting a newer event.
        unsubscribe = api.onUpdateState((snapshot) => {
          if (epoch === generation) apply(snapshot)
        })
        void api
          .getUpdateState()
          .then((snapshot) => {
            if (epoch === generation) {
              apply(snapshot)
              connectionError.value = ''
            }
          })
          .catch((failure) => {
            if (epoch === generation) connectionError.value = friendlyError(failure)
          })
      } catch (failure) {
        connectionError.value = friendlyError(failure)
      }
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--users === 0) {
        generation++
        unsubscribe?.()
        unsubscribe = null
      }
    }
  }
  async function run(operation: (api: AppUpdateClient) => Promise<unknown>): Promise<void> {
    if (pending.value) return
    pending.value = true
    error.value = ''
    try {
      const api = getApi()
      const result = (await operation(api)) as {
        ok?: boolean
        error?: string
        message?: string
        cancelled?: boolean
      }
      if (result?.ok === false && !result.cancelled) error.value = result.error ?? '更新失败'
      // Also reconciles failed invokes/actions after a window reload or a missed event.
      try {
        apply(await api.getUpdateState())
        connectionError.value = ''
      } catch (failure) {
        connectionError.value = friendlyError(failure)
      }
    } catch (failure) {
      error.value = friendlyError(failure)
    } finally {
      pending.value = false
    }
  }
  return {
    state,
    error,
    connectionError,
    busy,
    connect,
    check: () =>
      run(async (api) => {
        const revision = state.value.revision
        const check = await api.checkForUpdates()
        // Preserve the action result even if an older main process cannot provide snapshots.
        if (check && state.value.revision === revision) {
          state.value = { ...state.value, check, checkedAt: Date.now(), checking: false }
        }
        return check
      }),
    download: () => run((api) => api.downloadUpdate()),
    install: () => run((api) => api.installUpdate()),
    preferences: (patch: AppUpdatePreferencePatch) => run((api) => api.setUpdatePreferences(patch)),
    dismiss: (action: 'skip' | 'later') => run((api) => api.dismissUpdate(action)),
    cancel: async (): Promise<void> => {
      // Cancellation must remain available while the download invoke is pending.
      try {
        await getApi().cancelUpdateDownload()
        apply(await getApi().getUpdateState())
      } catch {
        error.value = '取消下载失败，请重试'
      }
    }
  }
}

let instance: ReturnType<typeof createAppUpdateStore> | null = null
export function useAppUpdateStore() {
  instance ??= createAppUpdateStore(() => window.api.app)
  return instance
}
