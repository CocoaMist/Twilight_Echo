import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PARAMETRIC_EQ_MAX_FREQUENCY,
  PARAMETRIC_EQ_MAX_Q,
  PARAMETRIC_EQ_MIN_FREQUENCY,
  PARAMETRIC_EQ_MIN_Q,
  advanceSpectrumLevels,
  adjustQByWheel,
  createParametricBand,
  displayBandGain,
  filterUsesGain,
  frequencyToPercent,
  gainToPercent,
  percentToFrequency,
  percentToGain,
  projectSpectrumLevels,
  spectrumLevelsToPath,
  spectrumToPath
} from './parametricEqInteraction.ts'

test('frequency mapping is logarithmic, reversible, and boundary-clamped', () => {
  assert.equal(frequencyToPercent(PARAMETRIC_EQ_MIN_FREQUENCY), 0)
  assert.equal(frequencyToPercent(PARAMETRIC_EQ_MAX_FREQUENCY), 100)
  assert.ok(Math.abs(percentToFrequency(-20) - PARAMETRIC_EQ_MIN_FREQUENCY) < 1e-9)
  assert.ok(Math.abs(percentToFrequency(100) - PARAMETRIC_EQ_MAX_FREQUENCY) < 1e-6)

  for (const frequency of [20, 63, 250, 1000, 4000, 16000, 20000]) {
    const roundTrip = percentToFrequency(frequencyToPercent(frequency))
    assert.ok(Math.abs(roundTrip - frequency) / frequency < 1e-9)
  }
})

test('gain mapping is reversible and uses the visible graph boundaries', () => {
  assert.equal(gainToPercent(18), 0)
  assert.equal(gainToPercent(0), 50)
  assert.equal(gainToPercent(-18), 100)
  assert.equal(percentToGain(0), 18)
  assert.equal(percentToGain(50), 0)
  assert.equal(percentToGain(100), -18)
})

test('wheel Q adjustment is multiplicative, supports fine mode, and clamps safely', () => {
  assert.ok(adjustQByWheel(1, -120) > 1)
  assert.ok(adjustQByWheel(1, 120) < 1)
  assert.ok(Math.abs(adjustQByWheel(1, -120, true) - 1) < Math.abs(adjustQByWheel(1, -120) - 1))
  assert.equal(adjustQByWheel(PARAMETRIC_EQ_MAX_Q, -100000), PARAMETRIC_EQ_MAX_Q)
  assert.equal(adjustQByWheel(PARAMETRIC_EQ_MIN_Q, 100000), PARAMETRIC_EQ_MIN_Q)
})

test('new bands and gain display preserve filter semantics', () => {
  assert.deepEqual(createParametricBand(999.6, 3.26), {
    frequency: 1000,
    gain: 3.3,
    q: 1,
    filterType: 'peak',
    enabled: true
  })
  assert.equal(filterUsesGain('peak'), true)
  assert.equal(filterUsesGain('lowShelf'), true)
  assert.equal(filterUsesGain('lowPass'), false)
  assert.equal(displayBandGain({ frequency: 1000, gain: 9, q: 1, filterType: 'lowPass' }), 0)
})

test('spectrum path is bounded, deterministic, and log-frequency sampled', () => {
  const spectrum = Array.from({ length: 64 }, (_, index) => index / 63)
  const path = spectrumToPath(spectrum, 48000, 32)
  assert.ok(path.startsWith('M0.00,'))
  assert.equal(path.split('L').length, 32)
  assert.match(path, /L100\.00,/)
  assert.equal(spectrumToPath([], 48000), '')
  assert.equal(spectrumToPath(spectrum, 0), '')
})

test('high-resolution spectrum keeps a narrow upper-frequency peak', () => {
  const spectrum = Array.from({ length: 2048 }, () => 0)
  spectrum[1300] = 1
  const path = spectrumToPath(spectrum, 48000)
  const projected = projectSpectrumLevels(spectrum, 48000)
  const levels = [...path.matchAll(/[ML]\d+\.\d+,([\d.]+)/g)].map((match) => Number(match[1]))
  assert.equal(levels.length, 720)
  assert.equal(spectrumLevelsToPath(projected), path)
  assert.ok(levels.some((level) => level < 20))
  assert.ok(levels.filter((level) => level < 20).length <= 2)
})

test('bass spectrum rounds sparse FFT corners without exceeding source peaks', () => {
  const spectrum = Array.from({ length: 2048 }, () => 0.1)
  spectrum[3] = 0.2
  spectrum[4] = 0.45
  spectrum[5] = 0.9
  spectrum[6] = 0.5
  spectrum[7] = 0.25
  const levels = projectSpectrumLevels(spectrum, 48000)
  const peakFrequency = (5 * 24000) / (spectrum.length - 1)
  const peakIndex = Math.round((frequencyToPercent(peakFrequency) / 100) * (levels.length - 1))
  assert.ok(levels[peakIndex] > 0.895)
  assert.ok(levels[peakIndex] <= 0.9)
  assert.ok(levels[peakIndex] - levels[peakIndex - 1] < 0.01)
  assert.ok(levels[peakIndex] - levels[peakIndex + 1] < 0.01)
  const bassEnd = Math.floor((frequencyToPercent(120) / 100) * (levels.length - 1))
  assert.ok(levels.slice(0, bassEnd).every((level) => level >= 0.1 && level <= 0.9))
})

test('spectrum damping keeps the same response at different display refresh rates', () => {
  const target = new Float32Array([1, 0])
  const sixtyHertz = new Float32Array([0, 1])
  const thirtyHertz = new Float32Array([0, 1])
  for (let frame = 0; frame < 6; frame += 1) {
    advanceSpectrumLevels(sixtyHertz, target, 10)
  }
  for (let frame = 0; frame < 2; frame += 1) {
    advanceSpectrumLevels(thirtyHertz, target, 30)
  }
  assert.ok(Math.abs(sixtyHertz[0] - thirtyHertz[0]) < 1e-6)
  assert.ok(Math.abs(sixtyHertz[1] - thirtyHertz[1]) < 1e-6)
  assert.ok(Math.abs(sixtyHertz[0] - 0.42) < 1e-6)
  assert.ok(Math.abs(sixtyHertz[1] - 0.82) < 1e-6)
})
