import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EQ_DISPLAY_RANGES,
  gainTicksForRange,
  gainToPercent,
  percentToGain,
  responseToPath
} from './eqViewport.ts'

test('all display ranges share reversible gain coordinates with their grid and curve', () => {
  for (const range of EQ_DISPLAY_RANGES) {
    const ticks = gainTicksForRange(range)
    assert.equal(ticks.length, 7)
    for (const gain of ticks) {
      const y = gainToPercent(gain, range)
      assert.equal(percentToGain(y, range), gain)
      assert.equal(
        responseToPath([{ frequency: 1000, db: gain }], range).split(',')[1],
        y.toFixed(2)
      )
    }
    assert.equal(gainToPercent(range, range), 0)
    assert.equal(gainToPercent(0, range), 50)
    assert.equal(gainToPercent(-range, range), 100)
  }
})

test('off-screen paths keep real coordinates while nodes stay reachable at the boundary', () => {
  const points = [
    { frequency: 20, db: 12 },
    { frequency: 20000, db: -12 }
  ]
  assert.equal(responseToPath(points, 3, false), 'M0.00,-150.00 L100.00,250.00')
  assert.equal(gainToPercent(12, 3), 0)
  assert.equal(gainToPercent(-12, 3), 100)
  assert.equal(points[0].db, 12)
  assert.equal(responseToPath([], 30, false), '')
})
