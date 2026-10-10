import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import { createAudioOutputState } from './audioOutputState.ts'
import type { AudioProcessingSettings, PlaybackInfo } from '../../../../shared/audioEngineTypes.ts'
import { DEFAULT_DSP_OUTPUT_STAGE, DEFAULT_DSP_STEREO_IMAGE } from '../../../../shared/dspGraph.ts'

test('output-state initialization pulls AutoMix status even when ready events already fired', async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const processing = {} as AudioProcessingSettings
  let playbackReads = 0
  let permission = true
  const received: PlaybackInfo[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        audioEngine: {
          // No onReady/onServiceReady callbacks exist: initialization happened earlier.
          getAudioOutputState: async () => ({
            output: 'wasapi',
            device: 'auto',
            exclusiveMode: false,
            outputOptions: [],
            deviceOptions: []
          }),
          getAudioProcessing: async () => processing,
          getDspSceneState: async () => null,
          getPlaybackInfo: async () => {
            ++playbackReads
            return {
              autoMix: { enabled: false, state: 'disabled', experimentalAllowed: permission }
            }
          }
        }
      }
    }
  })
  const ready = ref(false)
  const state = createAudioOutputState({
    audioProcessing: ref(processing),
    dspOutputStage: ref({ ...DEFAULT_DSP_OUTPUT_STAGE }),
    dspStereoImage: ref({ ...DEFAULT_DSP_STEREO_IMAGE }),
    audioEngineReady: ready,
    setAudioEngineError: () => {},
    applyPlaybackSettingsStatus: (info) => received.push(info)
  })
  await state.refreshAudioOutputState()
  assert.equal(playbackReads, 1)
  assert.equal(ready.value, true)
  assert.equal(received.at(-1)?.autoMix?.experimentalAllowed, true)
  permission = false
  await state.refreshAudioOutputState()
  assert.equal(playbackReads, 2)
  assert.equal(received.at(-1)?.autoMix?.experimentalAllowed, false)
})
