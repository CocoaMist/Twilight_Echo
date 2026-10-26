import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTick } from 'vue'
import type { CoreBridgeApi, CoreBridgeMessage } from '../../../shared/coreBridge.ts'
import type { CoreSnapshot, CoreRequestEnvelope } from '../../../shared/coreProtocol.ts'
import { useCoreConnection, disposeCoreConnection } from '../stores/coreConnection.ts'
import { corePlugins, executeCoreExtension } from './corePlugins.ts'

test('plugin UI adapters use finite Core operations and plugin revision events', async () => {
  const requests: CoreRequestEnvelope[] = []
  const listeners = new Set<(message: CoreBridgeMessage) => void>()
  let state = {
    protocolVersion: 1,
    epoch: 'plugins',
    sequence: 0,
    phase: 'ready',
    pluginsRevision: 1
  } as CoreSnapshot
  const api: CoreBridgeApi = {
    connect: async () => ({ ok: true, value: { connectionId: 'desktop', snapshot: state } }),
    request: async (_id, request) => {
      requests.push(request)
      return { ok: true, value: [] }
    },
    cancel: async () => ({ ok: true, value: undefined }),
    disconnect: async () => ({ ok: true, value: undefined }),
    onMessage: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onStatus: () => () => {}
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: { core: api } } })
  try {
    await useCoreConnection().attach()
    let changes = 0
    const stop = corePlugins.onChanged(() => changes++)
    await corePlugins.list()
    await corePlugins.listIndex()
    await corePlugins.refreshIndex()
    await corePlugins.getIndexStatus()
    await corePlugins.chooseAndInstall('directory')
    await corePlugins.installFromIndex('com.example.theme')
    await corePlugins.disable('com.example.theme')
    await executeCoreExtension('com.example.theme.settings', [{ theme: 'dark' }])
    assert.deepEqual(
      requests.map((request) => request.name),
      [
        'plugins.list',
        'plugins.index.list',
        'plugins.index.refresh',
        'plugins.index.status',
        'plugins.install',
        'plugins.index.install',
        'plugins.disable',
        'extensions.execute'
      ]
    )
    assert.deepEqual(requests[4].payload, { kind: 'directory' })
    state = { ...state, sequence: 1, pluginsRevision: 2 }
    for (const listener of listeners)
      listener({
        connectionId: 'desktop',
        message: { kind: 'state', epoch: state.epoch, sequence: state.sequence, snapshot: state }
      })
    await nextTick()
    assert.equal(changes, 1)
    stop()
  } finally {
    disposeCoreConnection()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
