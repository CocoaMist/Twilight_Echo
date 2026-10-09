import { computed, onBeforeUnmount, onMounted, ref, watch, type ComputedRef } from 'vue'
import { getPlaybackQueueWindow } from '../../utils/playbackQueueVirtualization.ts'

const STREAMING_ROW_HEIGHT = 64
const STREAMING_OVERSCAN = 8

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let current = el?.parentElement ?? null
  while (current) {
    const style = window.getComputedStyle(current)
    if (
      /(auto|scroll|overlay)/.test(style.overflowY) &&
      current.scrollHeight > current.clientHeight
    ) {
      return current
    }
    current = current.parentElement
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null
}

export function useProgressiveList<T>(
  source: () => readonly T[],
  options: { initial?: number; step?: number; rowHeight?: number; overscan?: number } = {}
): {
  visibleItems: ComputedRef<T[]>
  visibleStart: ComputedRef<number>
  paddingTop: ComputedRef<number>
  totalHeight: ComputedRef<number>
  hasMoreToRender: ComputedRef<boolean>
  listRef: (el: unknown) => void
  scrollToIndex: (index: number) => void
} {
  const rowHeight = ref(options.rowHeight ?? STREAMING_ROW_HEIGHT)
  const overscan = options.overscan ?? STREAMING_OVERSCAN
  const items = computed(source)
  const scrollTop = ref(0)
  const viewportHeight = ref(720)
  const listOffsetTop = ref(0)
  let rowObserver: ResizeObserver | null = null
  let observedRow: Element | null = null
  let listEl: HTMLElement | null = null
  let scrollRoot: HTMLElement | null = null
  let listParent: HTMLElement | null = null
  let measureFrame: number | null = null
  let disposed = false
  const layoutElements = new Set<Element>()

  function onScroll(): void {
    if (!scrollRoot || document.hidden) return
    scrollTop.value = scrollRoot.scrollTop
  }

  function bindScrollRoot(element: HTMLElement | null): void {
    if (scrollRoot === element) return
    if (scrollRoot) {
      scrollRoot.removeEventListener('scroll', onScroll)
      rowObserver?.unobserve(scrollRoot)
    }
    scrollRoot = element
    if (scrollRoot) {
      scrollRoot.addEventListener('scroll', onScroll, { passive: true })
      rowObserver?.observe(scrollRoot)
    }
  }

  function observeRow(): void {
    if (!listEl) return
    const firstRow = listEl.firstElementChild
    if (observedRow === firstRow) return
    if (observedRow) rowObserver?.unobserve(observedRow)
    observedRow = firstRow
    if (firstRow) rowObserver?.observe(firstRow)
  }

  function observeLayout(): void {
    const next = new Set<Element>()
    for (let node: Element | null = listEl; node; node = node.parentElement) {
      next.add(node)
      if (node === scrollRoot) break
      for (
        let sibling = node.previousElementSibling;
        sibling;
        sibling = sibling.previousElementSibling
      )
        next.add(sibling)
    }
    for (const element of layoutElements) {
      if (!next.has(element)) rowObserver?.unobserve(element)
    }
    for (const element of next) {
      if (!layoutElements.has(element)) rowObserver?.observe(element)
    }
    layoutElements.clear()
    for (const element of next) layoutElements.add(element)
  }

  function measure(): void {
    if (!listEl || document.hidden) return
    bindScrollRoot(findScrollParent(listEl))
    if (!scrollRoot) return
    observeLayout()
    observeRow()
    const actualRowHeight = observedRow?.getBoundingClientRect().height
    if (actualRowHeight && Math.abs(actualRowHeight - rowHeight.value) > 0.1) {
      rowHeight.value = actualRowHeight
    }
    const listRect = listEl.getBoundingClientRect()
    const rootRect = scrollRoot.getBoundingClientRect()
    listOffsetTop.value = listRect.top - rootRect.top + scrollRoot.scrollTop
    viewportHeight.value = scrollRoot.clientHeight
    scrollTop.value = scrollRoot.scrollTop
  }

  function scheduleMeasure(): void {
    if (measureFrame !== null || document.hidden) return
    measureFrame = requestAnimationFrame(() => {
      measureFrame = null
      measure()
    })
  }

  function listRef(el: unknown): void {
    if (disposed) return
    const next = el instanceof HTMLElement ? el : null
    if (listEl === next && listParent === next?.parentElement) {
      observeRow()
      return
    }
    if (listEl) rowObserver?.unobserve(listEl)
    listEl = next
    listParent = next?.parentElement ?? null
    if (listEl) rowObserver?.observe(listEl)
    bindScrollRoot(findScrollParent(next))
    measure()
  }

  function scrollToIndex(index: number): void {
    measure()
    if (!scrollRoot || index < 0 || index >= items.value.length) return
    scrollRoot.scrollTo({
      top: Math.max(
        0,
        listOffsetTop.value + index * rowHeight.value - (viewportHeight.value - rowHeight.value) / 2
      ),
      behavior: 'instant'
    })
    onScroll()
  }

  const windowRange = computed(() =>
    getPlaybackQueueWindow(
      items.value.length,
      Math.max(0, scrollTop.value - listOffsetTop.value),
      viewportHeight.value,
      rowHeight.value,
      overscan
    )
  )
  const visibleStart = computed(() => windowRange.value.start)
  const visibleItems = computed(() =>
    items.value.slice(windowRange.value.start, windowRange.value.end)
  )
  const paddingTop = computed(() => windowRange.value.start * rowHeight.value)
  const totalHeight = computed(() => items.value.length * rowHeight.value)
  const hasMoreToRender = computed(() => false)

  function onVisibilityChange(): void {
    if (document.hidden) {
      if (measureFrame !== null) cancelAnimationFrame(measureFrame)
      measureFrame = null
    } else scheduleMeasure()
  }

  watch(items, scheduleMeasure, { flush: 'post' })
  onMounted(() => {
    rowObserver = new ResizeObserver((entries) => {
      if (document.hidden) return
      for (const entry of entries) {
        if (entry.target !== observedRow) {
          scheduleMeasure()
          continue
        }
        const height = entry.borderBoxSize[0]?.blockSize
        if (height && Math.abs(height - rowHeight.value) > 0.1) {
          scheduleMeasure()
        }
      }
    })
    layoutElements.clear()
    observedRow = null
    measure()
    window.addEventListener('resize', scheduleMeasure)
    document.addEventListener('visibilitychange', onVisibilityChange)
  })

  onBeforeUnmount(() => {
    disposed = true
    rowObserver?.disconnect()
    window.removeEventListener('resize', scheduleMeasure)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    if (measureFrame !== null) cancelAnimationFrame(measureFrame)
    measureFrame = null
    if (scrollRoot) scrollRoot.removeEventListener('scroll', onScroll)
    scrollRoot = null
    listEl = null
    listParent = null
    observedRow = null
    layoutElements.clear()
  })

  return {
    visibleItems,
    visibleStart,
    paddingTop,
    totalHeight,
    hasMoreToRender,
    listRef,
    scrollToIndex
  }
}
