/** Auto-activation for related, immediately available content views. */
export function getTabDestination(
  key: string,
  index: number,
  count: number,
  vertical = false
): number | null {
  if (count === 0) return null
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  const previous = vertical ? 'ArrowUp' : 'ArrowLeft'
  const next = vertical ? 'ArrowDown' : 'ArrowRight'
  if (key === previous) return (index - 1 + count) % count
  if (key === next) return (index + 1) % count
  return null
}

export function onTabKeydown(event: KeyboardEvent): void {
  const list = event.currentTarget as HTMLElement
  const target = event.target as HTMLElement
  const current = target.closest<HTMLElement>('[role="tab"]')
  if (!current || !list.contains(current)) return
  const tabs = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]')).filter(
    (tab) => !tab.hasAttribute('disabled') && tab.getAttribute('aria-disabled') !== 'true'
  )
  const index = tabs.indexOf(current)
  if (index < 0) return
  const destination = getTabDestination(
    event.key,
    index,
    tabs.length,
    list.getAttribute('aria-orientation') === 'vertical'
  )
  if (destination === null) return
  event.preventDefault()
  event.stopPropagation()
  tabs[destination].focus()
  tabs[destination].click()
}
