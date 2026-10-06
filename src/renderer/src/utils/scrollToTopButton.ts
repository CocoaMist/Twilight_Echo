import {
  SCROLL_TOP_BUTTON_SIZE,
  isScrollTopContainerEligible,
  isScrollTopRevealed,
  resolveScrollTopAnchor,
  type ScrollTopAnchor,
  type ScrollTopObstruction
} from './scrollToTopPolicy'
import { scrollMotionBehavior } from '../app/scrollMotion'

/**
 * One shared "back to top" control for every scroll container in the window.
 *
 * The renderer has dozens of independent scroll containers spread across pages,
 * drawers and dialogs, so this is delegated the same way autoHideScrollbars.ts
 * delegates: a document-level listener resolves whichever container the user is
 * scrolling or pointing at, and a single fixed-position button is anchored to
 * that container's bottom-right corner. Containers opt out with
 * `data-te-scroll-top="off"`; `inert` subtrees (the theme studio live preview)
 * are skipped automatically.
 */

const BUTTON_CLASS = 'te-scroll-top'
const SKIP_SELECTOR = '[inert], [data-te-scroll-top="off"]'
/** Geometry and occlusion only change on layout, not while scrolling. */
const GEOMETRY_REFRESH_INTERVAL_MS = 200
/** Outlasts `--te-motion-page` so a page swap cannot leave the control behind. */
const NAVIGATION_SETTLE_MS = 460

let button: HTMLButtonElement | null = null
let scroller: HTMLElement | null = null
let anchor: ScrollTopAnchor | null = null
let cachedClientHeight = 0
let cachedScrollHeight = 0
let geometryStamp = Number.NEGATIVE_INFINITY
let appliedAnchor = ''
let visible = false
let frame: number | null = null
let pointerFrame: number | null = null
let pendingPointerTarget: Element | null = null
let settleTimer: number | null = null

function isVerticallyScrollable(element: HTMLElement): boolean {
  if (element.scrollHeight <= element.clientHeight + 1) return false
  const overflowY = window.getComputedStyle(element).overflowY
  return /(auto|scroll|overlay)/.test(overflowY)
}

function findScrollTarget(start: Element | null): HTMLElement | null {
  if (!start || start.closest(SKIP_SELECTOR)) return null
  let current: HTMLElement | null =
    start instanceof HTMLElement ? start : (start.parentElement ?? null)
  while (current) {
    if (isVerticallyScrollable(current)) return current
    current = current.parentElement
  }
  return null
}

function ensureButton(): HTMLButtonElement {
  if (button) return button
  const element = document.createElement('button')
  element.type = 'button'
  element.className = BUTTON_CLASS
  element.title = '回到开头'
  element.setAttribute('aria-label', '回到开头')
  element.dataset.teScrollTopVisible = 'false'
  // Size stays here rather than in base.css: the anchor math reserves exactly
  // this box, so a theme resizing the control would misplace it.
  element.style.width = `${SCROLL_TOP_BUTTON_SIZE}px`
  element.style.height = `${SCROLL_TOP_BUTTON_SIZE}px`
  const icon = document.createElement('i')
  icon.className = 'ph ph-arrow-up'
  icon.setAttribute('aria-hidden', 'true')
  element.append(icon)
  element.addEventListener('click', onButtonClick)
  document.body.append(element)
  button = element
  return element
}

/**
 * The bar overlaps the bottom of every full-height page container, so the
 * control has to stop above it. An auto-hidden mini bar keeps its layout box
 * while translated away — the shell publishes both hidden states as flags.
 */
function resolvePlayerBarObstruction(): ScrollTopObstruction | null {
  const shell = document.querySelector<HTMLElement>('.player-bar-shell')
  if (!shell) return null
  if (shell.dataset.tePlaybarHidden === 'true') return null
  if (shell.dataset.tePlaybarVisibility === 'hidden') return null
  const rect = shell.getBoundingClientRect()
  if (rect.height <= 0) return null
  return { top: rect.top, left: rect.left, right: rect.right }
}

/**
 * Hit-testing the spot the control wants answers the only question that matters
 * — "would a click there land in this container?" — without knowing anybody's
 * z-index. It covers a container left scrolled under a full overlay (the
 * now-playing page, a modal, the settings surface) and a panel that only takes
 * the corner, such as the playback queue drawer above the player bar. The
 * control itself is filtered out of the stack so it cannot mask its own probe.
 */
function isCovered(target: HTMLElement, at: ScrollTopAnchor): boolean {
  const x = Math.round(at.left + SCROLL_TOP_BUTTON_SIZE / 2)
  const y = Math.round(at.top + SCROLL_TOP_BUTTON_SIZE / 2)
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return true
  for (const hit of document.elementsFromPoint(x, y)) {
    if (button && (hit === button || button.contains(hit))) continue
    return !(hit === target || target.contains(hit) || hit.contains(target))
  }
  return true
}

