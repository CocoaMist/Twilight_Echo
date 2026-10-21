import assert from 'node:assert/strict'
import test from 'node:test'
import { SleepTimerShutdown } from './sleepTimerShutdown.ts'
import { createSleepTimerState } from '../shared/sleepTimer.ts'

const tick = () => new Promise<void>((done) => setImmediate(done))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture() {
  let now = 1_000,
    stopped = 0,
    quiesced = 0,
    completed = 0
  const info = { state: 'playing', volume: 0.7 }
  const gains: number[] = [],
    errors: unknown[] = [],
    userVolumes: number[] = []
  const timers = new Map<NodeJS.Timeout, () => void>()
  const options = {
    getPlaybackInfo: async () => info,
    setGain: async (gain: number) => {
      gains.push(gain)
    },
    setUserVolume: async (volume: number, current: () => boolean) => {
      if (!current()) return
      userVolumes.push(volume)
      info.volume = volume
    },
    quiesce: async () => {
      quiesced++
    },
    stop: async (current: () => boolean) => {
      if (current()) {
        stopped++
        info.state = 'stopped'
      }
    },
    onStopped: () => {
      completed++
    },
    onError: (error: unknown) => {
      errors.push(error)
    },
    now: () => now,
    setTimeout: (callback: () => void) => {
      const handle = {} as NodeJS.Timeout
      timers.set(handle, callback)
      return handle
    },
    clearTimeout: (timer: NodeJS.Timeout) => {
      timers.delete(timer)
    }
  }
  const shutdown = new SleepTimerShutdown(options)
  return {
    shutdown,
    options,
    info,
    gains,
    errors,
    userVolumes,
    timers,
    stopped: () => stopped,
    quiesced: () => quiesced,
    completed: () => completed,
    state: (fadeSeconds = 10) =>
      createSleepTimerState('minutes', now, { defaultMinutes: 1, fadeSeconds }),
    advance: async (ms: number) => {
      now += ms
      for (const [handle, callback] of [...timers]) {
        timers.delete(handle)
        callback()
      }
      await tick()
    }
  }
}

test('renderer-free shutdown follows wall time, preserves user volume and completes only once', async () => {
  const f = fixture()
  f.shutdown.begin(f.state())
  f.shutdown.begin(f.state())
  await tick()
  assert.equal(f.quiesced(), 1)
  await f.advance(5_000)
  assert.deepEqual(f.gains, [1, 0.5])
  assert.equal(f.info.volume, 0.7)
  assert.equal(f.stopped(), 0)
  await f.advance(5_000)
  assert.deepEqual(f.gains, [1, 0.5, 0, 1])
  assert.equal(f.stopped(), 1)
  assert.equal(f.completed(), 1)
  assert.equal(f.shutdown.isActive(), false)
  assert.equal(f.timers.size, 0)
  await f.shutdown.finish()
  assert.equal(f.stopped(), 1)
})

test('slow gain ACKs keep one in-flight step; cancellation drains it and restores unity without a stop', async () => {
  const f = fixture(),
    held = deferred(),
    entered = deferred()
  f.options.setGain = async (gain) => {
    f.gains.push(gain)
    if (gain === 0.5) {
      entered.resolve()
      await held.promise
    }
  }
  f.shutdown.begin(f.state())
  await tick()
  await f.advance(5_000)
  await entered.promise
  await f.advance(20_000)
  assert.equal(f.timers.size, 0, 'no timer/promise backlog while the ACK is pending')
  let cancelled = false
  const cancelling = f.shutdown.cancel().then(() => {
    cancelled = true
  })
  await tick()
  assert.equal(cancelled, false)
  held.resolve()
  await cancelling
  assert.deepEqual(f.gains, [1, 0.5, 1])
  assert.equal(f.stopped(), 0)
  assert.equal(f.timers.size, 0)
})

test('an older unity ACK cannot suppress cancellation of a newer fade step queued behind it', async () => {
  const f = fixture()
  f.shutdown.begin(f.state())
  await tick()
  await f.advance(5_000)
  const reset = deferred(),
    ready = deferred(),
    low = deferred(),
    entered = deferred()
  let resets = 0
  f.options.setGain = async (gain) => {
    f.gains.push(gain)
    if (gain === 1 && ++resets === 1) await reset.promise
    if (gain === 0.5) {
      entered.resolve()
      await low.promise
    }
  }
  const firstCancel = f.shutdown.cancel()
  f.options.quiesce = () => ready.promise
  f.shutdown.begin(f.state())
  await f.advance(5_000)
  ready.resolve()
  await tick()
  reset.resolve()
  await firstCancel
  await entered.promise
  const secondCancel = f.shutdown.cancel()
  low.resolve()
  await secondCancel
  assert.deepEqual(f.gains, [1, 0.5, 1, 0.5, 1])
  assert.equal(f.stopped(), 0)
  assert.equal(f.timers.size, 0)
})

test('restoring during attenuation drains the gain ACK then completes shutdown without waiting for the deadline', async () => {
  const f = fixture(),
    held = deferred()
  f.options.setGain = async (gain) => {
    f.gains.push(gain)
    if (gain === 0.5) await held.promise
  }
  f.shutdown.begin(f.state())
  await tick()
  await f.advance(5_000)
  const first = f.shutdown.finish(),
    second = f.shutdown.finish()
  assert.equal(first, second)
  await tick()
  assert.equal(f.stopped(), 0)
  held.resolve()
  await first
  assert.equal(f.stopped(), 1)
  assert.equal(f.completed(), 1)
  assert.deepEqual(f.gains, [1, 0.5, 1])
  assert.equal(f.timers.size, 0)
})

