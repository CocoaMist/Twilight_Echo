import assert from 'node:assert/strict'
import test from 'node:test'
import { clampVolumePercent, createVolumeWheelStepper } from './volumeWheel.ts'

function wheel(deltaY: number, options: Partial<WheelEvent> = {}): WheelEvent {
  return { deltaY, deltaX: 0, deltaMode: 0, timeStamp: 0, ctrlKey: false, ...options } as WheelEvent
}

test('mouse detents adjust by whole steps in both directions and respect scroll units', () => {
  const step = createVolumeWheelStepper()
  assert.equal(step(wheel(-100)), 1)
  assert.equal(step(wheel(100)), -1)
  assert.equal(step(wheel(-300)), 3)
  assert.equal(step(wheel(-3, { deltaMode: 1 })), 1)
  assert.equal(step(wheel(1, { deltaMode: 2 })), -1)
})

test('small trackpad deltas accumulate without changing volume for each event', () => {
  const step = createVolumeWheelStepper()
  for (let i = 0; i < 5; i++) assert.equal(step(wheel(-2)), 0)
  assert.equal(step(wheel(-2)), 1)
  assert.equal(step(wheel(6)), 0)
  assert.equal(step(wheel(-6)), 0)
  assert.equal(step(wheel(-6)), 1)
})

test('old gestures, empty deltas and pinch gestures cannot cause an extra step', () => {
  const step = createVolumeWheelStepper()
  assert.equal(step(wheel(-10)), 0)
  assert.equal(step(wheel(-2, { timeStamp: 200 })), 0)
  assert.equal(step(wheel(0)), 0)
  assert.equal(step(wheel(NaN)), 0)
  assert.equal(step(wheel(-100, { ctrlKey: true })), 0)
})

test('stepped percentages stay within the volume range without floating point drift', () => {
  assert.equal(clampVolumePercent(100.7), 100)
  assert.equal(clampVolumePercent(-1), 0)
  assert.equal(clampVolumePercent(0.7 * 100 + 1), 71)
  assert.equal(clampVolumePercent(81, 80), 80)
})
