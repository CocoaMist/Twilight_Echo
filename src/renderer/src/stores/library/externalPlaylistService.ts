import { shallowRef, watch } from 'vue'
import type { useMusicStore } from '../useMusicStore.ts'
import { useCoreConnection } from '../coreConnection.ts'
export const externalMatchProgress = shallowRef<
  Record<string, { done: number; total: number; running: boolean }>
>({})
let singleton: ReturnType<typeof createExternalPlaylistService> | undefined
export function getExternalPlaylistService(music: ReturnType<typeof useMusicStore>) {
  return (singleton ??= createExternalPlaylistService(music))
}
export function createExternalPlaylistService(music: ReturnType<typeof useMusicStore>) {
  const core = useCoreConnection()
  let timer: ReturnType<typeof setTimeout> | undefined,
    disposed = false
  async function refresh() {
    const next = { ...externalMatchProgress.value }
    for (const p of music.playlists.value) {
      if (!p.imported) continue
      const status = await core.query('imports.status', { id: p.id })
      if (status) next[p.id] = status
    }
    if (!disposed) externalMatchProgress.value = next
  }
  const stop = watch(
    music.playlists,
    () => {
      void refresh().catch(() => {})
    },
    { immediate: true }
  )
  const off = core.subscribe((message) => {
    if (message.kind !== 'state' || timer) return
    timer = setTimeout(() => {
      timer = undefined
      void refresh().catch(() => {})
    }, 750)
  })
  return {
    run: async (id: string, force = false, entries?: string[]) => {
      await core.command('imports.retry', { id, force, entries })
      await refresh()
    },
    stop: async (id: string) => {
      await core.command('imports.cancel', { id })
      await refresh()
    },
    dispose() {
      disposed = true
      stop()
      off()
      clearTimeout(timer)
      singleton = undefined
    }
  }
}
