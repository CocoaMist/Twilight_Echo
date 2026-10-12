import { ref, type Ref } from 'vue'

export interface SideMenuClearanceOptions {
  showLocalSidebar: Ref<boolean>
  hasPlayerBar: Ref<boolean>
}

const SIDE_MENU_OVERLAP_GAP = 10

export function useSideMenuClearance(options: SideMenuClearanceOptions) {
  const playerBottomClearance = ref(0)
  const sideMenuBottomOffset = ref(0)
  const sideMenuToolsClearance = ref(0)
  let sideMenuMonitorFrame: number | null = null
  let resizeObserver: ResizeObserver | null = null
  let playbarMutationObserver: MutationObserver | null = null
  let observedSideMenu: HTMLElement | null = null
  let observedPlayerBar: HTMLElement | null = null

  function setSideMenuBottomOffset(offset: number): void {
    const nextOffset = Math.max(0, Math.round(offset))
    if (sideMenuBottomOffset.value !== nextOffset) {
      sideMenuBottomOffset.value = nextOffset
    }
  }

  function measureSideMenuClearance(): void {
    const playerBar = document.querySelector<HTMLElement>('.player-bar-shell')
    const playerBarRect = playerBar?.getBoundingClientRect()
    playerBottomClearance.value =
      options.hasPlayerBar.value &&
      playerBar?.dataset.tePlaybarHidden !== 'true' &&
      playerBarRect &&
      playerBarRect.height > 0 &&
      playerBarRect.bottom > 0 &&
      playerBarRect.top < window.innerHeight
        ? Math.max(0, Math.ceil(window.innerHeight - playerBarRect.top))
        : 0
    if (!options.showLocalSidebar.value || !options.hasPlayerBar.value) {
      setSideMenuBottomOffset(0)
      sideMenuToolsClearance.value = 0
      return
    }

    const sideMenu = document.querySelector<HTMLElement>('.side-menu')

    if (!sideMenu || !playerBar || !playerBarRect) {
      setSideMenuBottomOffset(0)
      sideMenuToolsClearance.value = 0
      return
    }

    // An auto-hidden mini bar is translated out of view but keeps its layout box,
    // so its rect would still push the sidebar up. The shell flags the state.
    if (playerBar.dataset.tePlaybarHidden === 'true') {
      setSideMenuBottomOffset(0)
      sideMenuToolsClearance.value = 0
      return
    }

    const sideMenuRect = sideMenu.getBoundingClientRect()
    const customShell = document.documentElement.dataset.teShellLayout === 'custom'
    // translate3d changes the visual rect throughout the slide. Default content
    // padding must use the resting box so crossing the player's left edge cannot
    // change the scroller height or scroll position halfway through the motion.
    const sideMenuLeft = customShell ? sideMenuRect.left : sideMenu.offsetLeft
    const sideMenuRight = customShell ? sideMenuRect.right : sideMenuLeft + sideMenu.offsetWidth
    const overlapsHorizontally =
      playerBarRect.left < sideMenuRight && playerBarRect.right > sideMenuLeft
    // Reserve content padding only when the bar actually covers the menu. A bar
    // beside it must leave the tools at the bottom, including in custom shells.
    sideMenuToolsClearance.value =
      overlapsHorizontally &&
      playerBarRect.height > 0 &&
      playerBarRect.top < window.innerHeight &&
      playerBarRect.bottom > sideMenuRect.top
        ? Math.max(0, Math.round(sideMenuRect.bottom - playerBarRect.top + SIDE_MENU_OVERLAP_GAP))
        : 0
    // Default navigation owns a stable full-height material surface. Only its
    // content clears the player; resizing the backdrop when playback appears,
    // hides or changes shape makes the sidebar jump and rebuild its blur layer.
    // Custom shells retain their explicit, grid-dependent clearance contract.
    if (!customShell) {
      setSideMenuBottomOffset(0)
      return
    }
    /**
     * Test the overlap against the bottom the menu would have with no clearance
     * applied, not its current one. Once the offset lifts the menu, its measured
     * bottom clears the bar, so measuring that directly would report "no overlap",
     * reset the offset to 0, drop the menu back under the bar and overlap again —
     * and the ResizeObserver watching the menu's own height would drive that
     * oscillation forever. Adding the offset back makes the measurement a fixed
     * point: the second pass computes the same number and the ref stops changing.
     */
    const sideMenuNaturalBottom = sideMenuRect.bottom + sideMenuBottomOffset.value
    const overlapsVertically =
      playerBarRect.top < sideMenuNaturalBottom && playerBarRect.bottom > sideMenuRect.top

    if (!overlapsHorizontally || !overlapsVertically) {
      setSideMenuBottomOffset(0)
      return
    }

    setSideMenuBottomOffset(window.innerHeight - playerBarRect.top + SIDE_MENU_OVERLAP_GAP)
  }

  function stopSideMenuMonitor(): void {
    if (sideMenuMonitorFrame !== null) {
      cancelAnimationFrame(sideMenuMonitorFrame)
      sideMenuMonitorFrame = null
    }
  }

  function observeGeometry(): void {
    const sideMenu = document.querySelector<HTMLElement>('.side-menu')
    const playerBar = document.querySelector<HTMLElement>('.player-bar-shell')
    if (sideMenu === observedSideMenu && playerBar === observedPlayerBar) return

    observedSideMenu = sideMenu
    observedPlayerBar = playerBar
    resizeObserver?.disconnect()
    playbarMutationObserver?.disconnect()

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => scheduleMeasure())
      if (sideMenu) resizeObserver.observe(sideMenu)
      if (playerBar) resizeObserver.observe(playerBar)
    }
    if (typeof MutationObserver !== 'undefined' && playerBar) {
      playbarMutationObserver = new MutationObserver(() => scheduleMeasure())
      playbarMutationObserver.observe(playerBar, {
        attributes: true,
        // The shape attribute matters as much as the hidden one: standard floats
        // 18px clear of the menu while compact spans the window, so switching
        // shape changes whether the bar overlaps at all. Without it here, a shape
        // switch left the previous shape's offset in place until some other
        // mutation happened to trigger a re-measure.
        attributeFilter: [
          'class',
          'data-te-playbar-hidden',
          'data-te-playbar-visibility',
          'data-te-playbar-mode'
        ]
      })
    }
  }

  function scheduleMeasure(): void {
    if (document.hidden || sideMenuMonitorFrame !== null) return
    sideMenuMonitorFrame = requestAnimationFrame(() => {
      sideMenuMonitorFrame = null
      measureSideMenuClearance()
      observeGeometry()
    })
  }

  function startSideMenuMonitor(): void {
    if (document.hidden) return
    observeGeometry()
    scheduleMeasure()
  }

  function resetSideMenuClearance(): void {
    stopSideMenuMonitor()
    setSideMenuBottomOffset(0)
    sideMenuToolsClearance.value = 0
    playerBottomClearance.value = 0
  }

  function onDocumentVisibilityChange(): void {
    if (document.hidden) {
      stopSideMenuMonitor()
      return
    }
    startSideMenuMonitor()
  }

  const onWindowResize = (): void => scheduleMeasure()
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', onWindowResize)
  }
  document.addEventListener('visibilitychange', onDocumentVisibilityChange)

  return {
    playerBottomClearance,
    sideMenuBottomOffset,
    sideMenuToolsClearance,
    startSideMenuMonitor,
    stopSideMenuMonitor,
    resetSideMenuClearance,
    measureSideMenuClearance,
    dispose: () => {
      stopSideMenuMonitor()
      resizeObserver?.disconnect()
      playbarMutationObserver?.disconnect()
      resizeObserver = null
      playbarMutationObserver = null
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('resize', onWindowResize)
      }
      document.removeEventListener('visibilitychange', onDocumentVisibilityChange)
    }
  }
}