test('cancel does not wait on a queued stop and its guard cannot stop newer playback', async () => {
  const f = fixture(),
    held = deferred(),
    entered = deferred()
  f.options.stop = async (current) => {
    entered.resolve()
    await held.promise
    if (current()) f.info.state = 'stopped'
  }
  f.shutdown.begin(f.state(0))
  await entered.promise
  await f.shutdown.cancel()
  f.info.state = 'playing'
  held.resolve()
  await tick()
  assert.equal(f.info.state, 'playing')
  assert.equal(f.completed(), 0)
  assert.equal(f.shutdown.isActive(), false)
})

test('paused and muted outputs stop immediately rather than waiting through a silent fade', async () => {
  for (const info of [
    { state: 'paused', volume: 0.7 },
    { state: 'playing', volume: 0 }
  ]) {
    const f = fixture()
    Object.assign(f.info, info)
    f.shutdown.begin(f.state())
    await tick()
    assert.equal(f.stopped(), 1)
    assert.deepEqual(f.gains, [])
    assert.equal(f.timers.size, 0)
  }
})

test('a gain failure reports the error and falls back to stop; a failed stop is not retried automatically', async () => {
  const f = fixture()
  f.options.setGain = async (gain) => {
    if (gain < 1) throw new Error('gain ACK lost')
  }
  f.shutdown.begin(f.state())
  await tick()
  await f.advance(5_000)
  assert.equal(f.stopped(), 1)
  assert.equal(f.errors.length, 1)
  assert.equal(f.shutdown.isActive(), false)
  let attempts = 0
  f.info.state = 'playing'
  f.options.stop = async () => {
    attempts++
    throw new Error('stop ACK lost')
  }
  f.shutdown.begin(f.state(0))
  await tick()
  await f.advance(30_000)
  assert.equal(attempts, 1)
  assert.equal(f.errors.length, 2)
  assert.equal(f.timers.size, 0)
  await assert.rejects(f.shutdown.finish(), /stop ACK lost/)
  assert.equal(attempts, 1)
  await f.shutdown.cancel()
})

test('adopting a renderer fade attenuates before restoring its preference and keeps the original deadline', async () => {
  const f = fixture()
  f.info.volume = 0.35
  await f.advance(5_000)
  f.options.setUserVolume = async (volume, current) => {
    assert.equal(f.gains.at(-1), 0.5, 'gain must be ACKed before restoring the preference')
    if (current()) {
      f.userVolumes.push(volume)
      f.info.volume = volume
    }
  }
  await f.shutdown.adopt(f.state(), { triggerRevision: 1, startedAt: 1_000, volume: 0.7 })
  assert.deepEqual(f.userVolumes, [0.7])
  await tick()
  assert.equal(f.gains.at(-1), 0.5)
  await f.advance(5_000)
  assert.equal(f.stopped(), 1, 'handoff must not restart a ten-second fade at its midpoint')
  assert.equal(f.info.volume, 0.7)
  assert.equal(f.gains.at(-1), 1)
})

test('cancellation while handoff gain is pending cannot restore an old preference or stop new playback', async () => {
  const f = fixture(),
    held = deferred(),
    entered = deferred()
  await f.advance(5_000)
  f.options.setGain = async (gain) => {
    f.gains.push(gain)
    if (gain === 0.5) {
      entered.resolve()
      await held.promise
    }
  }
  const adoption = f.shutdown.adopt(f.state(), {
    triggerRevision: 1,
    startedAt: 1_000,
    volume: 0.7
  })
  await entered.promise
  const cancelling = f.shutdown.cancel()
  f.info.volume = 0.6
  held.resolve()
  await Promise.all([adoption, cancelling])
  assert.deepEqual(f.userVolumes, [])
  assert.equal(f.info.volume, 0.6)
  assert.deepEqual(f.gains, [0.5, 1])
  assert.equal(f.stopped(), 0)
})

test('failed handoff preparation reports once and falls back to stop without replaying the preference', async () => {
  const f = fixture()
  f.options.setUserVolume = async () => {
    throw new Error('volume ACK lost')
  }
  await f.shutdown.adopt(f.state(), { triggerRevision: 1, startedAt: 1_000, volume: 0.7 })
  await tick()
  assert.equal(f.stopped(), 1)
  assert.equal(f.errors.length, 1)
  assert.equal(f.timers.size, 0)
  assert.equal(f.shutdown.isActive(), false)
})

test('failed attenuation cannot acknowledge a renderer handoff before fallback stop is confirmed', async () => {
  for (const failedStop of [false, true]) {
    const f = fixture(),
      held = deferred(),
      entered = deferred()
    f.options.setGain = async (gain) => {
      if (gain < 1) throw new Error('gain ACK lost')
    }
    f.options.stop = async () => {
      entered.resolve()
      await held.promise
      if (failedStop) throw new Error('stop ACK lost')
      f.info.state = 'stopped'
    }
    await f.advance(5_000)
    let settled = false
    const adopting = f.shutdown
      .adopt(f.state(), {
        triggerRevision: 1,
        startedAt: 1_000,
        volume: 0.7
      })
      .finally(() => {
        settled = true
      })
    await entered.promise
    await tick()
    assert.equal(settled, false)
    assert.deepEqual(f.userVolumes, [])
    held.resolve()
    if (failedStop) await assert.rejects(adopting, /stop ACK lost/)
    else await adopting
    assert.equal(f.timers.size, 0)
    await f.shutdown.cancel()
  }
})
