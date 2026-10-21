import assert from 'node:assert/strict'
import test from 'node:test'
import { isPlaybackSession } from './playbackSession.ts'

const session = () => ({
  version: 1,
  savedAt: '2026-10-02T00:00:00Z',
  mode: 'trackAndPosition',
  track: { id: 'local:one' },
  position: 12,
  queueRevision: 2,
  queue: [{ id: 'local:one', cueRange: { startSeconds: 0, endSeconds: 60 } }]
})

test('playback persistence accepts legacy sessions and optional queue revisions', () => {
  assert.equal(isPlaybackSession(session()), true)
  const { queueRevision: _queueRevision, queue: _queue, ...legacy } = session()
  assert.equal(isPlaybackSession(legacy), true)
  for (const mode of ['off', 'track', 'trackAndPosition']) {
    assert.equal(isPlaybackSession({ ...legacy, mode }), true)
  }
})

test('the common main/preload validator rejects invalid versions, positions, cursors and tracks', () => {
  for (const patch of [
    { version: 2 },
    { mode: 'invalid' },
    { savedAt: null },
    { track: {} },
    { track: [] },
    { position: NaN },
    { position: Infinity },
    { position: -1 },
    { queueRevision: -1 },
    { queueRevision: 1.5 },
    { queueRevision: '2' },
    { queue: {} }
  ]) {
    assert.equal(isPlaybackSession({ ...session(), ...patch }), false)
  }
  assert.equal(isPlaybackSession(null), false)
  assert.equal(isPlaybackSession([]), false)
})

test('invalid CUE bounds are rejected in both the active track and the queued snapshots', () => {
  const cueRange = { startSeconds: 20, endSeconds: 10 }
  assert.equal(isPlaybackSession({ ...session(), track: { id: 'local:one', cueRange } }), false)
  assert.equal(isPlaybackSession({ ...session(), queue: [{ id: 'local:one', cueRange }] }), false)
  assert.equal(isPlaybackSession({ ...session(), queue: [null] }), false)
})

test('database sessions use one compact occurrence reference, never an array queue or its revision', () => {
  const value = {
    version: 1,
    savedAt: '',
    mode: 'trackAndPosition',
    position: 42,
    track: { id: 'track', queueEntryId: 'second' },
    libraryQueue: { id: 'queue', revision: 9, entryId: 'second', index: 299_999 }
  }
  assert.equal(isPlaybackSession(value), true)
  for (const patch of [
    { queue: [] },
    { queueIndex: 0 },
    { queueRevision: 1 },
    { track: { id: 'track', queueEntryId: 'first' } },
    { libraryQueue: null }
  ])
    assert.equal(isPlaybackSession({ ...value, ...patch }), false)
  for (const patch of [
    { id: '' },
    { id: 'q'.repeat(129) },
    { entryId: '' },
    { revision: -1 },
    { revision: 1.2 },
    { index: -1 },
    { index: Infinity }
  ])
    assert.equal(
      isPlaybackSession({ ...value, libraryQueue: { ...value.libraryQueue, ...patch } }),
      false
    )
})
