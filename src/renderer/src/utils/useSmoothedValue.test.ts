import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, ref } from 'vue'
import { useSmoothedValue } from './useSmoothedValue.ts'

interface FrameClock {
  now: number
  tick: (ms: number) => void
  pendingFrames: () => number
  scheduledFrames: () => number
}

const originalGlobals = new Map<string, PropertyDescriptor | undefined>()
const scopes: ReturnType<typeof effectScope>[] = []

function mockGlobal(name: string, value: unknown): void {
  if (!originalGlobals.has(name)) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  }
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  originalGlobals.clear()
})

function installPolicyEnvironment(systemReduced = false) {
  function eventSource() {
    const listeners = new Set<() => void>()
    return {
      addEventListener(_event: string, callback: () => void) {
        listeners.add(callback)
      },
      removeEventListener(_event: string, callback: () => void) {
        listeners.delete(callback)
      },
      emit() {
        for (const callback of listeners) callback()
      },
      listenerCount: () => listeners.size
    }
  }
  const ownerDocument = {
    ...eventSource(),
    hidden: false,
    documentElement: { dataset: { teMotion: '' } }
  }
  const mediaQuery = { ...eventSource(), matches: systemReduced }
  let notifyMutation: (() => void) | null = null
  let disconnected = false
  mockGlobal('document', ownerDocument)
  mockGlobal('window', { matchMedia: () => mediaQuery })
  mockGlobal(
    'MutationObserver',
    class {
      constructor(callback: () => void) {
        notifyMutation = callback
      }
      observe(_element: unknown, options: MutationObserverInit) {
        assert.deepEqual(options.attributeFilter, ['data-te-motion'])
      }
      disconnect() {
        disconnected = true
        notifyMutation = null
      }
    }
  )
  return {
    ownerDocument,
    mediaQuery,
    setMode(mode: string) {
      ownerDocument.documentElement.dataset.teMotion = mode
      notifyMutation?.()
    },
    setHidden(hidden: boolean) {
      ownerDocument.hidden = hidden
      ownerDocument.emit()
    },
    setSystemReduced(reduced: boolean) {
      mediaQuery.matches = reduced
      mediaQuery.emit()
    },
    isDisconnected: () => disconnected
  }
}

// Deterministic rAF/performance harness: each tick advances the clock and runs
// the single pending frame callback, mirroring one display refresh.
function installFrameClock(): FrameClock {
  let now = 0
  let nextHandle = 1
  const callbacks = new Map<number, FrameRequestCallback>()
  mockGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    const handle = nextHandle++
    callbacks.set(handle, cb)
    return handle
  })
  mockGlobal('cancelAnimationFrame', (handle: number): void => {
    callbacks.delete(handle)
  })
  mockGlobal('performance', { now: () => now })
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
    pendingFrames: () => callbacks.size,
    scheduledFrames: () => nextHandle - 1
  }
}

