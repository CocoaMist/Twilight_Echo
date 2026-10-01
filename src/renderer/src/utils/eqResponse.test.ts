import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeAutoPreampDb,
  computeBandResponse,
  computeBiquadCoefficients,
  computeCompositeResponse,
  computeEstimatedSourceDeviation,
  isBandActive,
  magnitudeDbAtFrequency,
  sampleLogFrequencies
} from './eqResponse.ts'
import type { EqualizerBand } from '../types/settings'

const SAMPLE_RATE = 48000

function makeBand(patch: Partial<EqualizerBand> = {}): EqualizerBand {
  return { frequency: 1000, gain: 0, q: 1, filterType: 'peak', ...patch }
}

test('peak filter magnitude at center frequency equals its gain', () => {
  for (const gain of [-12, -6, 3, 6, 12]) {
    const coeffs = computeBiquadCoefficients('peak', 1000, gain, 1, SAMPLE_RATE)
    const db = magnitudeDbAtFrequency(coeffs, 1000, SAMPLE_RATE)
    assert.ok(Math.abs(db - gain) < 0.01, `peak ${gain} dB measured ${db.toFixed(3)} dB`)
  }
})

test('peak filter is nearly flat far away from its center frequency', () => {
  const coeffs = computeBiquadCoefficients('peak', 1000, 12, 2, SAMPLE_RATE)
  assert.ok(Math.abs(magnitudeDbAtFrequency(coeffs, 20, SAMPLE_RATE)) < 0.5)
  assert.ok(Math.abs(magnitudeDbAtFrequency(coeffs, 20000, SAMPLE_RATE)) < 0.5)
})

test('low shelf asymptotes: full gain below, flat above', () => {
  const coeffs = computeBiquadCoefficients('lowShelf', 500, 9, 1, SAMPLE_RATE)
  assert.ok(Math.abs(magnitudeDbAtFrequency(coeffs, 20, SAMPLE_RATE) - 9) < 0.3)
  assert.ok(Math.abs(magnitudeDbAtFrequency(coeffs, 15000, SAMPLE_RATE)) < 0.3)
})

test('high shelf asymptotes: flat below, full gain above', () => {
  const coeffs = computeBiquadCoefficients('highShelf', 2000, -8, 1, SAMPLE_RATE)
  assert.ok(Math.abs(magnitudeDbAtFrequency(coeffs, 20, SAMPLE_RATE)) < 0.3)
  assert.ok(Math.abs(magnitudeDbAtFrequency(coeffs, 20000, SAMPLE_RATE) + 8) < 0.5)
})

test('band pass peaks at 0 dB at its center frequency and rolls off elsewhere', () => {
  const coeffs = computeBiquadCoefficients('bandPass', 1000, 0, 2, SAMPLE_RATE)
  assert.ok(Math.abs(magnitudeDbAtFrequency(coeffs, 1000, SAMPLE_RATE)) < 0.05)
  assert.ok(magnitudeDbAtFrequency(coeffs, 100, SAMPLE_RATE) < -10)
  assert.ok(magnitudeDbAtFrequency(coeffs, 10000, SAMPLE_RATE) < -10)
})

test('low pass and high pass are ~-3 dB at cutoff with butterworth q', () => {
  const q = Math.SQRT1_2
  const lowPass = computeBiquadCoefficients('lowPass', 1000, 0, q, SAMPLE_RATE)
  const highPass = computeBiquadCoefficients('highPass', 1000, 0, q, SAMPLE_RATE)
  assert.ok(Math.abs(magnitudeDbAtFrequency(lowPass, 1000, SAMPLE_RATE) + 3.01) < 0.1)
  assert.ok(Math.abs(magnitudeDbAtFrequency(highPass, 1000, SAMPLE_RATE) + 3.01) < 0.1)
  assert.ok(Math.abs(magnitudeDbAtFrequency(lowPass, 50, SAMPLE_RATE)) < 0.1)
  assert.ok(magnitudeDbAtFrequency(lowPass, 10000, SAMPLE_RATE) < -30)
})

test('notch removes its center frequency and passes far frequencies', () => {
  const coeffs = computeBiquadCoefficients('notch', 1000, 0, 2, SAMPLE_RATE)
  assert.ok(magnitudeDbAtFrequency(coeffs, 1000, SAMPLE_RATE) < -60)
  assert.ok(Math.abs(magnitudeDbAtFrequency(coeffs, 20, SAMPLE_RATE)) < 0.1)
})

