import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer, h, nextTick, ref } from 'vue'
import { useVisibleSettingsPolling } from './useVisibleSettingsPolling.ts'

const tick = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await nextTick()
}

function fixture(
  request: Parameters<typeof useVisibleSettingsPolling>[2],
  initiallyActive = true,
  initiallyHidden = false
) {
  const active = ref(initiallyActive)
  const timers = new Map<number, { at: number; callback: () => void }>()
  let now = 0
  let timerId = 0
  const events = new EventTarget()
  const document = Object.assign(events, {
    visibilityState: initiallyHidden ? 'hidden' : 'visible'
  })
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const oldSetTimeout = globalThis.setTimeout
  const oldClearTimeout = globalThis.clearTimeout
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true })
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    timers.set(++timerId, { at: now + delay, callback })
    return timerId
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => timers.delete(id)) as unknown as typeof clearTimeout
  const renderer = createRenderer<object, object>({
    patchProp() {},
    insert() {},
    remove() {},
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    setText() {},
    setElementText() {},
    parentNode: () => null,
    nextSibling: () => null
  })
  let refresh!: () => Promise<void>
  const app = renderer.createApp({
    setup() {
      refresh = useVisibleSettingsPolling(() => active.value, 5_000, request)
      return () => h('div')
    }
  })
  app.mount({})
  let unmounted = false
  return {
    active,
    timers,
    refresh,
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > end) break
        now = next[1].at
        timers.delete(next[0])
        next[1].callback()
        await tick()
      }
      now = end
    },
    visibility(hidden: boolean) {
      document.visibilityState = hidden ? 'hidden' : 'visible'
      events.dispatchEvent(new Event('visibilitychange'))
    },
    unmount() {
      if (!unmounted) app.unmount()
      unmounted = true
    },
    dispose() {
      if (!unmounted) app.unmount()
      globalThis.setTimeout = oldSetTimeout
      globalThis.clearTimeout = oldClearTimeout
      if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument)
      else Reflect.deleteProperty(globalThis, 'document')
    }
  }
}

test('mounted hidden category makes no calls for 60 seconds and refreshes immediately on entry', async () => {
  let calls = 0
  const f = fixture(async () => {
    ++calls
  }, false)
  try {
    await f.advance(60_000)
    assert.equal(calls, 0)
    assert.equal(f.timers.size, 0)
    f.active.value = true
    await tick()
    assert.equal(calls, 1)
    await f.advance(60_000)
    assert.equal(calls, 13)
    f.active.value = false
    await f.advance(60_000)
    assert.equal(calls, 13)
    assert.equal(f.timers.size, 0)
  } finally {
    f.dispose()
  }
})

test('document hidden pauses work and return refreshes; unmount removes the listener', async () => {
  let calls = 0
  const f = fixture(
    async () => {
      ++calls
    },
    true,
    true
  )
  try {
    await f.advance(60_000)
    assert.equal(calls, 0)
    f.visibility(false)
    await tick()
    assert.equal(calls, 1)
    f.visibility(true)
    await f.advance(60_000)
    assert.equal(calls, 1)
    assert.equal(f.timers.size, 0)
    f.visibility(false)
    await tick()
    assert.equal(calls, 2)
    f.unmount()
    f.visibility(false)
    await f.advance(60_000)
    assert.equal(calls, 2)
    assert.equal(f.timers.size, 0)
  } finally {
    f.dispose()
  }
})

test('slow queries do not overlap, and a reply from a previous visit cannot restart the loop', async () => {
  const pending: Array<() => void> = []
  const applied: string[] = []
  let calls = 0
  const f = fixture(async (isCurrent) => {
    const label = String(++calls)
    await new Promise<void>((resolve) => pending.push(resolve))
    if (isCurrent()) applied.push(label)
  })
  try {
    await f.advance(60_000)
    assert.equal(calls, 1)
    assert.equal(f.timers.size, 0)
    f.active.value = false
    f.active.value = true
    assert.equal(calls, 2)
    pending[0]()
    await tick()
    assert.deepEqual(applied, [])
    assert.equal(f.timers.size, 0)
    pending[1]()
    await tick()
    assert.deepEqual(applied, ['2'])
    assert.equal(f.timers.size, 1)
    await f.advance(5_000)
    assert.equal(calls, 3)
    f.unmount()
    pending[2]()
    await tick()
    assert.deepEqual(applied, ['2'])
    assert.equal(f.timers.size, 0)
  } finally {
    f.dispose()
  }
})
