import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  NativeSleepTimerBoundaryCursor,
  registerNativeSleepTimerBoundaries
} from './sleepTimerNativeBoundary.ts'
import { SleepTimerService } from '../sleepTimerCore.ts'
import { createSleepTimerState } from '../../shared/sleepTimer.ts'

test('delegated native queue boundaries are forwarded to the main sleep timer', () => {
  const engine = new EventEmitter()
  const boundaries: string[] = []
  registerNativeSleepTimerBoundaries(engine, {
    boundary: (boundary) => {
      boundaries.push(boundary)
      return null
    }
  })

  engine.emit('sleep-timer-boundary', { boundary: 'trackEnd' })
  engine.emit('sleep-timer-boundary', { boundary: 'queueEnd' })
  assert.deepEqual(boundaries, ['trackEnd', 'queueEnd'])
})

test('native boundary snapshots retain skipped cycles, deduplicate reads and accept a replacement epoch', () => {
  const cursor = new NativeSleepTimerBoundaryCursor()
  const zero = { trackSerial: 0, queueSerial: 0, trackTimeMs: 0, queueTimeMs: 0 }
  assert.deepEqual(cursor.consume(zero), [])
  const snapshot = { trackSerial: 8, queueSerial: 2, trackTimeMs: 8000, queueTimeMs: 7000 }
  assert.deepEqual(cursor.consume(snapshot), [
    { boundary: 'trackEnd', occurredAt: 8000 },
    { boundary: 'queueEnd', occurredAt: 7000 }
  ])
  assert.deepEqual(cursor.consume(snapshot), [])
  snapshot.trackSerial = 9
  snapshot.trackTimeMs = 9000
  assert.deepEqual(cursor.consume(snapshot), [{ boundary: 'trackEnd', occurredAt: 9000 }])
  assert.deepEqual(cursor.consume(zero), [])
  assert.deepEqual(
    cursor.consume({ trackSerial: 1, queueSerial: 1, trackTimeMs: 10000, queueTimeMs: 10000 }),
    [
      { boundary: 'trackEnd', occurredAt: 10000 },
      { boundary: 'queueEnd', occurredAt: 10000 }
    ]
  )
})

test('only an absent native contract permits legacy inference; malformed data cannot move the cursor', () => {
  const cursor = new NativeSleepTimerBoundaryCursor()
  const zero = { trackSerial: 0, queueSerial: 0, trackTimeMs: 0, queueTimeMs: 0 }
  assert.equal(cursor.consume(undefined), null)
  for (const value of [
    null,
    [],
    {},
    false,
    { ...zero, trackSerial: -1 },
    { ...zero, trackSerial: 1 },
    { ...zero, trackTimeMs: 1000 },
    { trackSerial: 1, queueSerial: 2, trackTimeMs: 1000, queueTimeMs: 1000 },
    { trackSerial: 1, queueSerial: 1, trackTimeMs: 1000, queueTimeMs: 1001 },
    { ...zero, trackSerial: Number.MAX_SAFE_INTEGER + 1 }
  ])
    assert.deepEqual(cursor.consume(value), [])
  assert.deepEqual(
    cursor.consume({ trackSerial: 1, queueSerial: 0, trackTimeMs: 1000, queueTimeMs: 0 }),
    [{ boundary: 'trackEnd', occurredAt: 1000 }]
  )
})

test('bridge preserves native decision time so a delayed poll cannot fire a newly armed timer', () => {
  const engine = new EventEmitter()
  let now = 2000
  const timer = new SleepTimerService({ now: () => now })
  registerNativeSleepTimerBoundaries(engine, timer)
  timer.configure(createSleepTimerState('queueEnd', now, { defaultMinutes: 1, fadeSeconds: 0 }))
  engine.emit('sleep-timer-boundary', { boundary: 'queueEnd', occurredAt: 1999 })
  assert.equal(timer.snapshot()?.active, true)
  now = 3000
  engine.emit('sleep-timer-boundary', { boundary: 'queueEnd', occurredAt: 2500 })
  assert.equal(timer.snapshot()?.triggered, true)
})

test('the engine-IPC native-boundary registration drives the real main timer once', async () => {
  const { AudioEngineManager } = await import('../audioEngineManager.ts')
  const engine = new AudioEngineManager(
    { exclusiveMode: false },
    {
      nativeBinding: null,
      scheduler: {
        now: () => 1_000,
        setInterval: () => ({}) as NodeJS.Timeout,
        clearInterval: () => {},
        setImmediate: (callback) => callback()
      }
    }
  )
  const timer = new SleepTimerService({ now: () => 1_000 })
  registerNativeSleepTimerBoundaries(engine, timer)
  timer.configure(createSleepTimerState('queueEnd', 1_000, { defaultMinutes: 1, fadeSeconds: 0 }))
  engine.emit('sleep-timer-boundary', { boundary: 'queueEnd' })
  engine.emit('sleep-timer-boundary', { boundary: 'queueEnd' })
  assert.equal(timer.snapshot()?.triggered, true)
})