test('all pass has unity magnitude everywhere', () => {
  const coeffs = computeBiquadCoefficients('allPass', 1000, 0, 1, SAMPLE_RATE)
  for (const frequency of [50, 500, 1000, 5000, 18000]) {
    assert.ok(Math.abs(magnitudeDbAtFrequency(coeffs, frequency, SAMPLE_RATE)) < 1e-6)
  }
})

test('sampleLogFrequencies spans the requested range with log spacing', () => {
  const frequencies = sampleLogFrequencies(256, 20, 20000)
  assert.equal(frequencies.length, 256)
  assert.ok(Math.abs(frequencies[0] - 20) < 1e-9)
  assert.ok(Math.abs(frequencies[255] - 20000) < 1e-6)
  const midRatio = frequencies[128] / frequencies[127]
  const endRatio = frequencies[255] / frequencies[254]
  assert.ok(Math.abs(midRatio - endRatio) < 1e-6)
})

test('composite response is flat when all gains are zero', () => {
  const bands = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((frequency) =>
    makeBand({ frequency })
  )
  const response = computeCompositeResponse(bands, 0, { mode: 'graphic' })
  for (const point of response) {
    assert.ok(Math.abs(point.db) < 1e-9, `expected flat at ${point.frequency}, got ${point.db}`)
  }
})

test('graphic mode forces every band to a peak filter', () => {
  const band = makeBand({ frequency: 1000, gain: 6, filterType: 'lowPass' })
  const graphic = computeCompositeResponse([band], 0, { mode: 'graphic', pointCount: 64 })
  const peak = computeCompositeResponse([makeBand({ frequency: 1000, gain: 6 })], 0, {
    mode: 'parametric',
    pointCount: 64
  })
  for (let index = 0; index < graphic.length; index++) {
    assert.ok(Math.abs(graphic[index].db - peak[index].db) < 1e-9)
  }
})

test('composite equals the sum of single-band responses plus preamp', () => {
  const bands = [
    makeBand({ frequency: 100, gain: 6, q: 1.4 }),
    makeBand({ frequency: 1000, gain: -4, q: 0.8 }),
    makeBand({ frequency: 8000, gain: 3, filterType: 'highShelf' })
  ]
  const preamp = -2.5
  const composite = computeCompositeResponse(bands, preamp, { pointCount: 96 })
  const singles = bands.map((band) => computeBandResponse(band, { pointCount: 96 }))
  for (let index = 0; index < composite.length; index++) {
    const expected = preamp + singles.reduce((sum, single) => sum + single[index].db, 0)
    assert.ok(
      Math.abs(composite[index].db - expected) < 1e-9,
      `mismatch at ${composite[index].frequency}`
    )
  }
})

test('disabled bands and zero-gain peak bands are skipped like the engine', () => {
  const disabled = makeBand({ gain: 12, enabled: false })
  const zeroGainPeak = makeBand({ gain: 0 })
  const response = computeCompositeResponse([disabled, zeroGainPeak], 0, { pointCount: 32 })
  for (const point of response) {
    assert.ok(Math.abs(point.db) < 1e-9)
  }
})

test('gain-independent filters remain active at zero gain and respect bypass and graphic mode', () => {
  for (const filterType of ['lowPass', 'highPass', 'bandPass', 'notch', 'allPass'] as const) {
    const band = makeBand({ filterType })
    assert.equal(isBandActive(band), true, filterType)
    assert.equal(isBandActive({ ...band, enabled: false }), false)
    assert.equal(isBandActive(band, 'graphic'), false)
  }
  const options = { minFrequency: 100, maxFrequency: 10000, pointCount: 3 }
  const notch = computeBandResponse(makeBand({ filterType: 'notch' }), options)
  assert.ok(notch[1].db < -60)
  const bandPass = computeBandResponse(makeBand({ filterType: 'bandPass' }), options)
  assert.ok(bandPass[0].db < -15 && bandPass[2].db < -15)
  assert.ok(Math.abs(bandPass[1].db) < 0.01)
})

test('shelf Q changes resonance while preserving midpoint and endpoint gains', () => {
  for (const type of ['lowShelf', 'highShelf'] as const) {
    for (const gain of [-9, 9]) {
      const broad = computeBiquadCoefficients(type, 1000, gain, Math.SQRT1_2)
      const resonant = computeBiquadCoefficients(type, 1000, gain, 2)
      assert.ok(
        Math.abs(magnitudeDbAtFrequency(broad, 500) - magnitudeDbAtFrequency(resonant, 500)) > 1
      )
      for (const coeffs of [broad, resonant]) {
        assert.ok(Math.abs(magnitudeDbAtFrequency(coeffs, 1000) - gain / 2) < 1e-6)
        assert.ok(
          Math.abs(magnitudeDbAtFrequency(coeffs, 0) - (type === 'lowShelf' ? gain : 0)) < 1e-6
        )
        assert.ok(
          Math.abs(magnitudeDbAtFrequency(coeffs, 24000) - (type === 'highShelf' ? gain : 0)) < 1e-6
        )
      }
    }
  }
})

