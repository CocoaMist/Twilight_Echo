import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, effectScope, nextTick, ref, shallowRef } from 'vue'
import { useSongListGridRendering } from './useSongListGridRendering.ts'
import type { GridItem } from './types.ts'

test('300k summary cards keep absolute holes, full height and leading creation offset with bounded mounted slots', async (t) => {
  const oldWindow = globalThis.window
  const style = {
    gridTemplateColumns: '200px 200px 200px 200px',
    rowGap: '20px',
    getPropertyValue: () => '14px'
  }
  globalThis.window = {
    innerWidth: 1200,
    getComputedStyle: () => style,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {}
  } as unknown as Window & typeof globalThis
  const scope = effectScope()
  t.after(async () => {
    scope.stop()
    await nextTick()
    globalThis.window = oldWindow
  })
  let card: unknown = { getBoundingClientRect: () => ({ height: 240 }) }
  const grid = {
    clientWidth: 800,
    getBoundingClientRect: () => ({ top: -600 }),
    querySelector: () => card
  }
  const container = {
    clientWidth: 800,
    clientHeight: 720,
    clientTop: 2,
    scrollTop: 1000,
    getBoundingClientRect: () => ({ top: 80 }),
    querySelector: () => grid
  } as unknown as HTMLElement
  const loaded = shallowRef(
    new Map<number, GridItem>([
      [199, { id: '199', name: '199' }],
      [200, { id: '200', name: '200' }]
    ])
  )
  const scrollTop = ref(0),
    serverFiltered = ref(true)
  const helper = scope.run(() =>
    useSongListGridRendering<GridItem>({
      category: () => 'playlists',
      filter: () => null,
      transitionName: () => 'page-down',
      debouncedSearchQuery: ref(''),
      currentGridItems: computed(() => []),
      serverFiltered: computed(() => serverFiltered.value),
      itemCount: computed(() => 300000),
      itemAt: (index) => loaded.value.get(index),
      showGrid: computed(() => true),
      updateViewportHeight() {},
      containerRef: ref(container),
      scrollTop,
      viewportHeight: ref(720)
    })
  )!
  helper.measureGridMetrics()
  assert.equal(
    helper.gridOffsetTop.value,
    318,
    'coordinates must be scroller-relative, not offset-parent-relative'
  )
  assert.equal(helper.gridRowStride.value, 260)
  assert.equal(helper.gridColumns.value, 4)
  assert.equal(helper.showPlaylistCreateCard.value, true)
  assert.equal(helper.visibleGridSlots.value[0].index, 0)
  scrollTop.value = 13_500
  const slots = helper.visibleGridSlots.value
  assert.ok(slots.length < 80)
  assert.equal(helper.showPlaylistCreateCard.value, false)
  assert.equal(slots.find((slot) => slot.index === 199)?.item?.id, '199')
  assert.equal(slots.find((slot) => slot.index === 200)?.item?.id, '200')
  assert.equal(slots.find((slot) => slot.index === 201)?.item, undefined)
  assert.equal(helper.gridTotalCount.value, 300000)
  const height =
    helper.gridPaddingTop.value +
    helper.gridPaddingBottom.value +
    Math.ceil(slots.length / 4) * 260 -
    20 +
    40
  assert.equal(height, Math.ceil(300001 / 4) * 260 - 20, 'spacer rows must not add extra gaps')
  loaded.value = new Map()
  card = null
  helper.measureGridMetrics()
  assert.equal(
    helper.gridRowStride.value,
    260,
    'a failed/unloaded window must keep measured row geometry'
  )
  assert.ok(helper.visibleGridSlots.value.every((slot) => slot.item === undefined))
  helper.renderGridThroughIndex(250000)
  assert.ok(helper.gridDataRange.value.start <= 250000 && helper.gridDataRange.value.end > 250000)
  assert.equal(container.scrollTop, scrollTop.value)
  assert.ok(helper.gridPaddingBottom.value > 0)
  await nextTick()
})

test('legacy arrays still filter locally and never invoke the SQL lookup/count contract', async (t) => {
  const oldWindow = globalThis.window
  globalThis.window = {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {}
  } as unknown as Window & typeof globalThis
  const scope = effectScope()
  t.after(async () => {
    scope.stop()
    await nextTick()
    globalThis.window = oldWindow
  })
  const helper = scope.run(() =>
    useSongListGridRendering({
      category: () => 'albums',
      filter: () => null,
      transitionName: () => 'page-down',
      debouncedSearchQuery: ref('Moon'),
      currentGridItems: computed(() => [
        { id: 'one', name: 'Moon' },
        { id: 'two', name: 'Sun' }
      ]),
      serverFiltered: computed(() => false),
      itemCount: computed(() => 300000),
      itemAt() {
        throw new Error('SQL lookup in JSON mode')
      },
      showGrid: computed(() => true),
      updateViewportHeight() {},
      containerRef: ref(null),
      scrollTop: ref(0),
      viewportHeight: ref(720)
    })
  )!
  assert.equal(helper.gridTotalCount.value, 1)
  assert.deepEqual(
    helper.visibleGridSlots.value.map((slot) => slot.item?.id),
    ['one']
  )
  await nextTick()
})
