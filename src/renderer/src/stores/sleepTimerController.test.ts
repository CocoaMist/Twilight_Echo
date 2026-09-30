import assert from 'node:assert/strict'
import test from 'node:test'
import type { SleepTimerState } from '../../../shared/sleepTimer.ts'
import type { PlaybackSession } from '../types/music.ts'
import { PlaybackSessionWriter } from '../app/playbackSessionWriter.ts'
import { createSleepTimerController, getRestorableSleepTimerState } from './sleepTimerController.ts'

function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

function raceFixture() {
  let state: SleepTimerState | null = null
  const configurations: ReturnType<typeof pending<SleepTimerState | null>>[] = []
  const boundary = pending<SleepTimerState | null>()
  let triggers = 0
  const controller = createSleepTimerController({
    bridge: {
      configure: () => {
        const next = pending<SleepTimerState | null>()
        configurations.push(next)
        return next.promise
      },
      cancel: async () => null,
      boundary: () => boundary.promise
    },
    getSettings: () => ({ defaultMinutes: 30, fadeSeconds: 0 }),
    getState: () => state,
    setState: (next) => {
      state = next
    },
    persistSession: () => {},
    setNotice: () => {},
    onTriggered: () => {
      triggers++
    },
    now: () => 1000
  })
  return { controller, configurations, boundary, state: () => state, triggers: () => triggers }
}

test('late configure replies cannot resurrect a cancelled timer or replace a newer configuration', async () => {
  const f = raceFixture()
  f.controller.configure('minutes', 5)
  const old = f.state()
  f.controller.cancel()
  f.configurations[0].resolve(old)
  await Promise.resolve()
  assert.equal(f.state(), null)
  f.controller.configure('minutes', 10)
  const first = f.state()
  f.controller.configure('queueEnd')
  const latest = f.state()
  f.configurations[2].resolve(latest)
  await Promise.resolve()
  f.configurations[1].resolve(first)
  await Promise.resolve()
  assert.equal(f.state(), latest)
})

test('cancel and dispose fence pending boundary results and later trigger callbacks', async () => {
  for (const dispose of [false, true]) {
    const f = raceFixture()
    f.controller.configure('trackEnd')
    const triggered = { ...f.state()!, active: false, triggered: true }
    const request = f.controller.reportBoundary('trackEnd')
    if (dispose) f.controller.dispose()
    else f.controller.cancel()
    const expected = f.state()
    f.boundary.resolve(triggered)
    assert.equal(await request, false)
    assert.equal(f.state(), expected)
    if (dispose) {
      f.controller.applyTrigger(triggered)
      f.controller.configure('minutes')
      assert.equal(f.triggers(), 0)
      assert.equal(f.state(), expected)
    }
  }
})

test('a trigger event arriving before its boundary reply still suppresses EOF advancement', async () => {
  const f = raceFixture()
  f.controller.configure('trackEnd')
  const triggered = { ...f.state()!, active: false, triggered: true }
  const request = f.controller.reportBoundary('trackEnd')
  f.controller.applyTrigger(triggered)
  f.controller.applyAuthoritativeState(triggered)
  f.boundary.resolve(triggered)
  assert.equal(await request, true)
  assert.equal(f.state(), triggered)
  assert.equal(f.triggers(), 1)
})

test('configuring and cancelling a timer immediately persists the session', async () => {
  let state: SleepTimerState | null = null
  let persisted = 0
  const configured: SleepTimerState[] = []
  let cancelled = 0
  const controller = createSleepTimerController({
    bridge: {
      configure: async (next) => {
        configured.push(next)
        return next
      },
      cancel: async () => {
        cancelled++
        return null
      },
      boundary: async () => null
    },
    getSettings: () => ({ defaultMinutes: 37, fadeSeconds: 4 }),
    getState: () => state,
    setState: (next) => {
      state = next
    },
    persistSession: () => {
      persisted++
    },
    setNotice: () => {},
    onTriggered: () => {},
    now: () => 1_000
  })

  controller.configure('minutes')
  await Promise.resolve()
  assert.equal(configured[0]?.endsAt, 2_221_000)
  assert.equal(persisted, 1)
  controller.cancel()
  await Promise.resolve()
  assert.equal(state, null)
  assert.equal(cancelled, 1)
  assert.equal(persisted, 2)
})

