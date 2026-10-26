import { useCoreConnection } from './coreConnection.ts'
import { createCorePlayerStore } from './player/corePlayerStore.ts'
import { useSettingsStore } from './useSettingsStore.ts'
import { configurePlayerStoreHmr } from './playerStoreHmr.ts'

let player: ReturnType<typeof createCorePlayerStore> | null = null

/** A window attaches to Core; rebuilding this view never restores or reloads playback. */
export function useCorePlayerStore() {
  return (player ??= createCorePlayerStore(useCoreConnection(), {
    useCoverTheme: () => useSettingsStore().settings.value.useCoverTheme
  }))
}

export function disposeCorePlayerStore(): void {
  player?.dispose()
  player = null
}

configurePlayerStoreHmr(import.meta.hot, () => window.location.reload(), disposeCorePlayerStore)
