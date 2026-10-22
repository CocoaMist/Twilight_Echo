import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, effectScope, nextTick, ref } from 'vue'
import { useSongListVirtualScroll } from './useSongListVirtualScroll.ts'

test('returning from an album restores its parent offset after the transition, ignoring temporary scroll events', async () => {
  const scope = effectScope()
  const key = ref('test:albums')
  const identity = computed(() => key.value)
  const scroll = scope.run(() =>
    useSongListVirtualScroll({
      displayTracks: computed(() => []),
      resetSources: [],
      shouldResetOnSearch: computed(() => false),
      debouncedSearchQuery: ref(''),
      viewKey: computed(() => key.value),
      viewIdentity: identity
    })
  )!
  const container = { clientHeight: 720, scrollTop: 0 } as HTMLElement
  scroll.containerRef.value = container
  scroll.restoreScrollAndMeasure()
  await nextTick()
  container.scrollTop = 2400
  scroll.onScroll({ target: container } as unknown as Event)
  key.value = 'test:albums:detail'
  await nextTick()
  container.scrollTop = 0
  scroll.onScroll({ target: container } as unknown as Event)
  scroll.restoreScrollAndMeasure()
  await nextTick()
  assert.equal(container.scrollTop, 0)
  key.value = 'test:albums'
  await nextTick()
  scroll.onScroll({ target: container } as unknown as Event)
  assert.equal(scroll.scrollTop.value, 2400)
  scroll.restoreScrollAndMeasure()
  await nextTick()
  assert.equal(container.scrollTop, 2400)
  scope.stop()
})

test('larger type scales the DOM rows and virtual window while retaining the first visible recording', async () => {
  const scope = effectScope()
  const fontSize = ref(14)
  const headingHeight = ref(200)
  const scroll = scope.run(() =>
    useSongListVirtualScroll({
      displayTracks: computed(
        () => Array.from({ length: 1000 }, (_, i) => ({ id: String(i) })) as never[]
      ),
      resetSources: [],
      shouldResetOnSearch: computed(() => false),
      debouncedSearchQuery: ref('')
    })
  )!
  const container = {
    clientHeight: 600,
    clientTop: 0,
    scrollTop: 5800,
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => ({
          getPropertyValue: (property: string) =>
            property === '--te-font-size-body' ? fontSize.value + 'px' : '56px'
        })
      }
    },
    getBoundingClientRect: () => ({ top: 0 })
  } as unknown as HTMLElement
  scroll.containerRef.value = container
  scroll.tbodyRef.value = {
    getBoundingClientRect: () => ({ top: headingHeight.value - container.scrollTop })
  } as unknown as HTMLElement
  scroll.updateViewportHeight()
  scroll.restoreScrollAndMeasure()
  await nextTick()
  container.scrollTop = 5800
  scroll.onScroll({ target: container } as unknown as Event)
  const start = scroll.visibleRange.value.start
  headingHeight.value = 250
  fontSize.value = 20
  scroll.updateViewportHeight()
  await nextTick()
  await nextTick()
  assert.equal(scroll.rowHeight.value, 80)
  assert.equal(scroll.totalHeight.value, 80_000)
  assert.equal(
    container.scrollTop,
    8_250,
    'recording 100 stays at the viewport top after the heading also grows'
  )
  assert.equal(scroll.visibleRange.value.start, start)
  assert.equal(scroll.paddingTop.value, start * 80)
  headingHeight.value = 200
  fontSize.value = 14
  scroll.updateViewportHeight()
  await nextTick()
  await nextTick()
  assert.equal(container.scrollTop, 5800)
  scope.stop()
})

test('table coordinates stay relative to the scroller when a themed wrapper becomes the offset parent', () => {
  const scope = effectScope()
  const scroll = scope.run(() =>
    useSongListVirtualScroll({
      displayTracks: computed(
        () => Array.from({ length: 100 }, (_, index) => ({ id: String(index) })) as never[]
      ),
      resetSources: [],
      shouldResetOnSearch: computed(() => false),
      debouncedSearchQuery: ref('')
    })
  )!
  scroll.containerRef.value = {
    clientHeight: 700,
    clientTop: 1,
    scrollTop: 800,
    getBoundingClientRect: () => ({ top: 50 })
  } as unknown as HTMLElement
  scroll.tbodyRef.value = {
    offsetTop: 55,
    getBoundingClientRect: () => ({ top: -451 })
  } as unknown as HTMLElement
  scroll.updateViewportHeight()
  scroll.onScroll({ target: scroll.containerRef.value } as unknown as Event)
  const range = scroll.visibleRange.value
  const firstVisible = Math.floor((800 - 298) / scroll.rowHeight.value)
  assert.ok(
    range.start <= firstVisible && range.end > firstVisible,
    'the row at the viewport top must stay mounted'
  )
  assert.equal(range.start, firstVisible - 6)
  scope.stop()
})

