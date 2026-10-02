import { onBeforeUnmount, onMounted, ref } from 'vue'

export function useWindowChrome(preview: () => boolean) {
  const maximized = ref(false)
  let active = false
  let receivedEvent = false
  let unsubscribe: (() => void) | undefined
  onMounted(() => {
    if (preview()) return
    active = true
    // Subscribe before reading. A maximize event can race the initial reply.
    unsubscribe = window.api.window.onStateChanged?.((state) => {
      if (!active) return
      receivedEvent = true
      maximized.value = state.maximized
    })
    void window.api.window
      .getState?.()
      .then((state) => {
        if (active && !receivedEvent) maximized.value = state.maximized
      })
      .catch(() => {
        // A window being destroyed may reject the initial read. Future events
        // remain authoritative; never fabricate a toggled caption state.
      })
  })
  onBeforeUnmount(() => {
    active = false
    unsubscribe?.()
  })
  return { maximized }
}
