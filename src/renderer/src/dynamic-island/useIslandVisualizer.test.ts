import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer, defineComponent, nextTick, ref, shallowRef } from 'vue'
import type { CorePlayerClient } from '../stores/player/corePlayerTypes.ts'
import { useIslandVisualizer } from './useIslandVisualizer.ts'

type Host = { parent: Host | null; children: Host[] }
const node = (): Host => ({ parent: null, children: [] })
const renderer = createRenderer<Host, Host>({
  createElement: node,
  createText: node,
  createComment: node,
  insert(child, parent) {
    child.parent = parent
    parent.children.push(child)
  },
  remove() {},
  parentNode: (child) => child.parent,
  nextSibling: () => null,
  patchProp() {},
  setText() {},
  setElementText() {}
})
const turn = async () => {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}
function fixture(t: test.TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const listeners = new Set<() => void>()
  const document = {
    visibilityState: 'visible',
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener)
  }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
  const enabled = ref(true)
  const state = shallowRef({ epoch: 'first' })
  const status = shallowRef({ phase: 'ready' })
  const calls: { name: string; payload: { subscriptionId: string } }[] = []
  let consume: (event: unknown) => void = () => {}
  let pending: Promise<void> = Promise.resolve()
  let attaches = 0,
    detached = 0
  const core = {
    state,
    status,
    attach: async () => {
      attaches++
    },
    subscribe: (listener: typeof consume) => {
      consume = listener
      return () => {
        detached++
      }
    },
    command: async (name: string, payload: { subscriptionId: string }) => {
      calls.push({ name, payload })
      if (name === 'visualization.subscribe') await pending
    }
  } as unknown as CorePlayerClient
  let visualizer!: ReturnType<typeof useIslandVisualizer>
  const app = renderer.createApp(
    defineComponent({
      setup() {
        visualizer = useIslandVisualizer(enabled, core)
        return () => null
      }
    })
  )
  let mounted = false
  t.after(() => {
    if (mounted) app.unmount()
    if (original) Object.defineProperty(globalThis, 'document', original)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  return {
    enabled,
    calls,
    state,
    status,
    listeners,
    mount() {
      app.mount(node())
      mounted = true
    },
    unmount() {
      app.unmount()
      mounted = false
    },
    hold() {
      let release!: () => void
      pending = new Promise((resolve) => {
        release = resolve
      })
      return release
    },
    visibility(value: string) {
      document.visibilityState = value
      for (const listener of listeners) listener()
    },
    send(sequence: number, values: number[], extra: Record<string, unknown> = {}) {
      consume({
        kind: 'visualization',
        epoch: 'first',
        sequence,
        subscriptionId: calls.find((c) => c.name === 'visualization.subscribe')!.payload
          .subscriptionId,
        data: { active: true, tapStatus: 'active', visualizerBars: values },
        ...extra
      })
    },
    view: () => visualizer,
    attaches: () => attaches,
    detached: () => detached
  }
}

test('island consumes only ordered frames for its current Core subscription and releases hidden taps', async (t) => {
  const f = fixture(t)
  f.mount()
  await turn()
  assert.equal(f.attaches(), 1)
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ['visualization.subscribe']
  )
  f.send(2, [1, 1, 1, 1, 1, 1])
  assert.equal(f.view().energy.value, 1)
  f.send(1, [])
  f.send(3, [], { epoch: 'obsolete' })
  f.send(3, [], { subscriptionId: 'another' })
  assert.equal(f.view().energy.value, 1)
  f.send(3, [1], { data: { active: true, tapStatus: 'synthetic', visualizerBars: [1] } })
  assert.equal(f.view().energy.value, 0)
  f.visibility('hidden')
  await turn()
  assert.equal(f.calls.at(-1)?.name, 'visualization.unsubscribe')
  f.visibility('visible')
  await turn()
  f.enabled.value = false
  await turn()
  assert.deepEqual(
    f.calls.map((c) => c.name),
    [
      'visualization.subscribe',
      'visualization.unsubscribe',
      'visualization.subscribe',
      'visualization.unsubscribe'
    ]
  )
  f.unmount()
  assert.equal(f.listeners.size, 0)
  assert.equal(f.detached(), 1)
})

test('unmount waits for the subscribe ACK before removing the same subscription', async (t) => {
  const f = fixture(t)
  const release = f.hold()
  f.mount()
  await turn()
  f.unmount()
  await turn()
  assert.equal(f.calls.length, 1)
  release()
  await turn()
  assert.equal(f.calls[1].name, 'visualization.unsubscribe')
  assert.equal(f.calls[1].payload.subscriptionId, f.calls[0].payload.subscriptionId)
})

test('a new epoch reconnects a new visualization tap without replaying old commands', async (t) => {
  const f = fixture(t)
  f.mount()
  await turn()
  const old = f.calls[0].payload.subscriptionId
  f.status.value = { phase: 'starting' }
  f.state.value = { epoch: 'second' }
  await turn()
  f.status.value = { phase: 'ready' }
  await turn()
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ['visualization.subscribe', 'visualization.subscribe']
  )
  assert.notEqual(f.calls[1].payload.subscriptionId, old)
  f.send(9, [1, 1, 1])
  assert.equal(f.view().energy.value, 0)
})
