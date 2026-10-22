import { onBeforeUnmount, onMounted, watch } from 'vue'

type RefreshReason = 'activate' | 'poll' | 'manual'

/** Keep mounted settings drafts intact while their native status queries are idle. */
export function useVisibleSettingsPolling(
  active: () => boolean,
  intervalMs: number,
  request: (isCurrent: () => boolean, reason: RefreshReason) => Promise<void>
): () => Promise<void> {
  let mounted = false
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const visible = (): boolean => mounted && active() && document.visibilityState !== 'hidden'

  function stop(): void {
    ++generation
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  async function refresh(reason: RefreshReason = 'manual'): Promise<void> {
    if (!visible()) return
    stop()
    const currentGeneration = generation
    const isCurrent = (): boolean => visible() && generation === currentGeneration
    try {
      await request(isCurrent, reason)
    } finally {
      // A slow reply from a hidden or previous visit cannot restart polling.
      if (isCurrent() && intervalMs > 0) {
        timer = setTimeout(() => {
          timer = null
          void refresh('poll')
        }, intervalMs)
      }
    }
  }

  function updateVisibility(): void {
    stop()
    if (visible()) void refresh('activate')
  }

  watch(active, updateVisibility, { flush: 'sync' })
  onMounted(() => {
    mounted = true
    document.addEventListener('visibilitychange', updateVisibility)
    updateVisibility()
  })
  onBeforeUnmount(() => {
    mounted = false
    stop()
    document.removeEventListener('visibilitychange', updateVisibility)
  })

  return () => refresh()
}