test('low pass bands still filter with zero gain', () => {
  const lowPass = makeBand({ frequency: 1000, gain: 0, filterType: 'lowPass' })
  const response = computeCompositeResponse([lowPass], 0, { pointCount: 128 })
  const last = response[response.length - 1]
  assert.ok(last.db < -30)
})

test('split manual and OPRA responses sum to the effective DSP response', () => {
  const manualBands = [makeBand({ frequency: 180, gain: 3, q: 1.1 })]
  const opraBands = [makeBand({ frequency: 3200, gain: -5, q: 2 })]
  const manualPreamp = -1.5
  const opraPreamp = -4.5
  const options = { mode: 'parametric' as const, pointCount: 96 }
  const manual = computeCompositeResponse(manualBands, manualPreamp, options)
  const opra = computeCompositeResponse(opraBands, opraPreamp, options)
  const effective = computeCompositeResponse(
    [...opraBands, ...manualBands],
    opraPreamp + manualPreamp,
    options
  )

  for (let index = 0; index < effective.length; index++) {
    assert.ok(Math.abs(effective[index].db - (manual[index].db + opra[index].db)) < 1e-9)
  }
})

test('estimated source deviation inverts correction filters at every sampled frequency', () => {
  const correctionBands = [
    makeBand({ frequency: 120, gain: 5, q: 0.8, filterType: 'lowShelf' }),
    makeBand({ frequency: 2800, gain: -4, q: 2.2 }),
    makeBand({ frequency: 9000, gain: 2, q: 0.7, filterType: 'highShelf' })
  ]
  const correction = computeCompositeResponse(correctionBands, 0, {
    mode: 'parametric',
    pointCount: 128
  })
  const estimated = computeEstimatedSourceDeviation(correctionBands, { pointCount: 128 })

  assert.equal(estimated.length, correction.length)
  for (let index = 0; index < correction.length; index++) {
    assert.equal(estimated[index].frequency, correction[index].frequency)
    assert.ok(Math.abs(estimated[index].db + correction[index].db) < 1e-9)
  }
})

test('estimated source deviation excludes correction preamp by API design', () => {
  const correctionBands = [makeBand({ frequency: 1000, gain: 6, q: 1 })]
  const estimated = computeEstimatedSourceDeviation(correctionBands, { pointCount: 65 })
  const correctionWithHeadroom = computeCompositeResponse(correctionBands, -7, {
    mode: 'parametric',
    pointCount: 65
  })
  const centerIndex = estimated.reduce(
    (nearest, point, index) =>
      Math.abs(point.frequency - 1000) < Math.abs(estimated[nearest].frequency - 1000)
        ? index
        : nearest,
    0
  )

  assert.ok(Math.abs(estimated[centerIndex].db + 6) < 0.05)
  assert.ok(Math.abs(estimated[centerIndex].db + correctionWithHeadroom[centerIndex].db) > 6.9)
})

test('estimated source deviation always treats correction bands as parametric', () => {
  const shelf = makeBand({ frequency: 500, gain: 8, q: 0.7, filterType: 'lowShelf' })
  const estimated = computeEstimatedSourceDeviation([shelf], { mode: 'graphic', pointCount: 64 })
  const parametricCorrection = computeCompositeResponse([shelf], 0, {
    mode: 'parametric',
    pointCount: 64
  })
  for (let index = 0; index < estimated.length; index++) {
    assert.ok(Math.abs(estimated[index].db + parametricCorrection[index].db) < 1e-9)
  }
})

test('auto preamp offsets the maximum boost with a safety margin', () => {
  const bands = [makeBand({ frequency: 1000, gain: 6 })]
  const preamp = computeAutoPreampDb(bands, { mode: 'graphic' })
  assert.ok(preamp <= -6.4 && preamp >= -7.1, `auto preamp ${preamp}`)
})

test('auto preamp is zero for cut-only curves and clamps to the slider range', () => {
  const cutOnly = [makeBand({ frequency: 1000, gain: -8 })]
  assert.equal(computeAutoPreampDb(cutOnly), 0)

  const extreme = [
    makeBand({ frequency: 900, gain: 24 }),
    makeBand({ frequency: 1000, gain: 24 }),
    makeBand({ frequency: 1100, gain: 24 })
  ]
  const preamp = computeAutoPreampDb(extreme)
  assert.ok(preamp >= -24)
  assert.equal(preamp, -24)
})
