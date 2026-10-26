import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeBase64Bytes,
  decodeWaveformPeaks,
  resolveSilenceTrimRange
} from './waveformPeaks.ts'

test('decodes Base64 uint8 waveform peaks and max-pools to requested bar count', () => {
  const raw = new Uint8Array([0, 64, 128, 255, 128, 64, 32, 0])
  const base64 = Buffer.from(raw).toString('base64')
  assert.deepEqual(Array.from(decodeBase64Bytes(base64)), Array.from(raw))

  const bars = decodeWaveformPeaks(base64, 4)
  assert.equal(bars.length, 4)
  assert.ok(Math.abs(bars[0] - 64 / 255) < 0.01)
  assert.equal(bars[1], 1)
  assert.ok(Math.abs(bars[2] - 128 / 255) < 0.01)
  assert.ok(Math.abs(bars[3] - 32 / 255) < 0.01)
})

test('computes silence trim bounds from noiseStartMs and noiseEndMs', () => {
  const bounds = resolveSilenceTrimRange(240, 420, 238500)
  assert.deepEqual(bounds, {
    trimStartSeconds: 0.42,
    trimEndSeconds: 238.5,
    trimmedLeadingMs: 420,
    trimmedTrailingMs: 1500
  })
})
