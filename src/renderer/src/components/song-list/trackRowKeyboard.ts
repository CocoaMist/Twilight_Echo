/** Keep row playback and selection separate from nested controls' native keys. */
export function trackRowKeyAction(
  event: KeyboardEvent,
  selectable = true
): 'play' | 'select' | null {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.target !== event.currentTarget ||
    event.altKey ||
    event.metaKey
  )
    return null
  const action =
    event.key === 'Enter' && !event.ctrlKey && !event.shiftKey
      ? 'play'
      : selectable && event.key === ' ' && !event.shiftKey
        ? 'select'
        : null
  // Consume repeats too, so holding Space never scrolls or triggers global play/pause.
  if (action) event.preventDefault()
  return event.repeat ? null : action
}
