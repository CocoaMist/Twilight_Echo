import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldApplyNativeTimePosition } from './playerProgressPolicy.ts'

test('native time-pos applies while the native engine owns playback', () => {
  assert.equal(
    shouldApplyNativeTimePosition({ nativePlaybackActive: true, nativeQueueDelegated: false }),
    true
  )
  assert.equal(
    shouldApplyNativeTimePosition({ nativePlaybackActive: false, nativeQueueDelegated: true }),
    true
  )
  assert.equal(
    shouldApplyNativeTimePosition({ nativePlaybackActive: true, nativeQueueDelegated: true }),
    true
  )
})

test('an inactive native clock cannot overwrite restored or cast progress', () => {
  assert.equal(
    shouldApplyNativeTimePosition({ nativePlaybackActive: false, nativeQueueDelegated: false }),
    false
  )
})