function refreshGeometry(target: HTMLElement, now: number): void {
  geometryStamp = now
  anchor = null
  cachedClientHeight = target.clientHeight
  cachedScrollHeight = target.scrollHeight
  if (
    !isScrollTopContainerEligible({
      clientHeight: cachedClientHeight,
      scrollHeight: cachedScrollHeight
    })
  ) {
    return
  }
  const candidate = resolveScrollTopAnchor({
    rect: target.getBoundingClientRect(),
    clientWidth: target.clientWidth,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    obstruction: resolvePlayerBarObstruction()
  })
  if (!candidate) return
  if (isCovered(target, candidate)) return
  anchor = candidate
}

function applyAnchor(next: ScrollTopAnchor): void {
  const element = ensureButton()
  const key = `${next.left}:${next.top}`
  if (appliedAnchor === key) return
  appliedAnchor = key
  element.style.left = `${next.left}px`
  element.style.top = `${next.top}px`
}

function setVisible(next: boolean): void {
  if (visible === next) return
  visible = next
  if (!next && !button) return
  ensureButton().dataset.teScrollTopVisible = next ? 'true' : 'false'
}

function update(): void {
  const target = scroller
  if (!target || !target.isConnected || target.clientHeight === 0) {
    setVisible(false)
    return
  }
  const now = performance.now()
  if (now - geometryStamp >= GEOMETRY_REFRESH_INTERVAL_MS) refreshGeometry(target, now)
  if (!anchor) {
    setVisible(false)
    return
  }
  const revealed = isScrollTopRevealed({
    scrollTop: target.scrollTop,
    clientHeight: cachedClientHeight,
    scrollHeight: cachedScrollHeight
  })
  if (!revealed) {
    setVisible(false)
    return
  }
  applyAnchor(anchor)
  setVisible(true)
}

function scheduleUpdate(): void {
  if (frame !== null || document.hidden) return
  frame = window.requestAnimationFrame(() => {
    frame = null
    update()
  })
}

function setScroller(next: HTMLElement | null): void {
  if (scroller === next) return
  scroller = next
  anchor = null
  appliedAnchor = ''
  geometryStamp = Number.NEGATIVE_INFINITY
  setVisible(false)
  scheduleUpdate()
}

function invalidateGeometry(): void {
  geometryStamp = Number.NEGATIVE_INFINITY
  scheduleUpdate()
}

/** Page swaps mount and unmount containers without a scroll event of their own. */
function scheduleSettleCheck(): void {
  if (document.hidden) return
  invalidateGeometry()
  if (settleTimer !== null) window.clearTimeout(settleTimer)
  settleTimer = window.setTimeout(() => {
    settleTimer = null
    invalidateGeometry()
  }, NAVIGATION_SETTLE_MS)
}

function onButtonClick(): void {
  const target = scroller
  if (!target) return
  // Visibility is left to the scroll events the animation emits, so the control
  // fades exactly when the offset drops back under the reveal distance.
  target.scrollTo({ top: 0, behavior: scrollMotionBehavior() })
}

function onScroll(event: Event): void {
  if (document.hidden) return
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  if (target === scroller) {
    scheduleUpdate()
    return
  }
  if (target.closest(SKIP_SELECTOR)) {
    setScroller(null)
    return
  }
  // A horizontal carousel inside a scrolled page must not steal the control.
  if (!isVerticallyScrollable(target)) return
  setScroller(target)
}

function applyPointerTarget(): void {
  const target = pendingPointerTarget
  pendingPointerTarget = null
  if (!target) return
  // Pointing at the control itself must never retarget or hide it.
  if (button && (target === button || button.contains(target))) return
  const next = findScrollTarget(target)
  // Hovering non-scrollable chrome keeps whichever container is already active.
  if (next) setScroller(next)
}

function onPointerMove(event: PointerEvent): void {
  if (document.hidden) return
  pendingPointerTarget = event.target instanceof Element ? event.target : null
  if (pointerFrame !== null) return
  pointerFrame = window.requestAnimationFrame(() => {
    pointerFrame = null
    applyPointerTarget()
  })
}

/** Escape closes overlays and Enter activates navigation, both without a scroll. */
function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape' || event.key === 'Enter') scheduleSettleCheck()
}

function cancelPendingUpdates(): void {
  if (frame !== null) window.cancelAnimationFrame(frame)
  if (pointerFrame !== null) window.cancelAnimationFrame(pointerFrame)
  if (settleTimer !== null) window.clearTimeout(settleTimer)
  frame = null
  pointerFrame = null
  settleTimer = null
  pendingPointerTarget = null
}

function onVisibilityChange(): void {
  if (document.hidden) {
    cancelPendingUpdates()
    setVisible(false)
  } else invalidateGeometry()
}

export function installScrollToTopButton(): () => void {
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  document.addEventListener('pointermove', onPointerMove, { passive: true })
  document.addEventListener('click', scheduleSettleCheck, { capture: true, passive: true })
  document.addEventListener('keydown', onKeyDown, { capture: true, passive: true })
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('resize', invalidateGeometry, { passive: true })

  return () => {
    document.removeEventListener('scroll', onScroll, true)
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('click', scheduleSettleCheck, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('resize', invalidateGeometry)
    cancelPendingUpdates()
    button?.removeEventListener('click', onButtonClick)
    button?.remove()
    button = null
    scroller = null
    anchor = null
    appliedAnchor = ''
    visible = false
    geometryStamp = Number.NEGATIVE_INFINITY
  }
}
