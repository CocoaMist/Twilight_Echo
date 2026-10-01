import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef, ref } from 'vue'
import type { Track } from '../../types/music'
import { createCastController } from './castController.ts'

function fixture(resolvePlayTarget: (track: Track) => Promise<string>) {
  const currentTrack = shallowRef<Track | null>({
    id: 'local:one',
    title: 'Song',
    artist: 'Artist',
    filePath: 'D:\\Music\\one.flac'
  } as Track)
  const castTargetName = ref<string | null>(null)
  const castTargetUsn = ref<string | null>(null)
  const requests: Parameters<typeof window.api.remote.castToDevice>[0][] = []
  const starts: Track[] = []
  let remote: typeof window.api.remote | undefined = {
    castToDevice: async (request) => {
      requests.push(request)
      return { usn: request.usn, friendlyName: 'Living room' }
    },
    stopCast: async () => true,
    getCastTarget: async () => null
  } as unknown as typeof window.api.remote
  const controller = createCastController({
    currentTrack,
    castTargetName,
    castTargetUsn,
    currentTime: ref(30),
    getRemoteApi: () => remote,
    resolvePlayTarget,
    isCurrentTrackLiveStream: () => currentTrack.value?.source === 'radio',
    recordPlaybackStart: (track) => starts.push(track)
  })
  return {
    ...controller,
    currentTrack,
    castTargetName,
    castTargetUsn,
    requests,
    starts,
    disconnect: () => {
      remote = undefined
    }
  }
}

test('casting uses a resolved local cache or provider grant and remembers the destination', async () => {
  for (const target of [
    'D:\\Cache\\one.flac',
    'https://audio.invalid/one',
    'twilight-media://grant/one'
  ]) {
    const state = fixture(async () => target)
    await state.castCurrentTrackToDevice('device:one')
    const request = state.requests[0]
    assert.equal(request.filePath ?? request.mediaUrl, target)
    assert.equal(request.positionSeconds, 30)
    assert.equal(state.castTargetUsn.value, 'device:one')
    assert.equal(state.castTargetName.value, 'Living room')
    assert.equal(state.starts[0], state.currentTrack.value)
    await state.stopCastSession()
    assert.equal(state.castTargetUsn.value, null)
    assert.equal(state.castTargetName.value, null)
  }
})

test('failed target resolution falls back to the track stream and live radio starts at zero', async () => {
  const state = fixture(async () => {
    throw new Error('provider offline')
  })
  state.currentTrack.value = {
    ...state.currentTrack.value!,
    source: 'radio',
    streamUrl: 'https://radio.invalid/live'
  }
  await state.castCurrentTrackToDevice('device:radio')
  assert.equal(state.requests[0].mediaUrl, 'https://radio.invalid/live')
  assert.equal(state.requests[0].positionSeconds, 0)
  await state.refreshCastTarget()
  assert.equal(state.castTargetName.value, null)
})

test('unsupported target or unavailable remote API reports failure before recording a playback', async () => {
  const state = fixture(async () => 'unsupported://one')
  state.currentTrack.value = { ...state.currentTrack.value!, filePath: 'unsupported://one' }
  await assert.rejects(state.castCurrentTrackToDevice('device:one'), /不支持投送/)
  assert.deepEqual(state.requests, [])
  assert.deepEqual(state.starts, [])
  state.disconnect()
  await assert.rejects(state.castCurrentTrackToDevice('device:one'), /API 不可用/)
  assert.deepEqual(await state.discoverCastDevices(), [])
})
