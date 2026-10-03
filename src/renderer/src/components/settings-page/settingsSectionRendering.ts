/** Keep the measured height of skipped cards so scrolling never uses guessed sizes. */
export function createSettingsSectionRendering(
  page: HTMLElement,
  onLayoutChange: () => void
): { prepareNavigation: () => void; finishNavigation: () => void; dispose: () => void } {
  const sections = new Set(
    page.querySelectorAll<HTMLElement>('.settings-preview-stack > .preview-section')
  )
  const heights = new WeakMap<Element, number>()
  let finishFrame = 0
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const section = entry.target as HTMLElement
      if (!sections.has(section) || heights.get(section) === entry.contentRect.height) continue
      const height = entry.contentRect.height
      heights.set(section, height)
      // ResizeObserver supplies content-box sizes without a synchronous layout read.
      // Own the placeholder size: Chromium's remembered `auto` size can survive
      // a navigation measurement and restore stale geometry after a resize.
      section.style.setProperty('--settings-section-height', `${height}px`)
      section.classList.add('settings-section-measured')
    }
    onLayoutChange()
  })
  observer.observe(page)
  const layout = page.querySelector('.settings-preview-layout')
  if (layout) observer.observe(layout)
  for (const section of sections) observer.observe(section)

  return {
    prepareNavigation() {
      // Resolve all preceding cards before reading a deep-link target's position.
      // Their remembered heights may be stale after a width/font/density change.
      if (finishFrame) window.cancelAnimationFrame(finishFrame)
      finishFrame = 0
      page.classList.add('settings-resolving-navigation')
    },
    finishNavigation() {
      if (finishFrame || !page.classList.contains('settings-resolving-navigation')) return
      // Allow ResizeObserver to publish the fully laid-out content sizes before
      // distant cards use their placeholders again, including instant jumps.
      finishFrame = window.requestAnimationFrame(() => {
        finishFrame = window.requestAnimationFrame(() => {
          finishFrame = 0
          page.classList.remove('settings-resolving-navigation')
          onLayoutChange()
        })
      })
    },
    dispose() {
      if (finishFrame) window.cancelAnimationFrame(finishFrame)
      observer.disconnect()
      page.classList.remove('settings-resolving-navigation')
      for (const section of sections) {
        section.classList.remove('settings-section-measured')
        section.style.removeProperty('--settings-section-height')
      }
    }
  }
}
