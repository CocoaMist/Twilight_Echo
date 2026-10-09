import assert from 'node:assert/strict'
import test from 'node:test'
import { createRendererPauseFadeController } from './rendererPauseFadeController.ts'

function fixture() {
  let time = 0
  let volume = 0.6
  let tick: (() => void) | null = null
  let pauses = 0
  const audio = {
    src: 'track-a.flac',
    volume,
    paused: false,
    ended: false,
    pause() {
      pauses++
      this.paused = true
    }
  }
  const controller = createRendererPauseFadeController({
    getVolume: () => volume,
    now: () => time,
    setInterval: ((callback: () => void) => {
      tick = callback
      return {} as ReturnType<typeof setInterval>
    }) as typeof setInterval,
    clearInterval: () => {
      tick = null
    }
  })
  return {
    controller,
    audio: audio as unknown as HTMLAudioElement,
    pauses: () => pauses,
    advance(ms: number) {
      time += ms
      tick?.()
    },
    setVolume(value: number) {
      volume = value
      controller.syncVolume()
    }
  }
}

test('pause fades to silence before pausing and restores the configured volume', () => {
  const state = fixture()
  state.controller.begin(state.audio)
  state.advance(100)
  assert.equal(state.audio.volume, 0.3)
  assert.equal(state.pauses(), 0)
  state.advance(100)
  assert.equal(state.pauses(), 1)
  assert.equal(state.audio.volume, 0.6)
  assert.equal(state.controller.isActive(), false)
  state.advance(500)
  assert.equal(state.pauses(), 1)
})

test('resuming during the fade cancels the delayed pause', () => {
  const state = fixture()
  state.controller.begin(state.audio)
  state.advance(80)
  state.controller.cancel()
  state.advance(500)
  assert.equal(state.audio.volume, 0.6)
  assert.equal(state.audio.paused, false)
  assert.equal(state.pauses(), 0)
})

test('changing volume during the fade preserves the latest level for resume', () => {
  const state = fixture()
  state.controller.begin(state.audio)
  state.advance(100)
  state.setVolume(0.4)
  assert.equal(state.audio.volume, 0.2)
  state.advance(100)
  assert.equal(state.audio.volume, 0.4)
})

test('replacing or ending a track cancels the old pause and releases its timer', () => {
  for (const change of ['source', 'ended', 'paused'] as const) {
    const state = fixture()
    state.controller.begin(state.audio)
    if (change === 'source') state.audio.src = 'track-b.flac'
    else if (change === 'ended') Object.defineProperty(state.audio, 'ended', { value: true })
    else Object.defineProperty(state.audio, 'paused', { value: true })
    state.advance(300)
    assert.equal(state.pauses(), 0)
    assert.equal(state.controller.isActive(), false)
    assert.equal(state.audio.volume, 0.6)
  }
})

test('muted playback pauses immediately', () => {
  const state = fixture()
  state.setVolume(0)
  state.controller.begin(state.audio)
  assert.equal(state.pauses(), 1)
  assert.equal(state.controller.isActive(), false)
})
