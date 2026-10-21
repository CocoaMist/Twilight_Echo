import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import type { SleepTimerState } from '../../../../shared/sleepTimer.ts'
import { createPlayerSleepTimer } from './usePlayerSleepTimer.ts'

function fixture() {
  const state = ref<SleepTimerState | null>(null)
  const volume = ref(1)
  let resolve!: (value: SleepTimerState | null) => void
  let reject!: (error: Error) => void
  const request = new Promise<SleepTimerState | null>((yes, no) => {
    resolve = yes
    reject = no
  })
  let readState = () => request
  const states = new Set<(state: SleepTimerState | null) => void>()
  const triggers = new Set<(state: SleepTimerState) => void>()
  let reads = 0
  let stops = 0
  let cancels = 0
  const player = createPlayerSleepTimer({
    volume,
    muted: ref(false),
    isPlaying: ref(true),
    isLoading: ref(false),
    state,
    notice: ref(null),
    getSettings: () => ({ defaultMinutes: 30, fadeSeconds: 0 }),
    getBridge: () => ({
      configure: async (next) => next,
      cancel: async () => {
        cancels++
        return null
      },
      boundary: async () => null,
      getState: () => {
        reads++
        return readState()
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
    volume,
    state,
    states,
    triggers,
    active,
    resolve,
    reject,
    setReadState: (read: () => Promise<SleepTimerState | null>) => {
      readState = read
    },
    reads: () => reads,
    stops: () => stops,
    cancels: () => cancels
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

test('explicit cancel and reconfigure restore fade volume, while teardown does not write output', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000 })
  for (const action of ['cancel', 'configure', 'dispose'] as const) {
    const f = fixture()
    f.player.start()
    for (const listener of f.triggers)
      listener({ ...f.active, fadeSeconds: 10, active: false, triggered: true })
    t.mock.timers.tick(5_000)
    assert.equal(f.volume.value, 0.5)
    if (action === 'configure') f.player.configure('queueEnd')
    else f.player[action]()
    assert.equal(f.volume.value, action === 'dispose' ? 0.5 : 1)
    t.mock.timers.tick(20_000)
    assert.equal(f.stops(), 0, 'cancelled callbacks must not stop newer playback')
    f.player.dispose()
  }
})

function beginFading(t: test.TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000 })
  const f = fixture()
  f.player.start()
  const terminal = {
    ...f.active,
    fadeSeconds: 10,
    active: false,
    triggered: true,
    triggerRevision: 7
  }
  for (const listener of f.triggers) listener(terminal)
  t.mock.timers.tick(5_000)
  assert.equal(f.volume.value, 0.5)
  return { ...f, terminal }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('the production player freezes its running fade until main acknowledges attenuation', async (t) => {
  const f = beginFading(t),
    accepted = deferred<boolean>()
  const handoff = f.player.handoffForAfterglow(async (payload) => {
    assert.deepEqual(payload, {
      volume: 1,
      sleepShutdown: { triggerRevision: 7, startedAt: 1_000, volume: 1 }
    })
    return accepted.promise
  })
  t.mock.timers.tick(3_000)
  assert.equal(
    f.volume.value,
    0.5,
    'neither queued ticks nor the pending handoff restore full output'
  )
  accepted.resolve(true)
  assert.equal(await handoff, true)
  assert.equal(f.volume.value, 1)
  t.mock.timers.tick(30_000)
  assert.equal(f.stops(), 0)
  f.player.dispose()
})

test('an explicit rejection resumes the production fade at its original deadline', async (t) => {
  const f = beginFading(t),
    accepted = deferred<boolean>()
  const handoff = f.player.handoffForAfterglow(() => accepted.promise)
  t.mock.timers.tick(1_000)
  accepted.resolve(false)
  assert.equal(await handoff, false)
  assert.equal(f.volume.value, 0.4)
  t.mock.timers.tick(4_000)
  assert.equal(f.stops(), 1)
  f.player.dispose()
})

test('lost handoff replies read ownership then wait on the same idempotent gain barrier', async (t) => {
  const f = beginFading(t),
    ready = deferred<boolean>()
  f.setReadState(async () => ({ ...f.terminal, shutdownOwner: 'main' }))
  let calls = 0
  const payloads: unknown[] = []
  const handoff = f.player.handoffForAfterglow(async (payload) => {
    payloads.push(payload)
    if (++calls === 1) throw new Error('invoke reply lost')
    return ready.promise
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls, 2)
  assert.deepEqual(payloads[0], payloads[1])
  assert.equal(f.volume.value, 0.5, 'ownership alone must not restore a preference before gain ACK')
  ready.resolve(true)
  assert.equal(await handoff, true)
  assert.equal(f.volume.value, 1)
  t.mock.timers.tick(30_000)
  assert.equal(f.stops(), 0)
  f.player.dispose()
})

test('unknown handoff ownership stays frozen and a later entry reuses the exact execution', async (t) => {
  const f = beginFading(t)
  f.setReadState(async () => {
    throw new Error('state unavailable')
  })
  let offered: unknown
  await assert.rejects(
    f.player.handoffForAfterglow(async (payload) => {
      offered = payload
      throw new Error('invoke reply lost')
    }),
    /invoke reply lost/
  )
  t.mock.timers.tick(30_000)
  assert.equal(f.stops(), 0)
  assert.equal(f.volume.value, 0.5)
  assert.equal(
    await f.player.handoffForAfterglow(async (payload) => {
      assert.deepEqual(payload, offered)
      return true
    }),
    true
  )
  assert.equal(f.volume.value, 1)
  f.player.dispose()
})

test('cancel or reconfigure during handoff revokes a late acknowledgement without clobbering new volume', async (t) => {
  const f = beginFading(t),
    accepted = deferred<boolean>()
  const handoff = f.player.handoffForAfterglow(() => accepted.promise)
  f.player.cancel()
  f.volume.value = 0.6
  accepted.resolve(true)
  assert.equal(await handoff, true)
  assert.equal(f.volume.value, 0.6)
  t.mock.timers.tick(30_000)
  assert.equal(f.stops(), 0)
  f.player.dispose()
})

test('a known non-acceptance resumes only the same execution, never a cancelled timer', async (t) => {
  const f = beginFading(t)
  f.setReadState(async () => f.terminal)
  await assert.rejects(
    f.player.handoffForAfterglow(async () => {
      throw new Error('not delivered')
    }),
    /not delivered/
  )
  t.mock.timers.tick(1_000)
  assert.equal(f.volume.value, 0.4)
  f.setReadState(async () => null)
  await assert.rejects(
    f.player.handoffForAfterglow(async () => {
      throw new Error('not delivered')
    }),
    /not delivered/
  )
  assert.equal(f.volume.value, 1)
  t.mock.timers.tick(30_000)
  assert.equal(f.stops(), 0)
  f.player.dispose()
})

test('explicit playback interrupts a triggered fade but preserves an armed timer', async (t) => {
  const f = beginFading(t),
    accepted = deferred<boolean>()
  const handoff = f.player.handoffForAfterglow(() => accepted.promise)
  f.player.interruptShutdown()
  assert.equal(f.volume.value, 1)
  assert.equal(f.state.value, null)
  assert.equal(f.cancels(), 1, 'main execution is cancelled too')
  f.volume.value = 0.6
  accepted.resolve(true)
  await handoff
  assert.equal(f.volume.value, 0.6)
  t.mock.timers.tick(30_000)
  assert.equal(f.stops(), 0)
  for (const listener of f.states) listener(f.active)
  f.player.interruptShutdown()
  assert.deepEqual(f.state.value, f.active)
  assert.equal(f.cancels(), 1)
  f.player.dispose()
})
