import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, ref } from 'vue'
import { useSmoothedValue } from './useSmoothedValue.ts'

interface FrameClock {
  now: number
  tick: (ms: number) => void
  pendingFrames: () => number
}

// Deterministic rAF/performance harness: each tick advances the clock and runs
// the single pending frame callback, mirroring one display refresh.
function installFrameClock(): FrameClock {
  let now = 0
  let nextHandle = 1
  const callbacks = new Map<number, FrameRequestCallback>()
  const g = globalThis as Record<string, unknown>
  g.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const handle = nextHandle++
    callbacks.set(handle, cb)
    return handle
  }
  g.cancelAnimationFrame = (handle: number): void => {
    callbacks.delete(handle)
  }
  g.performance = { now: () => now }
  return {
    get now() {
      return now
    },
    set now(value: number) {
      now = value
    },
    tick(ms: number) {
      now += ms
      const pending = [...callbacks.entries()]
      callbacks.clear()
      for (const [, cb] of pending) cb(now)
    },
    pendingFrames: () => callbacks.size
  }
}

function withScope<T>(fn: () => T): { value: T; dispose: () => void } {
  const scope = effectScope()
  const value = scope.run(fn) as T
  return { value, dispose: () => scope.stop() }
}

test('starts at the target value without animating', () => {
  installFrameClock()
  const { value: smoothed, dispose } = withScope(() => useSmoothedValue(ref(42)))
  assert.equal(smoothed.value, 42)
  dispose()
})

test('chases a moved target and converges', async () => {
  const clock = installFrameClock()
  const target = ref(0)
  const { value: smoothed, dispose } = withScope(() =>
    useSmoothedValue(target, { tau: 100, epsilon: 0.001 })
  )
  target.value = 10
  await Promise.resolve()
  // First frame after tau ms should close ~63% of the gap.
  clock.tick(16)
  clock.tick(100)
  assert.ok(smoothed.value > 5, `expected >5, got ${smoothed.value}`)
  assert.ok(smoothed.value < 10, `expected <10, got ${smoothed.value}`)
  for (let i = 0; i < 200 && clock.pendingFrames() > 0; i++) clock.tick(50)
  assert.equal(smoothed.value, 10)
  assert.equal(clock.pendingFrames(), 0)
  dispose()
})

test('jumps beyond snapThreshold snap immediately', async () => {
  const clock = installFrameClock()
  const target = ref(0)
  const { value: smoothed, dispose } = withScope(() =>
    useSmoothedValue(target, { tau: 100, snapThreshold: 5 })
  )
  target.value = 50
  await Promise.resolve()
  assert.equal(smoothed.value, 50)
  assert.equal(clock.pendingFrames(), 0)
  dispose()
})

test('small updates keep gliding while repeated ticks arrive', async () => {
  const clock = installFrameClock()
  const target = ref(0)
  const { value: smoothed, dispose } = withScope(() =>
    useSmoothedValue(target, { tau: 100, snapThreshold: 5 })
  )
  for (let i = 1; i <= 4; i++) {
    target.value = i
    await Promise.resolve()
    clock.tick(50)
  }
  assert.ok(smoothed.value > 0)
  assert.ok(smoothed.value < 4)
  dispose()
})

test('scope disposal cancels the pending frame', async () => {
  const clock = installFrameClock()
  const target = ref(0)
  const { dispose } = withScope(() => useSmoothedValue(target, { tau: 100 }))
  target.value = 3
  await Promise.resolve()
  assert.ok(clock.pendingFrames() > 0)
  dispose()
  assert.equal(clock.pendingFrames(), 0)
})
