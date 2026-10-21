import assert from 'node:assert/strict'
import test from 'node:test'
import { createSleepTimerState } from '../shared/sleepTimer.ts'
import { SleepTimerService } from './sleepTimerCore.ts'

test('native boundaries before arm or rearm are ignored, while current and legacy reports still trigger once', () => {
  let now = 2000
  const timer = new SleepTimerService({ now: () => now })
  const arm = (mode: 'trackEnd' | 'queueEnd') =>
    timer.configure(createSleepTimerState(mode, now, { defaultMinutes: 1, fadeSeconds: 0 }))
  arm('trackEnd')
  for (const timestamp of [1999, NaN, Infinity, 2000.5])
    assert.equal(timer.boundary('trackEnd', timestamp)?.active, true)
  assert.equal(timer.boundary('trackEnd', 2000)?.triggered, true)
  now = 4000
  arm('queueEnd')
  assert.equal(timer.boundary('queueEnd', 3000)?.active, true)
  assert.equal(timer.boundary('trackEnd', 4000)?.active, true)
  assert.equal(timer.boundary('queueEnd', 4000)?.triggered, true)
  assert.equal(timer.getTriggerRevision(), 2)
  now = 5000
  arm('trackEnd')
  assert.equal(timer.boundary('trackEnd')?.triggered, true)
})

test('main sleep timer is the only trigger authority for elapsed and boundary modes', () => {
  let now = 1_000
  const scheduler = { tick: null as (() => void) | null }
  const publications: Array<{ kind: string; triggered: boolean | null }> = []
  const timer = new SleepTimerService({
    now: () => now,
    setInterval: (callback) => {
      scheduler.tick = callback
      return {} as NodeJS.Timeout
    },
    clearInterval: () => {},
    publish: (kind, state) => publications.push({ kind, triggered: state?.triggered ?? null })
  })

  timer.configure(createSleepTimerState('minutes', now, { defaultMinutes: 1, fadeSeconds: 0 }, 1))
  assert.ok(scheduler.tick)
  now += 59_999
  scheduler.tick?.()
  assert.equal(timer.snapshot()?.triggered, false)
  now += 1
  scheduler.tick?.()
  assert.equal(timer.snapshot()?.triggered, true)
  assert.equal(publications.filter((entry) => entry.kind === 'trigger').length, 1)
  assert.equal(timer.getTriggerRevision(), 1)

  timer.configure(createSleepTimerState('queueEnd', now, { defaultMinutes: 1, fadeSeconds: 0 }))
  assert.equal(timer.boundary('trackEnd')?.triggered, false)
  assert.equal(timer.boundary('queueEnd')?.triggered, true)
  assert.equal(timer.getTriggerRevision(), 2)
  timer.boundary('queueEnd')
  assert.equal(timer.getTriggerRevision(), 2)
  timer.cancel()
  assert.equal(timer.getTriggerRevision(), 2)
})

test('main sleep timer rejects malformed configuration before it can schedule work', () => {
  const timer = new SleepTimerService({ publish: () => {}, now: () => 1_000 })
  assert.throws(
    () =>
      timer.configure({
        mode: 'minutes',
        endsAt: null,
        fadeSeconds: 1,
        active: true,
        triggered: false
      }),
    /Invalid sleep timer state/
  )
  assert.throws(
    () =>
      timer.configure({
        mode: 'minutes',
        endsAt: 2_000,
        fadeSeconds: 1,
        active: true,
        triggered: true
      }),
    /Invalid sleep timer state/
  )
  assert.throws(
    () =>
      timer.configure({
        mode: 'minutes',
        endsAt: 1_000,
        fadeSeconds: 1,
        active: true,
        triggered: false
      }),
    /Invalid sleep timer state/
  )
})

test('an unloaded renderer transfers shutdown execution exclusively, while main still owns trigger decisions', () => {
  const publications: string[] = [],
    updates: Array<boolean | null> = []
  const service = new SleepTimerService({
    now: () => 1_000,
    publish: (kind) => publications.push(kind)
  })
  let triggers = 0
  const owner = {
    trigger: () => {
      triggers++
    },
    update: (state: ReturnType<SleepTimerService['snapshot']>) =>
      updates.push(state?.triggered ?? null)
  }
  const release = service.claimShutdown(owner)
  assert.throws(() => service.claimShutdown(owner), /already has an owner/)
  service.configure(createSleepTimerState('trackEnd', 1_000, { defaultMinutes: 1, fadeSeconds: 2 }))
  service.boundary('trackEnd')
  service.boundary('trackEnd')
  assert.equal(triggers, 1)
  assert.equal(service.getTriggerRevision(), 1)
  assert.equal(publications.includes('trigger'), false, 'the live renderer must not fade too')
  assert.deepEqual(updates, [null, false, true])
  service.cancel()
  assert.equal(updates.at(-1), null)
  release()
  const releaseSecond = service.claimShutdown(owner)
  release()
  service.configure(createSleepTimerState('queueEnd', 1_000, { defaultMinutes: 1, fadeSeconds: 0 }))
  service.boundary('queueEnd')
  assert.equal(triggers, 2, 'an old release cannot revoke a newer owner')
  releaseSecond()
  service.configure(createSleepTimerState('trackEnd', 1_000, { defaultMinutes: 1, fadeSeconds: 0 }))
  service.boundary('trackEnd')
  assert.equal(publications.filter((kind) => kind === 'trigger').length, 1)
})

test('explicit transfer acknowledges one fired identity and never re-arms terminal or stale configurations', () => {
  const service = new SleepTimerService({ now: () => 1_000 })
  const armed = createSleepTimerState('trackEnd', 1_000, { defaultMinutes: 1, fadeSeconds: 10 })
  service.configure(armed)
  const terminal = service.boundary('trackEnd')!
  assert.equal(terminal.triggerRevision, 1)
  assert.equal(terminal.shutdownOwner, undefined)
  assert.equal(service.transferShutdown(1), false, 'a trigger claim is required first')
  let triggers = 0
  const release = service.claimShutdown({
    trigger: () => {
      triggers++
    },
    update: () => {}
  })
  assert.equal(service.snapshot()?.shutdownOwner, undefined, 'claiming does not infer execution')
  assert.equal(service.transferShutdown(1), true)
  assert.equal(service.snapshot()?.shutdownOwner, 'main')
  assert.equal(service.transferShutdown(1), true, 'acknowledgement is idempotent')
  assert.equal(triggers, 0, 'transfer does not issue another trigger')
  service.configure(armed)
  assert.equal(service.transferShutdown(1), false)
  const newer = service.boundary('trackEnd')!
  assert.equal(newer.triggerRevision, 2)
  assert.equal(newer.shutdownOwner, 'main')
  assert.equal(triggers, 1)
  assert.equal(service.transferShutdown(1), false)
  service.cancel()
  assert.equal(service.transferShutdown(2), false)
  release()
})
