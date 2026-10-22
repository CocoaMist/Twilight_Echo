import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/** Satellite interpolation is needed only while its visible playback advances. */
export function useMiniPlayerClock(advancing: () => boolean) {
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | null = null
  let mounted = false

  function reconcile(): void {
    now.value = Date.now()
    const active = mounted && advancing() && !document.hidden
    if (!active && timer !== null) {
      clearInterval(timer)
      timer = null
    } else if (active && timer === null) {
      timer = setInterval(() => {
        now.value = Date.now()
      }, 50)
    }
  }

  watch(advancing, reconcile, { flush: 'sync' })
  onMounted(() => {
    mounted = true
    document.addEventListener('visibilitychange', reconcile)
    reconcile()
  })
  onBeforeUnmount(() => {
    mounted = false
    reconcile()
    document.removeEventListener('visibilitychange', reconcile)
  })
  return now
}
