import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreSleepTimer } from './sleepService.ts'
import { createSleepTimerState } from '../../shared/sleepTimer.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const signal = () => new AbortController().signal
function fixture(t: test.TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 1_000 })
  const gains: number[] = [],
    persisted: unknown[] = [],
    errors: unknown[] = []
  const info = { state: 'playing', volume: 0.7 }
  let stops = 0,
    previews = 0,
    resumes = 0,
    changes = 0
  const settings = { defaultMinutes: 1, fadeSeconds: 10 }
  const options = {
    settings: () => settings,
    now: Date.now,
    timers: { setInterval, clearInterval, setTimeout, clearTimeout },
    playback: {
      read: () => info,
      quiesce: async () => {
        previews++
      },
      setGain: async (gain: number) => {
        gains.push(gain)
      },
      stop: async (current: () => boolean) => {
        if (current()) {
          stops++
          info.state = 'stopped'
        }
      },
      resumeMaintenance: () => {
        resumes++
      },
      persist: async () => {
        persisted.push(timer.persisted())
      }
    },
    changed: () => {
      changes++
    },
    failed: (error: unknown) => {
      errors.push(error)
    }
  }
  const timer = new CoreSleepTimer(options)
  return {
    timer,
    options,
    info,
    settings,
    gains,
    persisted,
    errors,
    stops: () => stops,
    previews: () => previews,
    resumes: () => resumes,
    changes: () => changes,
    advance: async (ms: number) => {
      t.mock.timers.tick(ms)
      await tick()
    }
  }
}

test('Core creates deadlines from settings and fences concurrent sleep edits', async (t) => {
  const f = fixture(t)
  f.timer.activate()
  await f.timer.configure({ revision: 0, mode: 'minutes', minutes: 2 }, signal())
  assert.equal(f.timer.state().timer?.endsAt, 121_000)
  assert.equal(f.timer.state().timer?.fadeSeconds, 10)
  assert.equal(f.persisted.length, 1)
  await assert.rejects(f.timer.cancel(0, signal()), { code: 'STALE_REVISION' })
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(f.timer.cancel(f.timer.state().revision, cancelled.signal))
  assert.equal(f.timer.state().timer?.active, true)
  await f.timer.cancel(f.timer.state().revision, signal())
  assert.equal(f.timer.state().timer, null)
  await f.advance(180_000)
  assert.equal(f.stops(), 0)
  assert.deepEqual(f.gains, [])
  await f.timer.shutdown()
})

test('a client-free clock triggers one fade, keeps logical volume and never persists a fired timer', async (t) => {
  const f = fixture(t)
  f.timer.activate()
  await f.timer.configure({ revision: 0, mode: 'minutes' }, signal())
  await f.advance(60_000)
  assert.equal(f.timer.state().timer?.shutdownOwner, 'core')
  assert.equal(f.timer.state().timer?.triggered, true)
  assert.equal(f.previews(), 1)
  assert.equal(f.timer.persisted(), undefined)
  await f.advance(5_000)
  assert.equal(f.gains.at(-1), 0.5)
  assert.equal(f.info.volume, 0.7)
  await f.advance(5_000)
  assert.equal(f.stops(), 1)
  assert.deepEqual(f.gains, [1, 0.5, 0, 1])
  await f.advance(10_000)
  assert.equal(f.stops(), 1)
  await f.timer.shutdown()
})

test('native boundary time scopes track/queue timers and a new transport cancels only a fired fade', async (t) => {
  const f = fixture(t)
  f.timer.activate()
  await f.timer.configure({ revision: 0, mode: 'trackEnd' }, signal())
  await f.timer.interrupt()
  assert.equal(f.timer.state().timer?.active, true)
  f.timer.boundary('trackEnd', 999)
  f.timer.boundary('queueEnd', 1_000)
  assert.equal(f.timer.triggered(), false)
  f.timer.boundary('trackEnd', 1_000)
  await tick()
  await f.advance(5_000)
  assert.equal(f.gains.at(-1), 0.5)
  await f.timer.interrupt()
  assert.equal(f.timer.state().timer, null)
  assert.equal(f.gains.at(-1), 1)
  await f.advance(20_000)
  assert.equal(f.stops(), 0)
  await f.timer.shutdown()
})

test('restored timers wait for migration readiness; expired and fired states never rearm', async (t) => {
  const f = fixture(t)
  const armed = createSleepTimerState('minutes', Date.now(), f.settings)
  f.timer.restore(armed)
  assert.deepEqual(f.timer.persisted(), armed)
  await f.advance(10_000)
  assert.equal(f.changes(), 0)
  f.timer.activate()
  assert.equal(f.timer.state().timer?.endsAt, armed.endsAt)
  await f.timer.shutdown()
  assert.deepEqual(f.timer.persisted(), armed)
  const reopened = new CoreSleepTimer(f.options)
  reopened.restore({
    ...armed,
    active: false,
    triggered: true,
    triggerRevision: 1,
    shutdownOwner: 'core'
  })
  reopened.activate()
  assert.equal(reopened.state().timer, null)
  reopened.restore(armed)
  await f.advance(100_000)
  reopened.activate()
  assert.equal(reopened.state().timer, null)
  await reopened.shutdown()
})

test('quitting during a fade waits for Stop before restoring gain', async (t) => {
  const f = fixture(t)
  f.timer.activate()
  await f.timer.configure({ revision: 0, mode: 'queueEnd' }, signal())
  f.timer.boundary('queueEnd', Date.now())
  await tick()
  await f.advance(5_000)
  await f.timer.shutdown()
  assert.equal(f.stops(), 1)
  assert.equal(f.gains.at(-1), 1)
  assert.equal(f.timer.persisted(), undefined)
})
