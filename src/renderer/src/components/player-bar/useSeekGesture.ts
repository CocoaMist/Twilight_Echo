import { onBeforeUnmount, ref, watch } from 'vue'

/** One preview/commit contract for the main bar and satellite player. */
export function useSeekGesture(options: {
  duration: () => number
  disabled: () => boolean
  identity?: () => unknown
  commit: (seconds: number) => void
}) {
  const preview = ref<number | null>(null)
  const keyboardFocus = ref(false)
  let activePointer: number | null = null
  let dragLeft = 0
  let dragWidth = 1
  let dragWindow: Window | null = null
  let dragDocument: Document | null = null

  function onInput(event: Event): void {
    if (options.disabled()) return
    const value = Number((event.target as HTMLInputElement).value)
    if (Number.isFinite(value)) preview.value = Math.min(options.duration(), Math.max(0, value))
  }

  function startPointer(event: PointerEvent): void {
    if (options.disabled() || event.button !== 0) return
    cancel()
    event.preventDefault()
    const slider = event.currentTarget as HTMLInputElement
    const bounds = slider.getBoundingClientRect()
    dragLeft = bounds.left
    dragWidth = Math.max(1, bounds.width)
    activePointer = event.pointerId
    slider.focus({ preventScroll: true })
    keyboardFocus.value = false
    slider.setPointerCapture(event.pointerId)
    dragDocument = slider.ownerDocument
    dragWindow = dragDocument.defaultView
    dragDocument.addEventListener('visibilitychange', cancelWhenHidden)
    dragWindow?.addEventListener('pointermove', movePointer, true)
    dragWindow?.addEventListener('pointerup', endPointer, true)
    dragWindow?.addEventListener('pointercancel', cancelPointer, true)
    dragWindow?.addEventListener('blur', cancel)
    movePointer(event)
  }

  function movePointer(event: PointerEvent): void {
    if (event.pointerId !== activePointer || options.disabled()) return
    // Measure once on press; dragging never reads layout or sends engine IPC.
    preview.value =
      Math.min(1, Math.max(0, (event.clientX - dragLeft) / dragWidth)) * options.duration()
  }

  function cancel(): void {
    activePointer = null
    preview.value = null
    dragWindow?.removeEventListener('pointermove', movePointer, true)
    dragWindow?.removeEventListener('pointerup', endPointer, true)
    dragWindow?.removeEventListener('pointercancel', cancelPointer, true)
    dragWindow?.removeEventListener('blur', cancel)
    dragDocument?.removeEventListener('visibilitychange', cancelWhenHidden)
    dragWindow = null
    dragDocument = null
  }

  function cancelWhenHidden(): void {
    if (dragDocument?.hidden) cancel()
  }

  function cancelPointer(event: PointerEvent): void {
    if (event.pointerId === activePointer) cancel()
  }

  function endPointer(event: PointerEvent): void {
    if (event.pointerId !== activePointer) return
    movePointer(event)
    commit()
  }

  function commit(): void {
    const value = preview.value
    const canCommit = !options.disabled() && value !== null
    // Clear first: a synchronous track change caused by seek cannot re-commit.
    cancel()
    if (canCommit) options.commit(value)
  }

  function onFocus(event: FocusEvent): void {
    keyboardFocus.value = (event.target as HTMLInputElement).matches(':focus-visible')
  }

  function onBlur(): void {
    keyboardFocus.value = false
    cancel()
  }

  watch(options.disabled, cancel, { flush: 'sync' })
  if (options.identity) watch(options.identity, cancel, { flush: 'sync' })
  onBeforeUnmount(cancel)
  return {
    preview,
    keyboardFocus,
    onInput,
    startPointer,
    endPointer,
    commit,
    cancel,
    onFocus,
    onBlur
  }
}