function withScope<T>(fn: () => T): { value: T; dispose: () => void } {
  const scope = effectScope()
  scopes.push(scope)
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

test('live app motion modes stop animation and full overrides the system preference', () => {
  const clock = installFrameClock()
  const policy = installPolicyEnvironment(true)
  policy.setMode('full')
  const target = ref(0)
  const { value: smoothed } = withScope(() => useSmoothedValue(target))
  target.value = 1
  clock.tick(16)
  assert.ok(smoothed.value > 0 && smoothed.value < 1)
  policy.setMode('reduced')
  assert.equal(smoothed.value, 1)
  assert.equal(clock.pendingFrames(), 0)
  target.value = 2
  assert.equal(smoothed.value, 2)
  policy.setMode('off')
  target.value = 3
  assert.equal(smoothed.value, 3)
  assert.equal(clock.pendingFrames(), 0)
  policy.setMode('full')
  target.value = 4
  assert.equal(clock.pendingFrames(), 1)
})

test('system motion changes take effect without a document motion override', () => {
  const clock = installFrameClock()
  const policy = installPolicyEnvironment()
  const target = ref(0)
  const { value: smoothed } = withScope(() => useSmoothedValue(target))
  target.value = 1
  assert.equal(clock.pendingFrames(), 1)
  policy.setSystemReduced(true)
  assert.equal(smoothed.value, 1)
  assert.equal(clock.pendingFrames(), 0)
  policy.setSystemReduced(false)
  target.value = 2
  assert.equal(clock.pendingFrames(), 1)
})

test('hiding cancels frames, follows hidden targets, and resumes without regressing', () => {
  const clock = installFrameClock()
  const policy = installPolicyEnvironment()
  const target = ref(0)
  const { value: smoothed } = withScope(() => useSmoothedValue(target))
  target.value = 1
  clock.tick(16)
  policy.setHidden(true)
  assert.equal(smoothed.value, 1)
  assert.equal(clock.pendingFrames(), 0)
  const scheduled = clock.scheduledFrames()
  for (let value = 2; value <= 100; value++) target.value = value
  assert.equal(smoothed.value, 100)
  assert.equal(clock.scheduledFrames(), scheduled)
  policy.setHidden(false)
  assert.equal(smoothed.value, 100)
  assert.equal(clock.pendingFrames(), 0)
  target.value = 101
  clock.tick(16)
  assert.ok(smoothed.value > 100 && smoothed.value < 101)
})

test('a queued frame respects visibility even before visibilitychange is dispatched', () => {
  const clock = installFrameClock()
  const policy = installPolicyEnvironment()
  const target = ref(0)
  const { value: smoothed } = withScope(() => useSmoothedValue(target))
  target.value = 1
  policy.ownerDocument.hidden = true
  clock.tick(16)
  assert.equal(smoothed.value, 1)
  assert.equal(clock.pendingFrames(), 0)
})

test('scope disposal removes policy listeners and observers', () => {
  const clock = installFrameClock()
  const policy = installPolicyEnvironment()
  const target = ref(0)
  const { value: smoothed, dispose } = withScope(() => useSmoothedValue(target))
  target.value = 1
  assert.equal(policy.ownerDocument.listenerCount(), 1)
  assert.equal(policy.mediaQuery.listenerCount(), 1)
  dispose()
  assert.equal(clock.pendingFrames(), 0)
  assert.equal(policy.ownerDocument.listenerCount(), 0)
  assert.equal(policy.mediaQuery.listenerCount(), 0)
  assert.equal(policy.isDisconnected(), true)
  target.value = 2
  policy.setHidden(true)
  policy.setMode('off')
  policy.setSystemReduced(true)
  assert.equal(smoothed.value, 0)
  assert.equal(clock.pendingFrames(), 0)
})

test('subpixel progress tolerance ends a 1 percent transition in 45 frames instead of 73', () => {
  const clock = installFrameClock()
  const target = ref(0)
  const legacy = withScope(() => useSmoothedValue(target, { tau: 160 })).value
  const progress = withScope(() => useSmoothedValue(target, { tau: 160, epsilon: 0.01 })).value
  target.value = 1
  let progressFrames = 0
  let legacyFrames = 0
  while (clock.pendingFrames() > 0 && legacyFrames < 100) {
    clock.tick(1000 / 60)
    legacyFrames++
    if (progress.value !== 1) progressFrames++
  }
  progressFrames++
  assert.equal(progress.value, 1)
  assert.equal(legacy.value, 1)
  assert.equal(progressFrames, 45)
  assert.equal(legacyFrames, 73)
  assert.equal(clock.pendingFrames(), 0)
})

test('changes already within tolerance do not schedule frames', () => {
  const clock = installFrameClock()
  const target = ref(0)
  const { value: smoothed } = withScope(() => useSmoothedValue(target, { epsilon: 0.01 }))
  target.value = 0.005
  assert.equal(smoothed.value, 0.005)
  assert.equal(clock.scheduledFrames(), 0)
})
