import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import type { SleepTimerState } from '../../../../shared/sleepTimer.ts'
import { createPlayerSleepTimer } from './usePlayerSleepTimer.ts'

function fixture() {
  const state = ref<SleepTimerState | null>(null)
  let resolve!: (value: SleepTimerState | null) => void
  let reject!: (error: Error) => void
  const request = new Promise<SleepTimerState | null>((yes, no) => {
    resolve = yes
    reject = no
  })
  const states = new Set<(state: SleepTimerState | null) => void>()
  const triggers = new Set<(state: SleepTimerState) => void>()
  let reads = 0
  let stops = 0
  const player = createPlayerSleepTimer({
    volume: ref(1),
    muted: ref(false),
    isPlaying: ref(true),
    isLoading: ref(false),
    state,
    notice: ref(null),
    getSettings: () => ({ defaultMinutes: 30, fadeSeconds: 0 }),
    getBridge: () => ({
      configure: async (next) => next,
      cancel: async () => null,
      boundary: async () => null,
      getState: () => {
        reads++
        return request
      },
      onState: (callback) => {
        states.add(callback)
        return () => {
          states.delete(callback)
        }
      },
      onTrigger: (callback) => {
        triggers.add(callback)
        return () => {
          triggers.delete(callback)
        }
      }
    }),
    persistSession: () => {},
    clearCrossfade: () => {},
    stopVisualization: () => {},
    stopRendererAudio: () => {
      stops++
    },
    stopNativeAudio: async () => {}
  })
  const active: SleepTimerState = {
    mode: 'trackEnd',
    endsAt: null,
    fadeSeconds: 0,
    active: true,
    triggered: false
  }
  return {
    player,
    state,
    states,
    triggers,
    active,
    resolve,
    reject,
    reads: () => reads,
    stops: () => stops
  }
}

test('sleep runtime owns exactly one pair of subscriptions and disposal rejects late startup state', async () => {
  const f = fixture()
  f.player.start()
  f.player.start()
  assert.equal(f.reads(), 1)
  assert.equal(f.states.size, 1)
  assert.equal(f.triggers.size, 1)
  const staleTrigger = [...f.triggers][0]
  f.player.dispose()
  f.player.dispose()
  f.resolve(f.active)
  await Promise.resolve()
  staleTrigger({ ...f.active, active: false, triggered: true })
  f.player.configure('minutes')
  f.player.start()
  assert.equal(f.state.value, null)
  assert.equal(f.states.size, 0)
  assert.equal(f.triggers.size, 0)
  assert.equal(f.stops(), 0)
})

test('a newer status or user cancel supersedes a slow initial snapshot', async () => {
  for (const cancel of [false, true]) {
    const f = fixture()
    f.player.start()
    if (cancel) f.player.cancel()
    else for (const listener of f.states) listener(null)
    f.resolve(f.active)
    await Promise.resolve()
    assert.equal(f.state.value, null)
    f.player.dispose()
  }
})

test('startup mirrors active state, only trigger events stop playback, and read failures are tolerated', async () => {
  const f = fixture()
  f.player.start()
  f.resolve(f.active)
  await Promise.resolve()
  assert.deepEqual(f.state.value, f.active)
  const terminal = { ...f.active, active: false, triggered: true }
  for (const listener of f.states) listener(terminal)
  assert.equal(f.stops(), 0)
  for (const listener of f.triggers) listener(terminal)
  assert.equal(f.stops(), 1)
  f.player.dispose()
  const failed = fixture()
  failed.player.start()
  failed.reject(new Error('IPC unavailable'))
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(failed.state.value, null)
  failed.player.dispose()
})
