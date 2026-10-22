import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createSleepTimerState,
  isSleepTimerShutdownHandoff,
  isSleepTimerState,
  remainingSleepTimerSeconds,
  shouldTriggerSleepTimer
} from './sleepTimer.ts'

const settings = { defaultMinutes: 10, fadeSeconds: 8 }

test('minute sleep timer triggers only after its requested duration', () => {
  const state = createSleepTimerState('minutes', 1_000, settings, 2)
  assert.equal(remainingSleepTimerSeconds(state, 1_000), 120)
  assert.equal(shouldTriggerSleepTimer(state, 120_999, 'tick'), false)
  assert.equal(shouldTriggerSleepTimer(state, 121_000, 'tick'), true)
})

test('runtime state guard rejects malformed IPC and session timer payloads', () => {
  const valid = createSleepTimerState('minutes', 1_000, settings, 2)
  assert.equal(isSleepTimerState(valid), true)
  assert.equal(isSleepTimerState({ ...valid, endsAt: null }), false)
  assert.equal(isSleepTimerState({ ...valid, fadeSeconds: 121 }), false)
  assert.equal(isSleepTimerState({ ...valid, mode: 'later' }), false)
  assert.equal(isSleepTimerState({ mode: 'queueEnd', endsAt: 5, fadeSeconds: 1 }), false)
  assert.equal(isSleepTimerState({ ...valid, active: true, triggered: true }), false)
  assert.equal(isSleepTimerState({ ...valid, active: false, triggered: false }), false)
})

test('track and queue sleep modes only trigger for their matching playback boundary', () => {
  const track = createSleepTimerState('trackEnd', 0, settings)
  const queue = createSleepTimerState('queueEnd', 0, settings)
  assert.equal(shouldTriggerSleepTimer(track, 0, 'queueEnd'), false)
  assert.equal(shouldTriggerSleepTimer(track, 0, 'trackEnd'), true)
  assert.equal(shouldTriggerSleepTimer(queue, 0, 'trackEnd'), false)
  assert.equal(shouldTriggerSleepTimer(queue, 0, 'queueEnd'), true)
})

test('shutdown identity belongs only to a fired timer and handoff values are bounded at the wire', () => {
  const armed = createSleepTimerState('trackEnd', 1_000, settings)
  const terminal = { ...armed, active: false, triggered: true, triggerRevision: 7 }
  assert.equal(isSleepTimerState(terminal), true)
  assert.equal(isSleepTimerState({ ...terminal, shutdownOwner: 'main' }), true)
  for (const triggerRevision of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(isSleepTimerState({ ...terminal, triggerRevision }), false)
    assert.equal(
      isSleepTimerShutdownHandoff({ triggerRevision, startedAt: 1_000, volume: 0.7 }),
      false
    )
  }
  assert.equal(isSleepTimerState({ ...armed, triggerRevision: 7 }), false)
  assert.equal(
    isSleepTimerState({ ...terminal, triggerRevision: undefined, shutdownOwner: 'main' }),
    false
  )
  assert.equal(isSleepTimerState({ ...terminal, shutdownOwner: 'renderer' }), false)
  const handoff = { triggerRevision: 7, startedAt: 1_000, volume: 0.7 }
  assert.equal(isSleepTimerShutdownHandoff(handoff), true)
  for (const startedAt of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(isSleepTimerShutdownHandoff({ ...handoff, startedAt }), false)
  for (const volume of [-0.1, 1.1, NaN, Infinity, '0.7', null])
    assert.equal(isSleepTimerShutdownHandoff({ ...handoff, volume }), false)
})
