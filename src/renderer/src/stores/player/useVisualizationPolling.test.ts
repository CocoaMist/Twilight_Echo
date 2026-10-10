import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import {
  createInactiveVisualizationData,
  createVisualizationPolling,
  visualizationOptions,
  type NativeVisualizationData
} from './useVisualizationPolling.ts'

function makeHarness() {
  const data = ref<NativeVisualizationData>(createInactiveVisualizationData())
  const active = ref(false)
  const consumers = ref(0)
  const visible = ref(true)
  const enabled = ref(true)
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  let fetches = 0
  const polling = createVisualizationPolling({
    data,
    active,
    consumers,
    visible,
    enabled: () => enabled.value,
    setInterval: (callback) => {
      const handle = nextTimer++
      timers.set(handle, callback)
      return handle
    },
    clearInterval: (handle) => {
      timers.delete(handle)
    },
    fetch: async () => {
      fetches += 1
      return { ...createInactiveVisualizationData(), active: true, peakDb: -3 }
    }
  })
  return {
    data,
    active,
    consumers,
    visible,
    enabled,
    timers,
    polling,
    fetchCount: () => fetches,
    async tick() {
      for (const callback of [...timers.values()]) callback()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
}

test('the store poll requests no oscilloscope or spectrogram payload', () => {
  assert.equal(visualizationOptions.oscilloscopePoints, 0)
  assert.equal(visualizationOptions.spectrogramFrames, 0)
  assert.deepEqual(createInactiveVisualizationData().oscilloscope, [])
  assert.deepEqual(createInactiveVisualizationData().spectrogram, [])
})

test('hidden and paused windows make no requests and stop an already running timer', async () => {
  const h = makeHarness()
  h.polling.acquireConsumer()
  h.visible.value = false
  h.polling.start()
  assert.equal(h.fetchCount(), 0)
  h.visible.value = true
  h.polling.start()
  await h.tick()
  const before = h.fetchCount()
  h.visible.value = false
  await h.tick()
  assert.equal(h.fetchCount(), before)
  assert.equal(h.timers.size, 0)
  h.visible.value = true
  h.enabled.value = false
  h.polling.start()
  assert.equal(h.fetchCount(), before)
  h.enabled.value = true
  h.polling.start()
  await h.tick()
  assert.ok(h.fetchCount() > before)
})

test('consumer demands share one request and released or hidden generations ignore late responses', async () => {
  const data = ref(createInactiveVisualizationData())
  const consumers = ref(0)
  const visible = ref(true)
  const requests: { spectrumPoints?: number }[] = []
  let resolve!: (data: NativeVisualizationData) => void
  const polling = createVisualizationPolling({
    data,
    consumers,
    visible,
    active: ref(false),
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: (options) => {
      requests.push(options)
      return new Promise((done) => {
        resolve = done
      })
    }
  })
  const bar = polling.acquireConsumer()
  const eq = polling.acquireConsumer({ spectrumPoints: 2048 })
  polling.start()
  await polling.refresh()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].spectrumPoints, 2048)
  visible.value = false
  polling.stop()
  resolve({ ...createInactiveVisualizationData(), active: true, peakDb: -3 })
  await new Promise((done) => setImmediate(done))
  assert.equal(data.value.active, false)
  eq()
  visible.value = true
  polling.start()
  assert.equal(requests[1].spectrumPoints, 64)
  bar()
  resolve({ ...createInactiveVisualizationData(), active: true })
  await new Promise((done) => setImmediate(done))
  assert.equal(data.value.active, false)
  assert.equal(polling.isPolling(), false)
})

test('visualization polling does not start while nothing renders the data', async () => {
  const harness = makeHarness()
  harness.polling.start()
  assert.equal(harness.polling.isPolling(), false)
  assert.equal(harness.timers.size, 0)
  assert.equal(harness.fetchCount(), 0)
})

test('a mounted consumer starts the poll and releasing the last one stops it', async () => {
  const harness = makeHarness()
  const release = harness.polling.acquireConsumer()
  assert.equal(harness.consumers.value, 1)
  harness.polling.start()
  assert.equal(harness.polling.isPolling(), true)
  await harness.tick()
  await harness.tick()
  assert.equal(harness.fetchCount() >= 2, true)
  assert.equal(harness.data.value.active, true)

  release()
  release()
  assert.equal(harness.consumers.value, 0)
  harness.polling.stop(true)
  assert.equal(harness.polling.isPolling(), false)
  assert.equal(harness.data.value.active, false)
  harness.polling.start()
  assert.equal(harness.polling.isPolling(), false)
})

test('the full visualizer panel keeps the store poll off while it owns the tap', () => {
  const harness = makeHarness()
  const release = harness.polling.acquireConsumer()
  harness.active.value = true
  harness.polling.start()
  assert.equal(harness.polling.isPolling(), false)
  release()
})
