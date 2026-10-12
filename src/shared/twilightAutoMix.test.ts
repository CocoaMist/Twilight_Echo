import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import {
  autoMixStatusKeys,
  effectiveAutoMixMode,
  TWILIGHT_AUTOMIX_RELEASE_READY
} from './twilightAutoMix.ts'

test('AutoMix status explains fallback and cancellation without exposing raw internal codes', () => {
  assert.deepEqual(autoMixStatusKeys('degraded', 'host_cancelled'), {
    phase: 'automix.phase.degraded',
    reason: 'automix.reason.waiting'
  })
  assert.equal(autoMixStatusKeys('degraded', 'low_beat_confidence').reason, 'automix.reason.beats')
  assert.equal(autoMixStatusKeys('degraded', 'invalid_source_range').reason, 'automix.reason.range')
  assert.equal(autoMixStatusKeys('ready').phase, 'automix.phase.ready')
  assert.equal(
    autoMixStatusKeys('ready', '', 'content-boundary').strategy,
    'automix.strategy.content-boundary'
  )
  assert.equal(
    autoMixStatusKeys('mixing', '', 'beat-aligned').strategy,
    'automix.strategy.beat-aligned'
  )
  assert.equal(autoMixStatusKeys('degraded', '', 'content-boundary').strategy, undefined)
  assert.equal(
    autoMixStatusKeys('mixing', '', 'tail-overlap').strategy,
    'automix.strategy.tail-overlap'
  )
  assert.equal(autoMixStatusKeys('ready', '', 'unknown').strategy, undefined)
  assert.equal(
    autoMixStatusKeys('ready', '', 'release-boundary').strategy,
    'automix.strategy.release-boundary'
  )
  assert.equal(
    autoMixStatusKeys('degraded', 'unknown_native_failure').reason,
    'automix.reason.failed'
  )
})

test('an unconfigured runtime retains the closed delivery gate and off mode', () => {
  assert.equal(TWILIGHT_AUTOMIX_RELEASE_READY, false)
  assert.equal(effectiveAutoMixMode('natural'), 'off')
  assert.equal(effectiveAutoMixMode('dj'), 'off')
})

test('evaluation builds can choose both modes while ordinary builds remain closed', async () => {
  for (const enabled of [false, true]) {
    const bundle = await build({
      configFile: false,
      logLevel: 'silent',
      define: { __TWILIGHT_AUTOMIX_EVALUATION__: JSON.stringify(enabled) },
      build: {
        write: false,
        minify: false,
        lib: {
          entry: fileURLToPath(new URL('./twilightAutoMix.ts', import.meta.url)),
          formats: ['es']
        }
      }
    })
    const bundles = Array.isArray(bundle) ? bundle : [bundle]
    assert.ok(bundles.every((item) => 'output' in item))
    const chunk = bundles
      .flatMap((item) => ('output' in item ? item.output : []))
      .find((item) => item.type === 'chunk')
    assert.ok(chunk?.type === 'chunk')
    const policy = await import(`data:text/javascript,${encodeURIComponent(chunk.code)}`)
    assert.equal(policy.TWILIGHT_AUTOMIX_RELEASE_READY, false)
    assert.equal(policy.TWILIGHT_AUTOMIX_EVALUATION_AVAILABLE, enabled)
    assert.equal(policy.TWILIGHT_AUTOMIX_AVAILABLE, enabled)
    assert.equal(policy.effectiveAutoMixMode('natural'), enabled ? 'natural' : 'off')
    assert.equal(policy.effectiveAutoMixMode('dj'), enabled ? 'dj' : 'off')
    assert.equal(policy.effectiveAutoMixMode('off'), 'off')
    assert.equal(policy.effectiveAutoMixMode(undefined), 'off')
    assert.equal(policy.effectiveAutoMixMode('unsupported'), 'off')
  }
})
