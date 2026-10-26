import assert from 'node:assert/strict'
import test from 'node:test'
import { clampCuePlaybackPosition, cueDuration } from './cuePlayback.ts'

const cueTrack = {
  duration: 999,
  cueRange: {
    startSeconds: 60,
    endSeconds: 120,
    pregapSeconds: 2,
    virtualPregapSeconds: 2,
    sourcePregapSeconds: 0
  }
}

test('CUE positions are logical and clamped, including virtual pregap', () => {
  assert.equal(cueDuration(cueTrack), 62)
  assert.equal(clampCuePlaybackPosition(cueTrack, -1), 0)
  assert.equal(clampCuePlaybackPosition(cueTrack, 20), 20)
  assert.equal(clampCuePlaybackPosition(cueTrack, 999), 62)
})

test('invalid persisted CUE ranges cannot create negative or unbounded segment positions', () => {
  const invalid = {
    duration: 30,
    cueRange: { startSeconds: 70, endSeconds: 60, pregapSeconds: 0 }
  }
  assert.equal(cueDuration(invalid), 30)
  assert.equal(clampCuePlaybackPosition(invalid, -10), 0)
})
