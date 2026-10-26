import {
  computed,
  getCurrentInstance,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  watch,
  type Ref
} from 'vue'
import type { Track } from '../../types/music'
import {
  createPlaybackQueueDisplayItems,
  getPlaybackQueueScrollTopForIndex,
  getPlaybackQueueWindow,
  PLAYBACK_QUEUE_ROW_HEIGHT
} from '../../utils/playbackQueueVirtualization.ts'

export function usePlaybackQueueVirtualScroll(
  queue: Readonly<Ref<readonly Track[]>>,
  queueIndex: Ref<number>,
  open: Ref<boolean>
) {
  const containerRef = ref<HTMLElement | null>(null)
  const scrollTop = ref(0)
  const viewportHeight = ref(0)

  const visibleRange = computed(() =>
    getPlaybackQueueWindow(queue.value.length, scrollTop.value, viewportHeight.value)
  )
  const visibleItems = computed(() =>
    createPlaybackQueueDisplayItems(queue.value, visibleRange.value)
  )
  const totalHeight = computed(() => queue.value.length * PLAYBACK_QUEUE_ROW_HEIGHT)
  const translateY = computed(() => visibleRange.value.start * PLAYBACK_QUEUE_ROW_HEIGHT)

  function updateViewport(): void {
    viewportHeight.value = containerRef.value?.clientHeight ?? 0
  }

  function onScroll(event: Event): void {
    scrollTop.value = (event.target as HTMLElement).scrollTop
  }

  function scrollToCurrent(): void {
    const container = containerRef.value
    if (!container || queueIndex.value < 0) return
    const nextTop = getPlaybackQueueScrollTopForIndex(
      queueIndex.value,
      queue.value.length,
      container.clientHeight
    )
    container.scrollTop = nextTop
    scrollTop.value = nextTop
  }

  async function revealCurrent(): Promise<void> {
    await nextTick()
    updateViewport()
    scrollToCurrent()
  }

  if (getCurrentInstance()) {
    onMounted(() => {
      updateViewport()
      window.addEventListener('resize', updateViewport)
    })

    onUnmounted(() => window.removeEventListener('resize', updateViewport))
  }

  watch(open, (isOpen) => {
    if (isOpen) void revealCurrent()
  })

  watch(queueIndex, () => {
    if (open.value) void revealCurrent()
  })

  return {
    containerRef,
    visibleItems,
    totalHeight,
    translateY,
    onScroll,
    scrollToCurrent
  }
}