test('configure and cancel enqueue immediate writes through the playback session writer', async () => {
  let state: SleepTimerState | null = null
  const savedTimers: Array<SleepTimerState | undefined> = []
  let revision = 0
  const writer = new PlaybackSessionWriter()
  const session = (): PlaybackSession => ({
    version: 1,
    savedAt: new Date(0).toISOString(),
    mode: 'track',
    position: 0,
    track: {
      id: 'sleep-timer-test',
      title: 'Timer',
      artist: '',
      album: '',
      filePath: '',
      fileName: '',
      duration: 0,
      size: 0,
      cover: null,
      lyrics: null
    },
    ...(state ? { sleepTimer: state } : {})
  })
  const api = {
    savePlaybackSession: async (next: PlaybackSession, _expectedRevision: number) => {
      savedTimers.push(next.sleepTimer)
      revision++
      return { version: 2 as const, revision, savedAt: new Date(0).toISOString(), data: next }
    },
    clearPlaybackSession: async (_expectedRevision: number) => {
      revision++
      return { version: 2 as const, revision, savedAt: new Date(0).toISOString(), data: null }
    }
  }
  const controller = createSleepTimerController({
    bridge: null,
    getSettings: () => ({ defaultMinutes: 15, fadeSeconds: 0 }),
    getState: () => state,
    setState: (next) => {
      state = next
    },
    persistSession: () => {
      if (state) writer.save(api, session())
      else writer.clear(api)
    },
    setNotice: () => {},
    onTriggered: () => {},
    now: () => 1_000
  })

  controller.configure('minutes')
  controller.cancel()
  await writer.whenIdle()
  assert.equal(savedTimers.length, 1)
  assert.equal(savedTimers[0]?.active, true)
  assert.equal(writer.getCommittedSequence(), 2)
})

test('a main-process trigger immediately persists a session without the terminal timer', async () => {
  const active: SleepTimerState = {
    mode: 'trackEnd',
    endsAt: null,
    fadeSeconds: 0,
    active: true,
    triggered: false
  }
  const triggered: SleepTimerState = { ...active, active: false, triggered: true }
  let state: SleepTimerState | null = active
  const snapshots: PlaybackSession[] = []
  let revision = 0
  const writer = new PlaybackSessionWriter()
  const session = (): PlaybackSession => ({
    version: 1,
    savedAt: new Date(0).toISOString(),
    mode: 'track',
    position: 0,
    track: {
      id: 'sleep-trigger',
      title: 'Sleep trigger',
      artist: '',
      album: '',
      filePath: '',
      fileName: '',
      duration: 0,
      size: 0,
      cover: null,
      lyrics: null
    },
    ...(state?.active ? { sleepTimer: state } : {})
  })
  const api = {
    savePlaybackSession: async (next: PlaybackSession, _expectedRevision: number) => {
      snapshots.push(next)
      revision++
      return { version: 2 as const, revision, savedAt: new Date(0).toISOString(), data: next }
    },
    clearPlaybackSession: async (_expectedRevision: number) => {
      revision++
      return { version: 2 as const, revision, savedAt: new Date(0).toISOString(), data: null }
    }
  }
  const controller = createSleepTimerController({
    bridge: null,
    getSettings: () => ({ defaultMinutes: 30, fadeSeconds: 0 }),
    getState: () => state,
    setState: (next) => {
      state = next
    },
    persistSession: () => {
      writer.save(api, session())
    },
    setNotice: () => {},
    onTriggered: () => {}
  })

  controller.applyTrigger(triggered)
  await writer.whenIdle()

  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].sleepTimer, undefined)
  assert.equal(writer.getCommittedSequence(), 1)
})

test('session restore accepts only an active, valid serialized timer state', () => {
  const active: SleepTimerState = {
    mode: 'queueEnd',
    endsAt: null,
    fadeSeconds: 5,
    active: true,
    triggered: false
  }
  assert.equal(getRestorableSleepTimerState(active, 1_000), active)
  assert.equal(getRestorableSleepTimerState({ ...active, fadeSeconds: 999 }), null)
  assert.equal(getRestorableSleepTimerState({ ...active, active: false }), null)
  assert.equal(getRestorableSleepTimerState({ ...active, active: true, triggered: true }), null)
  assert.equal(
    getRestorableSleepTimerState(
      { mode: 'minutes', endsAt: 1_000, fadeSeconds: 5, active: true, triggered: false },
      1_000
    ),
    null
  )
})

test('renderer only fades on the distinct main-process trigger event', async () => {
  const active: SleepTimerState = {
    mode: 'trackEnd',
    endsAt: null,
    fadeSeconds: 2,
    active: true,
    triggered: false
  }
  const triggered = { ...active, active: false, triggered: true }
  let state: SleepTimerState | null = active
  let fadeCalls = 0
  const controller = createSleepTimerController({
    bridge: {
      configure: async (next) => next,
      cancel: async () => null,
      boundary: async () => triggered
    },
    getSettings: () => ({ defaultMinutes: 30, fadeSeconds: 2 }),
    getState: () => state,
    setState: (next) => {
      state = next
    },
    persistSession: () => {},
    setNotice: () => {},
    onTriggered: () => {
      fadeCalls++
    }
  })

  assert.equal(await controller.reportBoundary('trackEnd'), true)
  assert.equal(fadeCalls, 0)
  controller.applyTrigger(triggered)
  assert.equal(fadeCalls, 1)
  assert.equal(state?.triggered, true)
})
