import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import type { Track } from '../../types/music'
import { createAbLoopController } from './abLoopController.ts'

function fixture(native?: (a: number, b: number) => Promise<boolean>) {
  const currentTrack = ref<Track | null>({
    id: 'local:one',
    source: 'local',
    duration: 60
  } as Track)
  const abLoopA = ref<number | null>(null)
  const abLoopB = ref<number | null>(null)
  const seeks: number[] = []
  const controller = createAbLoopController({
    currentTrack,
    abLoopA,
    abLoopB,
    getLatestPlaybackTime: () => 10,
    seekPlayback: (position) => seeks.push(position),
    getNativeLoopRange: () => native
  })
  return { ...controller, currentTrack, abLoopA, abLoopB, seeks }
}

test('A-B soft fallback preserves toggle, boundary tolerance and point validation', () => {
  const loop = fixture()
  loop.toggleAbLoopAtCurrentTime()
  assert.equal(loop.abLoopA.value, 10)
  loop.setAbLoopPoint('b', 5)
  assert.equal(loop.abLoopB.value, null)
  loop.setAbLoopPoint('b', 20)
  loop.enforceAbLoop(19.9)
  assert.deepEqual(loop.seeks, [])
  loop.enforceAbLoop(19.99)
  assert.deepEqual(loop.seeks, [10])
  loop.toggleAbLoopAtCurrentTime()
  loop.enforceAbLoop(25)
  assert.equal(loop.abLoopA.value, null)
  assert.deepEqual(loop.seeks, [10])
})

test('accepted native loop owns seeking; rejection falls back and clear sends the sentinel range', async () => {
  const ranges: number[][] = []
  let accepts = true
  const loop = fixture(async (a, b) => {
    ranges.push([a, b])
    return accepts
  })
  loop.setAbLoopPoint('a', 10)
  loop.setAbLoopPoint('b', 20)
  await Promise.resolve()
  assert.equal(loop.getAbLoopNativeActive(), true)
  loop.enforceAbLoop(21)
  assert.deepEqual(loop.seeks, [])
  accepts = false
  loop.setAbLoopPoint('b', 22)
  await Promise.resolve()
  loop.enforceAbLoop(23)
  assert.deepEqual(loop.seeks, [10])
  loop.clearAbLoop()
  assert.equal(loop.getAbLoopNativeActive(), false)
  assert.deepEqual(ranges.at(-1), [-1, -1])
})

test('radio and zero-duration HTTP streams reject loops while finite podcasts permit them', () => {
  const loop = fixture()
  for (const track of [
    { source: 'radio', duration: 60 },
    { source: 'podcast', duration: 0, streamUrl: 'https://radio.invalid/live' }
  ]) {
    loop.currentTrack.value = track as Track
    loop.setAbLoopPoint('b', 20)
    assert.equal(loop.abLoopA.value, null)
    assert.equal(loop.abLoopB.value, null)
  }
  loop.currentTrack.value = { source: 'podcast', duration: 60 } as Track
  loop.setAbLoopPoint('b', 20)
  assert.equal(loop.abLoopA.value, 0)
  assert.equal(loop.abLoopB.value, 20)
})
