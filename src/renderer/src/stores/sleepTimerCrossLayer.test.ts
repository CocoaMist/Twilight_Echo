import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreSleepTimer } from '../../../core/playback/sleepService.ts'
import { CoreProjection, type CoreConnection } from './coreProjection.ts'
import { coreSnapshot } from './coreTestFixtures.ts'
import type { CoreClientMessage } from '../../../shared/coreProtocol.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('one Core boundary stops once with every renderer detached; reconnect projects the terminal state without another stop', async () => {
  let snapshot = coreSnapshot(),
    stops = 0
  const listeners = new Set<(message: CoreClientMessage) => void>()
  const publish = () => {
    snapshot = { ...snapshot, sequence: snapshot.sequence + 1, sleepTimer: timer.state() }
    for (const listener of listeners)
      listener({ kind: 'state', epoch: snapshot.epoch, sequence: snapshot.sequence, snapshot })
  }
  const timer = new CoreSleepTimer({
    settings: () => ({ defaultMinutes: 30, fadeSeconds: 0 }),
    now: () => 1_000,
    timers: { setTimeout, clearTimeout, setInterval, clearInterval },
    playback: {
      read: () => ({ state: 'playing', volume: 0.75 }),
      quiesce: async () => {},
      setGain: async () => {},
      stop: async (current) => {
        if (current()) stops++
      },
      resumeMaintenance() {},
      persist: async () => {}
    },
    changed: publish,
    failed: (error) => {
      throw error
    }
  })
  const connection: CoreConnection = {
    connect: async () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    request: async () => {
      throw new Error('renderer must not issue playback work during attachment')
    }
  }
  timer.activate()
  await timer.configure({ revision: 0, mode: 'queueEnd' }, new AbortController().signal)
  const first = new CoreProjection(connection, () => {})
  await first.attach()
  first.dispose()
  assert.equal(listeners.size, 0)
  timer.boundary('queueEnd', 1_000)
  await tick()
  assert.equal(stops, 1)
  const second = new CoreProjection(connection, () => {})
  await second.attach()
  assert.equal(second.snapshot()?.sleepTimer?.timer?.triggered, true)
  publish()
  await tick()
  assert.equal(stops, 1)
  second.dispose()
  await timer.shutdown()
})