test('returning to a saved view after changing preview typography restores its recording below the new heading', async () => {
  const scope = effectScope()
  const key = ref('test:font-return:all')
  let font = 14
  let heading = 200
  const container = {
    clientHeight: 600,
    clientTop: 0,
    scrollTop: 0,
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => ({
          getPropertyValue: (property: string) =>
            property === '--te-font-size-body' ? font + 'px' : '56px'
        })
      }
    },
    getBoundingClientRect: () => ({ top: 0 })
  } as unknown as HTMLElement
  const scroll = scope.run(() =>
    useSongListVirtualScroll({
      displayTracks: computed(
        () => Array.from({ length: 1000 }, (_, index) => ({ id: String(index) })) as never[]
      ),
      resetSources: [],
      shouldResetOnSearch: computed(() => false),
      debouncedSearchQuery: ref(''),
      viewKey: computed(() => key.value),
      viewIdentity: computed(() => key.value)
    })
  )!
  scroll.containerRef.value = container
  scroll.tbodyRef.value = {
    getBoundingClientRect: () => ({ top: heading - container.scrollTop })
  } as HTMLElement
  scroll.updateViewportHeight()
  scroll.restoreScrollAndMeasure()
  await nextTick()
  await nextTick()
  container.scrollTop = 5800
  scroll.onScroll({ target: container } as unknown as Event)
  key.value = 'test:font-return:detail'
  await nextTick()
  scroll.restoreScrollAndMeasure()
  await nextTick()
  font = 20
  heading = 250
  scroll.updateViewportHeight()
  await nextTick()
  await nextTick()
  key.value = 'test:font-return:all'
  await nextTick()
  scroll.restoreScrollAndMeasure()
  await nextTick()
  await nextTick()
  assert.equal(container.scrollTop, 8250)
  scope.stop()
})

test('compact density and text scaling keep the same recording and virtual stride', async () => {
  const scope = effectScope()
  let densityHeight = 56
  let font = 14
  let heading = 200
  const container = {
    clientHeight: 600,
    clientTop: 0,
    scrollTop: 5800,
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => ({
          getPropertyValue: (property: string) =>
            `${property === '--te-font-size-body' ? font : densityHeight}px`
        })
      }
    },
    getBoundingClientRect: () => ({ top: 0 })
  } as unknown as HTMLElement
  const scroll = scope.run(() =>
    useSongListVirtualScroll({
      displayTracks: computed(
        () => Array.from({ length: 1000 }, (_, i) => ({ id: String(i) })) as never[]
      ),
      resetSources: [],
      shouldResetOnSearch: computed(() => false),
      debouncedSearchQuery: ref('')
    })
  )!
  scroll.containerRef.value = container
  scroll.tbodyRef.value = {
    getBoundingClientRect: () => ({ top: heading - container.scrollTop })
  } as unknown as HTMLElement
  scroll.updateViewportHeight()
  scroll.restoreScrollAndMeasure()
  await nextTick()
  container.scrollTop = 5800
  scroll.onScroll({ target: container } as unknown as Event)
  const firstMounted = scroll.visibleRange.value.start
  assert.equal(scroll.rowHeight.value, 56)
  densityHeight = 48
  scroll.updateViewportHeight()
  await nextTick()
  await nextTick()
  assert.equal(scroll.rowHeight.value, 48)
  assert.equal(scroll.totalHeight.value, 48_000)
  assert.equal(container.scrollTop, 5000)
  assert.equal(scroll.visibleRange.value.start, firstMounted)
  assert.equal(scroll.paddingTop.value, firstMounted * 48)
  font = 20
  heading = 250
  scroll.updateViewportHeight()
  await nextTick()
  await nextTick()
  assert.equal(scroll.rowHeight.value, 69)
  assert.equal(container.scrollTop, 7150)
  assert.equal(scroll.visibleRange.value.start, firstMounted)
  densityHeight = 56
  scroll.updateViewportHeight()
  await nextTick()
  await nextTick()
  assert.equal(scroll.rowHeight.value, 80)
  assert.equal(container.scrollTop, 8250)
  assert.equal(scroll.visibleRange.value.start, firstMounted)
  scope.stop()
})

test('scrollToTrack brings an off-screen row into the virtual window', () => {
  const scope = effectScope()
  const scroll = scope.run(() =>
    useSongListVirtualScroll({
      displayTracks: computed(
        () => Array.from({ length: 4_000 }, (_, index) => ({ id: String(index) })) as never[]
      ),
      resetSources: [],
      shouldResetOnSearch: computed(() => false),
      debouncedSearchQuery: ref('')
    })
  )!
  const container = {
    clientHeight: 700,
    clientTop: 0,
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0 })
  } as unknown as HTMLElement
  scroll.containerRef.value = container
  scroll.tbodyRef.value = {
    getBoundingClientRect: () => ({ top: 280 })
  } as unknown as HTMLElement
  scroll.updateViewportHeight()
  scroll.scrollToTrack(1_234)
  assert.ok(container.scrollTop > 0)
  assert.ok(scroll.visibleRange.value.start <= 1_234)
  assert.ok(scroll.visibleRange.value.end > 1_234)
  scope.stop()
})

