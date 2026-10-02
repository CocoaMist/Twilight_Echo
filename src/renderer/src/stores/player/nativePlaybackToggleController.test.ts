import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import { createNativePlaybackToggleController } from './nativePlaybackToggleController.ts'

test('failed exclusive resume stays paused after the native error event and can be retried', async () => {
  const isPlaying = ref(false)
  const intents: Array<boolean | null> = []
  const errors: string[] = []
  let busy = true
  let calls = 0
  const controller = createNativePlaybackToggleController({
    isPlaying,
    togglePause: async () => {
      calls++
      if (busy) {
        isPlaying.value = false
        throw new Error('exclusive device busy')
      }
      isPlaying.value = true
    },
    setPlaybackToggleIntent: (playing) => intents.push(playing),
    clearPlaybackToggleIntent: () => intents.push(null),
    setAudioEngineError: (message) => errors.push(message)
  })
  await assert.rejects(controller.togglePause(), /exclusive device busy/)
  assert.equal(isPlaying.value, false)
  assert.equal(calls, 1)
  assert.deepEqual(intents, [true, null])
  assert.deepEqual(errors, ['exclusive device busy'])
  busy = false
  await controller.togglePause()
  assert.equal(isPlaying.value, true)
  assert.equal(calls, 2)
  assert.deepEqual(intents, [true, null, true, true])
})

test('a failed pause restores the state captured before the request', async () => {
  const isPlaying = ref(true)
  const controller = createNativePlaybackToggleController({
    isPlaying,
    togglePause: async () => {
      isPlaying.value = false
      throw new Error('pause failed')
    },
    setPlaybackToggleIntent: () => {},
    clearPlaybackToggleIntent: () => {},
    setAudioEngineError: () => {}
  })
  await assert.rejects(controller.togglePause(), /pause failed/)
  assert.equal(isPlaying.value, true)
})

test('an earlier failed toggle does not roll back a newer confirmed toggle', async () => {
  const isPlaying = ref(false)
  let rejectFirst!: (reason: Error) => void
  let calls = 0
  const intents: Array<boolean | null> = []
  const controller = createNativePlaybackToggleController({
    isPlaying,
    togglePause: () => {
      if (++calls === 1) return new Promise<void>((_resolve, reject) => (rejectFirst = reject))
      isPlaying.value = true
      return Promise.resolve()
    },
    setPlaybackToggleIntent: (playing) => intents.push(playing),
    clearPlaybackToggleIntent: () => intents.push(null),
    setAudioEngineError: () => {}
  })
  const first = controller.togglePause()
  await controller.togglePause()
  rejectFirst(new Error('first request failed'))
  await assert.rejects(first, /first request failed/)
  assert.equal(isPlaying.value, true)
  assert.deepEqual(intents, [true, false, true])
})
