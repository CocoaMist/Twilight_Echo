import assert from 'node:assert/strict'
import test from 'node:test'
import { createSleepTimerFadeController } from './sleepTimerFade.ts'

test('sleep fade reaches stop once and restores the user volume afterwards', () => {
  let now = 0
  let callback: (() => void) | null = null
  let volume = 0.8
  let stopCalls = 0
  const fade = createSleepTimerFadeController({
    getVolume: () => volume,
    setVolume: (next) => {
      volume = next
    },
    stop: () => {
      stopCalls++
    },
    now: () => now,
    setInterval: (next) => {
      callback = next
      return {} as ReturnType<typeof setInterval>
    },
    clearInterval: () => {}
  })

  fade.begin({ mode: 'minutes', endsAt: 1, fadeSeconds: 2, active: false, triggered: true })
  now = 1_000
  ;(callback as (() => void) | null)?.()
  assert.equal(volume, 0.4)
  now = 2_000
  ;(callback as (() => void) | null)?.()
  assert.equal(stopCalls, 1)
  assert.equal(volume, 0.8)
  assert.equal(fade.isActive(), false)
})

test('zero-second fades are idempotent until the timer is reset', () => {
  let stopCalls = 0
  const fade = createSleepTimerFadeController({
    getVolume: () => 0.5,
    setVolume: () => {},
    stop: () => {
      stopCalls++
    }
  })
  const terminal = {
    mode: 'queueEnd' as const,
    endsAt: null,
    fadeSeconds: 0,
    active: false,
    triggered: true
  }
  assert.equal(fade.begin(terminal), true)
  assert.equal(fade.begin(terminal), false)
  assert.equal(stopCalls, 1)
  fade.clear()
  assert.equal(fade.begin(terminal), true)
  assert.equal(stopCalls, 2)
})

test('muted or zero volume ends fade immediately without interval', () => {
  let stopCalls = 0
  let intervalCalls = 0
  const fade = createSleepTimerFadeController({
    getVolume: () => 0,
    setVolume: () => {},
    stop: () => {
      stopCalls++
    },
    setInterval: () => {
      intervalCalls++
      return {} as ReturnType<typeof setInterval>
    },
    clearInterval: () => {}
  })
  assert.equal(
    fade.begin({
      mode: 'minutes',
      endsAt: 1,
      fadeSeconds: 10,
      active: false,
      triggered: true
    }),
    true
  )
  assert.equal(stopCalls, 1)
  assert.equal(intervalCalls, 0)
})

function handoffFixture() {
  let now = 1_000
  let volume = 0.8
  let stops = 0
  const callbacks: Array<() => void> = []
  const writes: number[] = []
  const state = {
    mode: 'minutes' as const,
    endsAt: 1_000,
    fadeSeconds: 2,
    active: false,
    triggered: true
  }
  const fade = createSleepTimerFadeController({
    getVolume: () => volume,
    setVolume: (next) => {
      volume = next
      writes.push(next)
    },
    stop: () => {
      stops++
    },
    now: () => now,
    setInterval: (callback) => {
      callbacks.push(callback)
      return {} as ReturnType<typeof setInterval>
    },
    clearInterval: () => {}
  })
  return {
    fade,
    state,
    writes,
    callback: (index = callbacks.length - 1) => callbacks[index],
    volume: () => volume,
    stops: () => stops,
    setVolume: (next: number) => {
      volume = next
    },
    setNow: (next: number) => {
      now = next
    }
  }
}

test('cancellation restores attenuation and revokes an already-queued fade callback', () => {
  const f = handoffFixture()
  f.fade.begin(f.state)
  const stale = f.callback()
  f.setNow(2_000)
  stale()
  assert.equal(f.volume(), 0.4)
  f.fade.clear({ restoreVolume: true })
  assert.equal(f.volume(), 0.8)
  assert.equal(f.fade.isActive(), false)
  f.setNow(4_000)
  const writes = f.writes.length
  stale()
  assert.equal(f.writes.length, writes)
  assert.equal(f.stops(), 0)
})

test('cancelling a fade does not overwrite a newer explicit volume', () => {
  const f = handoffFixture()
  f.fade.begin(f.state)
  f.setNow(2_000)
  f.callback()()
  f.setVolume(0.6)
  f.fade.clear({ restoreVolume: true })
  assert.equal(f.volume(), 0.6)
})

test('a rejected handoff resumes the explicit execution at the original deadline', () => {
  const f = handoffFixture()
  assert.equal(f.fade.prepareHandoff(), null, 'terminal timer state alone is not execution')
  f.fade.begin(f.state)
  f.setNow(2_000)
  const oldCallback = f.callback()
  oldCallback()
  const handoff = f.fade.prepareHandoff()!
  assert.deepEqual(handoff.snapshot, { state: f.state, startedAt: 1_000, volume: 0.8 })
  assert.equal(f.fade.isActive(), true)
  assert.equal(f.fade.prepareHandoff(), null, 'one handoff owns the frozen execution')
  handoff.snapshot.state.fadeSeconds = 120
  f.setNow(2_500)
  oldCallback()
  assert.equal(f.volume(), 0.4, 'a queued callback cannot change frozen output')
  handoff.resume()
  assert.equal(f.volume(), 0.2)
  assert.equal(handoff.isCurrent(), false)
  handoff.accept()
  assert.equal(f.volume(), 0.2, 'late acceptance cannot retire a resumed execution')
  f.setNow(3_000)
  f.callback()()
  assert.equal(f.stops(), 1)
  assert.equal(f.volume(), 0.8)
})

test('accepted handoff releases only the local fade and preserves duplicate-trigger idempotency', () => {
  const f = handoffFixture()
  f.fade.begin(f.state)
  f.setNow(2_000)
  const oldCallback = f.callback()
  oldCallback()
  const handoff = f.fade.prepareHandoff()!
  handoff.accept()
  assert.equal(f.volume(), 0.8)
  assert.equal(f.fade.isActive(), false)
  assert.equal(f.fade.begin(f.state), false)
  handoff.resume()
  handoff.accept()
  f.setNow(5_000)
  oldCallback()
  assert.equal(f.stops(), 0, 'the new owner alone must stop playback')
  f.fade.clear()
  assert.equal(f.fade.begin(f.state), true)
})

test('new configuration revokes both callbacks and acknowledgements from a suspended fade', () => {
  const f = handoffFixture()
  f.fade.begin(f.state)
  f.setNow(2_000)
  const stale = f.callback()
  stale()
  const handoff = f.fade.prepareHandoff()!
  f.fade.clear({ restoreVolume: true })
  f.fade.begin({ ...f.state, fadeSeconds: 10 })
  f.setNow(4_000)
  f.callback()()
  assert.equal(f.volume(), 0.8 * 0.8)
  handoff.accept()
  handoff.resume()
  stale()
  assert.equal(f.volume(), 0.8 * 0.8)
  assert.equal(f.fade.isActive(), true)
  assert.equal(f.stops(), 0)
})

test('rejection after the original deadline stops once instead of starting another fade', () => {
  const f = handoffFixture()
  f.fade.begin(f.state)
  const handoff = f.fade.prepareHandoff()!
  f.setNow(5_000)
  handoff.resume()
  handoff.resume()
  assert.equal(f.stops(), 1)
  assert.equal(f.volume(), 0.8)
  assert.equal(f.fade.isActive(), false)
})
