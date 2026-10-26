import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, effectScope, nextTick, ref } from 'vue'
import { useSongListVirtualScroll } from './useSongListVirtualScroll.ts'

test('new artist queries and sections start at the content controls; saved views and new artists retain their contract', async () => {
  const scope = effectScope()
  const identity = ref('artist:scroll-reset-test')
  const section = ref('overview')
  const search = ref('')
  const scroll = scope.run(() =>
    useSongListVirtualScroll({
      displayTracks: computed(() => []),
      resetSources: [],
      shouldResetOnSearch: computed(() => true),
      debouncedSearchQuery: search,
      viewIdentity: computed(() => identity.value),
      viewKey: computed(() => JSON.stringify([identity.value, section.value, search.value])),
      resetScrollTop: () => Math.min(container.scrollTop, 620)
    })
  )!
  const container = { clientHeight: 700, scrollTop: 0 } as HTMLElement
  scroll.containerRef.value = container
  scroll.restoreScrollAndMeasure()
  await nextTick()
  container.scrollTop = 620
  scroll.onScroll({ target: container } as unknown as Event)
  section.value = 'songs'
  await nextTick()
  await nextTick()
  assert.equal(container.scrollTop, 620, 'switching tabs must not hide them behind the hero')
  container.scrollTop = 1900
  scroll.onScroll({ target: container } as unknown as Event)
  search.value = 'duet'
  await nextTick()
  await nextTick()
  assert.equal(container.scrollTop, 620, 'a new search starts at controls, not the hero or old row')
  search.value = ''
  await nextTick()
  await nextTick()
  assert.equal(container.scrollTop, 1900, 'clearing a query restores its saved unfiltered position')
  identity.value = 'artist:another-scroll-reset-test'
  await nextTick()
  scroll.restoreScrollAndMeasure()
  await nextTick()
  assert.equal(container.scrollTop, 0, 'a different artist still opens at its header')
  scope.stop()
})

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
  assert.ok(range.start <= 7 && range.end > 7, 'the row at the viewport top must stay mounted')
  assert.equal(range.start, 1)
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
  assert.equal(scroll.totalHeight.value, 20_400_000)
  scroll.scrollToTrack(234_567)
  assert.ok(container.scrollTop > 15_000_000)
  assert.ok(scroll.visibleRange.value.start <= 234_567)
  assert.ok(scroll.visibleRange.value.end > 234_567)
  assert.ok(scroll.visibleRange.value.end - scroll.visibleRange.value.start <= 23)
  assert.equal(scroll.paddingTop.value, scroll.visibleRange.value.start * 68)
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
