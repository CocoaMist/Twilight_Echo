import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMiniPlayerStateSnapshot,
  createMiniPlayerPublishScheduler,
  miniPlayerProgressKey
} from './useMiniPlayerSync.ts'
import type { Track } from '../types/music.ts'
import { ref, shallowRef } from 'vue'
import { createQueueCommandController } from '@renderer/stores/player/queueCommandController.ts'
import { toPlaybackQueueSnapshots } from '@renderer/utils/playbackQueueVirtualization.ts'
import type { PlayMode } from '@renderer/types/settings'

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 'ncm:1',
    title: 'Daydream',
    artist: 'Twilight Echo',
    album: 'Afterglow',
    albumArtist: 'Twilight Echo',
    trackNumber: 7,
    fileName: 'daydream.mp3',
    filePath: 'ncm:1',
    duration: 240,
    size: 0,
    cover: null,
    format: 'FLAC',
    sampleRate: 192000,
    bitDepth: 24,
    lyrics: '[00:01.00]first line\n[00:03.00]second line',
    translatedLyrics: '[00:01.00]第一行\n[00:03.00]第二行',
    ...overrides
  }
}

function makeSource(track: Track | null, currentTime: number) {
  return {
    track,
    isPlaying: true,
    isLoading: false,
    currentTime,
    duration: 240,
    playbackRate: 1.25,
    volume: 0.7,
    playMode: 'sequential' as const,
    favoriteAvailable: false,
    favoriteLiked: false,
    favoriteLoading: false,
    dominantColor: '#7c4dff',
    queueIndex: 0,
    queueLength: 1
  }
}

test('mini player snapshots follow queue clear and undo with the restored index and paused transport', (t) => {
  const queue = shallowRef(toPlaybackQueueSnapshots([makeTrack(), makeTrack()]))
  const originalQueue = shallowRef([...queue.value])
  const currentTrack = shallowRef<Track | null>(queue.value[1])
  const queueIndex = ref(1)
  const isPlaying = ref(true)
  const time = ref(35)
  const commands = createQueueCommandController({
    queue,
    originalQueue,
    currentTrack,
    queueIndex,
    playMode: ref<PlayMode>('sequential'),
    getPosition: () => time.value,
    prepareSelection: (track, position) => {
      currentTrack.value = track
      time.value = position
      isPlaying.value = false
    },
    onMutation: () => {}
  })
  t.after(commands.dispose)
  const snapshot = () =>
    buildMiniPlayerStateSnapshot({
      ...makeSource(currentTrack.value, time.value),
      isPlaying: isPlaying.value,
      queueIndex: queueIndex.value,
      queueLength: queue.value.length
    })
  commands.replace([], -1)
  assert.equal(snapshot().track, null)
  assert.equal(snapshot().queueLength, 0)
  assert.equal(snapshot().queueIndex, -1)
  commands.undo()
  assert.equal(snapshot().track?.id, 'ncm:1')
  assert.equal(snapshot().queueLength, 2)
  assert.equal(snapshot().queueIndex, 1)
  assert.equal(snapshot().currentTime, 35)
  assert.equal(snapshot().isPlaying, false)
})

test('mini player snapshot carries track metadata and quality but no lyric payload', () => {
  const snapshot = buildMiniPlayerStateSnapshot(makeSource(makeTrack(), 3.5))
  assert.equal('currentLyric' in snapshot, false)
  assert.equal('lyrics' in snapshot, false)
  assert.equal(snapshot.track?.format, 'FLAC')
  assert.equal(snapshot.track?.sampleRate, 192000)
  assert.equal(snapshot.track?.bitDepth, 24)
  assert.equal(snapshot.track?.albumArtist, 'Twilight Echo')
  assert.equal(snapshot.track?.trackNumber, 7)
  assert.equal(snapshot.playbackRate, 1.25)
})

test('mini player snapshot keeps quality fields null when the track has none', () => {
  const snapshot = buildMiniPlayerStateSnapshot(
    makeSource(makeTrack({ format: undefined, sampleRate: undefined, bitDepth: undefined }), 3.5)
  )
  assert.equal(snapshot.track?.format, null)
  assert.equal(snapshot.track?.sampleRate, null)
  assert.equal(snapshot.track?.bitDepth, null)
})

test('mini player progress key only changes across whole seconds', () => {
  assert.equal(miniPlayerProgressKey(1.1), miniPlayerProgressKey(1.4))
  assert.notEqual(miniPlayerProgressKey(1.9), miniPlayerProgressKey(2.1))
  assert.equal(miniPlayerProgressKey(5.2), miniPlayerProgressKey(5.9))
  assert.notEqual(miniPlayerProgressKey(5.9), miniPlayerProgressKey(6.0))
  assert.equal(miniPlayerProgressKey(Number.NaN), '-1')
})

test('mini player publish scheduler throttles progress ticks and publishes metadata immediately', () => {
  let now = 0
  let key = '0:0'
  const timers: Array<{ at: number; callback: () => void }> = []
  const published: number[] = []
  const scheduler = createMiniPlayerPublishScheduler({
    publish: () => published.push(now),
    progressKey: () => key,
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const timer = { at: now + delayMs, callback }
      timers.push(timer)
      return timer
    },
    clearTimeout: (handle) => {
      const index = timers.indexOf(handle as { at: number; callback: () => void })
      if (index >= 0) timers.splice(index, 1)
    },
    throttleMs: 500
  })
  const advance = (ms: number) => {
    now += ms
    for (const timer of [...timers]) {
      if (timer.at > now) continue
      timers.splice(timers.indexOf(timer), 1)
      timer.callback()
    }
  }

  scheduler.publishNow()
  assert.deepEqual(published, [0])

  // 250 ms ticks inside the same second: nothing is sent.
  advance(250)
  scheduler.notifyProgress()
  advance(250)
  scheduler.notifyProgress()
  assert.deepEqual(published, [0])

  // Outside the throttle window a changed key publishes right away.
  key = '0:1'
  advance(100)
  scheduler.notifyProgress()
  assert.deepEqual(published, [0, 600])

  // Inside the window the publish trails to the window edge, once.
  key = '0:2'
  advance(100)
  scheduler.notifyProgress()
  advance(100)
  scheduler.notifyProgress()
  assert.deepEqual(published, [0, 600])
  assert.equal(timers.length, 1)
  advance(300)
  assert.deepEqual(published, [0, 600, 1100])
  assert.equal(timers.length, 0)

  // A pending trailing publish is superseded by an immediate metadata publish.
  key = '1:3'
  advance(100)
  scheduler.notifyProgress()
  assert.equal(timers.length, 1)
  scheduler.publishNow()
  assert.equal(timers.length, 0)
  assert.deepEqual(published, [0, 600, 1100, 1200])
  advance(1000)
  assert.deepEqual(published, [0, 600, 1100, 1200])

  scheduler.dispose()
  key = '2:9'
  advance(1000)
  scheduler.notifyProgress()
  assert.deepEqual(published, [0, 600, 1100, 1200])
})