test('300k database rows keep full scroll extent with only 200 loaded records', () => {
  const scope = effectScope()
  const scroll = scope.run(() =>
    useSongListVirtualScroll({
      displayTracks: computed(
        () => Array.from({ length: 200 }, (_, index) => ({ id: String(index) })) as never[]
      ),
      itemCount: computed(() => 300_000),
      resetSources: [],
      shouldResetOnSearch: computed(() => false),
      debouncedSearchQuery: ref('')
    })
  )!
  const container = {
    clientHeight: 700,
    clientTop: 0,
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0 })
  } as unknown as HTMLElement
  scroll.containerRef.value = container
  scroll.tbodyRef.value = {
    getBoundingClientRect: () => ({ top: 280 - container.scrollTop })
  } as unknown as HTMLElement
  scroll.updateViewportHeight()
  assert.equal(scroll.totalHeight.value, 300_000 * scroll.rowHeight.value)
  scroll.scrollToTrack(234_567)
  assert.ok(container.scrollTop > 234_000 * scroll.rowHeight.value)
  assert.ok(scroll.visibleRange.value.start <= 234_567)
  assert.ok(scroll.visibleRange.value.end > 234_567)
  assert.ok(
    scroll.visibleRange.value.end - scroll.visibleRange.value.start <=
      Math.ceil(700 / scroll.rowHeight.value) + 12
  )
  assert.equal(scroll.paddingTop.value, scroll.visibleRange.value.start * scroll.rowHeight.value)
  scroll.scrollToTrack(300_100)
  assert.equal(scroll.visibleRange.value.end, 300_000)
  scope.stop()
})

test('a saved deep position waits for database count and real scroll extent before restoration', async () => {
  const scope = effectScope()
  const key = ref('test:sqlite:deep')
  const ready = ref(true)
  const scroll = scope.run(() =>
    useSongListVirtualScroll({
      displayTracks: computed(() => []),
      itemCount: computed(() => (ready.value ? 300_000 : 0)),
      restoreReady: computed(() => ready.value),
      resetSources: [],
      shouldResetOnSearch: computed(() => false),
      debouncedSearchQuery: ref(''),
      viewKey: computed(() => key.value)
    })
  )!
  let top = 0
  const container = {
    clientHeight: 700,
    get scrollTop() {
      return top
    },
    set scrollTop(value) {
      top = ready.value ? value : 0
    }
  } as HTMLElement
  scroll.containerRef.value = container
  scroll.restoreScrollAndMeasure()
  await nextTick()
  container.scrollTop = 15_000_000
  scroll.onScroll({ target: container } as unknown as Event)
  key.value = 'test:sqlite:other'
  await nextTick()
  ready.value = false
  container.scrollTop = 0
  key.value = 'test:sqlite:deep'
  await nextTick()
  scroll.restoreScrollAndMeasure()
  scroll.onScroll({ target: container } as unknown as Event)
  await nextTick()
  assert.equal(container.scrollTop, 0)
  assert.equal(scroll.scrollTop.value, 15_000_000, 'unready DOM must not overwrite saved position')
  ready.value = true
  await nextTick()
  await nextTick()
  assert.equal(container.scrollTop, 15_000_000)
  assert.equal(scroll.scrollTop.value, 15_000_000)
  scope.stop()
})

test('a confirmed new total does not restore against the previous shorter table during out-in', async () => {
  const scope = effectScope()
  const key = ref('test:sqlite:transition:library')
  const transitionReady = ref(true)
  const count = ref(300_000)
  const scroll = scope.run(() =>
    useSongListVirtualScroll({
      displayTracks: computed(() => []),
      itemCount: computed(() => count.value),
      restoreReady: computed(() => transitionReady.value),
      viewKey: computed(() => key.value),
      viewIdentity: computed(() => key.value),
      resetSources: [],
      shouldResetOnSearch: computed(() => false),
      debouncedSearchQuery: ref('')
    })
  )!
  let top = 0,
    domMax = 20_400_000
  const container = {
    clientHeight: 700,
    get scrollTop() {
      return top
    },
    set scrollTop(value) {
      top = Math.min(domMax, value)
    }
  } as HTMLElement
  scroll.containerRef.value = container
  scroll.restoreScrollAndMeasure()
  await nextTick()
  container.scrollTop = 15_000_000
  scroll.onScroll({ target: container } as unknown as Event)
  transitionReady.value = false
  key.value = 'test:sqlite:transition:detail'
  count.value = 121
  await nextTick()
  domMax = 8_000
  transitionReady.value = true
  await nextTick()
  await nextTick()
  transitionReady.value = false
  key.value = 'test:sqlite:transition:library'
  count.value = 300_000 // RPC finished, but the old detail DOM is still leaving.
  await nextTick()
  scroll.restoreScrollAndMeasure()
  await nextTick()
  assert.equal(scroll.scrollTop.value, 15_000_000)
  assert.equal(container.scrollTop, 0, 'must not restore into the old 121-row DOM')
  domMax = 20_400_000
  transitionReady.value = true
  await nextTick()
  await nextTick()
  assert.equal(container.scrollTop, 15_000_000)
  scope.stop()
})
