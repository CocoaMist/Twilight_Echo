import assert from 'node:assert/strict'
import test from 'node:test'
import { accumulateSpectrumPeak, smoothSpectrum, spectrumDb, spectrumPath } from './eqSpectrum.ts'

test('native normalized spectrum maps to its -90 to +10 dB window', () => {
  assert.equal(spectrumDb(0), -90)
  assert.equal(spectrumDb(0.9), 0)
  assert.equal(spectrumDb(1), 10)
  assert.equal(spectrumPath(new Float32Array([0, 1]), 100), 'M0.00,98.00 L100.00,12.00')
  assert.equal(spectrumPath(new Float32Array([0.4, 1]), 60), 'M0.00,98.00 L100.00,12.00')
})

test('peak hold preserves transients without mutating input', () => {
  const peaks = new Float32Array([0.2, 0.8])
  const input = new Float32Array([0.9, 0.3])
  accumulateSpectrumPeak(peaks, input)
  assert.deepEqual(peaks, new Float32Array([0.9, 0.8]))
  assert.deepEqual(input, new Float32Array([0.9, 0.3]))
})

test('release speed is independent of refresh rate and never overshoots', () => {
  const target = new Float32Array([0, 1])
  const fast = new Float32Array([1, 0]),
    slow = fast.slice(),
    stepped = fast.slice()
  smoothSpectrum(fast, target, 120, 'fast')
  smoothSpectrum(slow, target, 120, 'slow')
  for (let index = 0; index < 12; index++) smoothSpectrum(stepped, target, 10, 'fast')
  assert.ok(fast[0] < slow[0])
  assert.ok(Math.abs(fast[0] - stepped[0]) < 1e-6)
  assert.ok(Math.abs(fast[1] - stepped[1]) < 1e-6)
  assert.ok(fast.every((value) => value >= 0 && value <= 1))
})
