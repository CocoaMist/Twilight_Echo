import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { ref, shallowRef } from 'vue'
import { createPlaybackSessionController } from './player/playbackSessionController.ts'

const source = stripTypeScriptTypes(
  readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
)
function productionFunction(name) {
  const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'))
  assert.ok(start >= 0)
  const end = source.indexOf('\n}', start)
  assert.ok(end > start)
  return source.slice(start, end + 2)
}

for (const direction of ['next', 'previous']) {
  for (const stage of ['queue', 'advance', 'info']) {
    test(`${direction}: restoring a paused selection cancels stale work during ${stage}`, async () => {
      const f = fixture(stage)
      const pending = f.advanceNativePlayback(direction)
      await f.started
      f.controller.prepareQueueSelection(f.track('restored-session'), 37)
      f.release()
      await pending
      assert.deepEqual(f.loads, [])
      assert.equal(f.isPlaying.value, false)
      assert.equal(f.currentTrack.value.id, 'restored-session')
      assert.equal(f.isLoading.value, false)
      assert.equal(f.visualizationStarts(), 0)
    })
  }
}

test('a current native advance still reloads its predicted track when no native confirmation arrives', async () => {
  const f = fixture('advance')
  const pending = f.advanceNativePlayback('next')
  await f.started
  f.release()
  await pending
  assert.deepEqual(f.loads, ['old-B'])
  assert.equal(f.isPlaying.value, true)
})

function fixture(stage) {
  const track = (id) => ({
    id,
    queueEntryId: id,
    title: id,
    artist: '',
    album: '',
    source: 'local',
    filePath: `/Music/${id}.flac`,
    fileName: `${id}.flac`,
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null
  })
  const currentTrack = shallowRef(track('old-A'))
  const isPlaying = ref(true)
  const isLoading = ref(false)
  const queueIndex = ref(0)
  const duration = ref(180)
  let release
  let notify
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const started = new Promise((resolve) => {
    notify = resolve
  })
  const wait = async (at) => {
    if (stage === at) {
      notify()
      await gate
    }
  }
  const loads = []
  const windowStub = {
    setTimeout: (callback) => setTimeout(callback, 0),
    api: {
      audioEngine: {
        next: () => wait('advance'),
        previous: () => wait('advance'),
        getPlaybackInfo: async () => {
          await wait('info')
          return { state: 'stopped' }
        }
      }
    }
  }
  // These are the actual store functions and session controller. Only native
  // I/O and unrelated rendering dependencies are substituted for the test.
  const harness = new Function(
    'refs',
    'createPlaybackSessionController',
    'window',
    'loads',
    'track',
    'wait',
    `
    const { currentTrack, isPlaying, isLoading, queueIndex, duration } = refs;
    let activeLoadToken = 1, nativePlaybackActive = true, nativeQueueDelegated = true, restoredPlaybackPending = false;
    let startFilePlaybackInfoRefreshGeneration = 0, loadedTrackId = 'old-A', visualizationStarts = 0;
    const nativeQueueRevisionFence = { next() {} }, nativeSourceToTrackId = new Map(), playbackInfo = { value: null }, castTargetUsn = { value: null };
    const NATIVE_PLAYBACK_INFO_REFRESH_DELAY_MS = 0;
    const clearPlaybackToggleIntent = () => {}, setNativePlaybackInfoIntent = () => {}, clearNativePlaybackInfoIntent = () => {};
    const resetPlaybackClock = () => {}, resetNativeStreamBufferingState = () => {}, stopVisualizationPolling = () => {}, stopRendererAudio = () => {}, stopNativeAudio = async () => {};
    const startVisualizationPolling = () => { visualizationStarts++ }, setAudioEngineError = error => { throw new Error(error) };
    const getNativeQueueAdvanceTarget = () => ({ track: track('old-B'), queueIndex: 1 });
    const getTrackAudioSource = track => track.filePath;
    const activateCurrentTrack = track => { currentTrack.value = track };
    const waitForNativeQueueStateSync = () => wait('queue');
    const findTrackIndexFromPlaybackInfo = () => -1, shouldIgnoreNativePlaybackInfo = () => true;
    const loadAndPlay = async selected => { loads.push(selected.id); isPlaying.value = true; };
    ${productionFunction('resetPlaybackRuntimeStateForRestore')}
    ${productionFunction('applyNativePlaybackInfo')}
    ${productionFunction('advanceNativePlayback')}
    const controller = createPlaybackSessionController({
      currentTrack, duration, isPlaying, isLoading, resetPlaybackRuntimeStateForRestore,
      clearCrossfadeTimer() {}, hydratePlaybackTrack: value => value,
      setRestoredPlaybackPending: value => { restoredPlaybackPending = value },
      setRestoredPlaybackPosition() {}, setPendingLoadStartTime() {}, setAutoAdvanceInFlight() {},
      setAdvancingFromEndedTrackId() {}, setCurrentTimeImmediate() {}, loadLyricsForTrack() {}
    });
    return { advanceNativePlayback, controller, visualizationStarts: () => visualizationStarts };
  `
  )(
    { currentTrack, isPlaying, isLoading, queueIndex, duration },
    createPlaybackSessionController,
    windowStub,
    loads,
    track,
    wait
  )
  return { ...harness, loads, started, release, currentTrack, isPlaying, isLoading, track }
}
