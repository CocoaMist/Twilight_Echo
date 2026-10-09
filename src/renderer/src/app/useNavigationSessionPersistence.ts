import { watch } from 'vue'
import type { UiContribution } from '../extensions/registry'
import type { useAppNavigation } from './useAppNavigation'
import {
  browserNavigationStorage,
  readNavigationSession,
  writeNavigationSession,
  type NavigationSessionStorage
} from './navigationSession.ts'

export function createNavigationSessionPersistence(
  navigation: ReturnType<typeof useAppNavigation>,
  storage: NavigationSessionStorage = browserNavigationStorage()
) {
  const saved = readNavigationSession(storage)
  if (saved) navigation.restoreSession(saved)
  let pending =
    saved && [saved.pageTarget, ...saved.history].some((target) => target.kind === 'plugin')
      ? saved
      : null
  let restoring = false
  let started = false
  let lastWritten: string | null = null

  function flush(): void {
    if (!started) return
    const session = pending ?? navigation.session.value
    const serialized = JSON.stringify(session)
    if (serialized === lastWritten) return
    if (writeNavigationSession(storage, session)) lastWritten = serialized
  }

  // Track user navigation immediately so late plugin loading cannot replace it.
  const stopTracking = watch(
    navigation.session,
    () => {
      if (!restoring) pending = null
    },
    { flush: 'sync' }
  )
  // Batch each navigation action into one small write; exit also flushes synchronously.
  const stopSaving = watch(navigation.session, flush)

  function resolvePluginPages(pages: UiContribution[]): void {
    if (!pending) return
    restoring = true
    navigation.restoreSession(pending, pages)
    pending = null
    restoring = false
    flush()
  }

  return {
    restored: saved !== null,
    start(): void {
      started = true
      flush()
    },
    resolvePluginPages,
    flush,
    stop(): void {
      flush()
      stopTracking()
      stopSaving()
    }
  }
}
