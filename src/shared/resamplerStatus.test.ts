import assert from 'node:assert/strict'
import test from 'node:test'
import { describeResampler } from './resamplerStatus.ts'
import type { DspOutputStageStatus } from './dspGraph.ts'

const stage: DspOutputStageStatus = {
  targetSampleRate: null,
  actualSampleRate: 96000,
  resamplerQuality: 'soxrVhq',
  dither: 'off',
  active: false,
  reason: ''
}

test('a requested quality or process-wide probe cannot claim an effective engine', () => {
  for (const status of [undefined, stage, { ...stage, resamplerEngine: 'soxr' as const }])
    assert.match(describeResampler('soxrVhq', status), /请求 SoX VHQ · 实际 SRC 未验证/)
})

test('observed SWR fallback names its effective quality', () => {
  assert.match(
    describeResampler('soxrVhq', {
      ...stage,
      effectiveResampler: 'swr',
      effectiveResamplerQuality: 'ultra',
      effectiveResamplerFallback: true,
      resampled: true
    }),
    /实际 SWR Ultra（SoX 不可用，已回退）/
  )
  assert.doesNotMatch(
    describeResampler('soxrVhq', {
      ...stage,
      effectiveResampler: 'swr',
      effectiveResamplerQuality: 'ultra',
      resampled: true
    }),
    /不可用/
  )
})

test('an observed SoX stream and an equal-rate stream have different status', () => {
  assert.match(
    describeResampler('soxrVhq', {
      ...stage,
      effectiveResampler: 'soxr',
      effectiveResamplerQuality: 'soxrVhq',
      resampled: true
    }),
    /实际 SoX VHQ/
  )
  assert.match(
    describeResampler('soxrVhq', { ...stage, effectiveResampler: 'none', resampled: false }),
    /本引擎未重采样/
  )
})

test('incomplete or inconsistent observations stay unverified', () => {
  assert.match(
    describeResampler('soxrVhq', {
      ...stage,
      effectiveResampler: 'none',
      effectiveResamplerQuality: 'ultra',
      resampled: true
    }),
    /未验证/
  )
  assert.match(
    describeResampler('soxrVhq', { ...stage, effectiveResampler: 'soxr', resampled: null }),
    /未验证/
  )
})
