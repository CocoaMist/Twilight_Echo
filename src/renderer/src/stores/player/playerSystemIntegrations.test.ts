import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTick, shallowRef } from 'vue'
import {
  createPlayerSystemIntegrations,
  type PlayerSystemIntegrationOptions
} from './playerSystemIntegrations.ts'

async function flush(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await Promise.resolve()
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture(overrides: Partial<PlayerSystemIntegrationOptions> = {}) {
  const track = {
    id: 'a',
    queueEntryId: 'first-a',
    title: 'A',
    artist: 'Artist',
    album: 'Album',
    cover: ''
  }
  const currentTrack = shallowRef<typeof track | null>(track)
  const isPlaying = shallowRef(true)
  const currentTime = shallowRef(5)
  const duration = shallowRef(100)
  const playbackRate = shallowRef(1)
  const mediaEnabled = shallowRef(true)
  const discordEnabled = shallowRef(true)
  const actions = new Map<MediaSessionAction, MediaSessionActionHandler>()
  const positions: Array<MediaPositionState | undefined> = []
  const activities: Array<
    Parameters<NonNullable<PlayerSystemIntegrationOptions['discord']>['updateActivity']>[0] | null
  > = []
  const commands: Array<string | number> = []
  let metadataCreates = 0
  let statusReads = 0
  let clock = 1000
  const session: NonNullable<PlayerSystemIntegrationOptions['mediaSession']> = {
    metadata: null,
    playbackState: 'none',
    setActionHandler(action, handler) {
      if (handler) actions.set(action, handler)
      else actions.delete(action)
    },
    setPositionState(state) {
      positions.push(state)
    }
  }
  const options: PlayerSystemIntegrationOptions = {
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    playbackRate,
    mediaEnabled,
    discordEnabled,
    commands: {
      togglePlay: () => {
        commands.push('toggle')
      },
      previous: () => {
        commands.push('previous')
      },
      next: () => {
        commands.push('next')
      },
      seek: (time) => {
        commands.push(time)
      }
    },
    getNativeStatus: async () => {
      statusReads++
      return { active: false }
    },
    mediaSession: session,
    createMetadata: (init) => {
      metadataCreates++
      return init as MediaMetadata
    },
    discord: {
      updateActivity: async (activity) => {
        activities.push(activity)
      },
      clearActivity: async () => {
        activities.push(null)
      }
    },
    now: () => clock,
    ...overrides
  }
  return {
    ...options,
    track,
    actions,
    positions,
    activities,
    commands,
    session,
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    playbackRate,
    mediaEnabled,
    discordEnabled,
    integration: createPlayerSystemIntegrations(options),
    metadataCreates: () => metadataCreates,
    statusReads: () => statusReads,
    setClock: (value: number) => {
      clock = value
    }
  }
}

test('start is idempotent, media keys dispatch commands and positions stay valid', async () => {
  const f = fixture()
  assert.equal(f.statusReads(), 0)
  f.integration.start()
  f.integration.start()
  await flush()
  try {
    assert.equal(f.statusReads(), 1)
    assert.equal(f.actions.size, 7)
    assert.equal(f.session.playbackState, 'playing')
    f.actions.get('play')!({ action: 'play' })
    f.actions.get('pause')!({ action: 'pause' })
    f.actions.get('nexttrack')!({ action: 'nexttrack' })
    f.actions.get('previoustrack')!({ action: 'previoustrack' })
    f.actions.get('seekto')!({ action: 'seekto', seekTime: 40 })
    f.actions.get('seekbackward')!({ action: 'seekbackward' })
    f.actions.get('seekforward')!({ action: 'seekforward' })
    assert.deepEqual(f.commands, ['toggle', 'next', 'previous', 40, 0, 15])
    f.currentTime.value = -5
    f.playbackRate.value = 2
    await flush()
    assert.deepEqual(f.positions.at(-1), { duration: 100, position: 0, playbackRate: 2 })
    f.currentTime.value = 500
    f.playbackRate.value = NaN
    await flush()
    assert.deepEqual(f.positions.at(-1), { duration: 100, position: 100, playbackRate: 1 })
    f.duration.value = Infinity
    await flush()
    assert.equal(f.positions.at(-1), undefined)
  } finally {
    f.integration.dispose()
    await flush()
  }
})

test('native media ownership never binds or clears the browser session', async () => {
  const f = fixture({ getNativeStatus: async () => ({ active: true }) })
  f.integration.start()
  await flush()
  f.currentTime.value = 20
  await flush()
  f.integration.dispose()
  assert.equal(f.actions.size, 0)
  assert.equal(f.metadataCreates(), 0)
  assert.deepEqual(f.positions, [])
})

test('disabled media detaches keys; re-enable restores them; disposal stops all watches', async () => {
  const f = fixture()
  f.integration.start()
  await flush()
  f.mediaEnabled.value = false
  await flush()
  assert.equal(f.actions.size, 0)
  assert.equal(f.session.metadata, null)
  assert.equal(f.session.playbackState, 'none')
  f.mediaEnabled.value = true
  await flush()
  assert.equal(f.actions.size, 7)
  f.integration.dispose()
  f.integration.dispose()
  await flush()
  const count = f.positions.length
  const activityCount = f.activities.length
  f.currentTrack.value = { ...f.track, id: 'b' }
  f.currentTime.value = 60
  f.integration.start()
  await flush()
  assert.equal(f.actions.size, 0)
  assert.equal(f.positions.length, count)
  assert.equal(f.activities.length, activityCount)
})

test('late native status success and failure cannot recreate a disposed integration', async () => {
  for (const failed of [false, true]) {
    const status = deferred<{ active: boolean }>()
    const f = fixture({ getNativeStatus: () => status.promise })
    f.integration.start()
    f.integration.dispose()
    if (failed) status.reject(new Error('unavailable'))
    else status.resolve({ active: false })
    await flush()
    assert.equal(f.actions.size, 0)
    assert.equal(f.metadataCreates(), 0)
    assert.deepEqual(f.positions, [])
  }
})

test('failed native lookup falls back and an unsupported action does not block other keys', async () => {
  const f = fixture({
    getNativeStatus: async () => {
      throw new Error('IPC unavailable')
    }
  })
  const bind = f.session.setActionHandler.bind(f.session)
  f.session.setActionHandler = (action, handler) => {
    if (action === 'seekto') throw new Error('not supported')
    bind(action, handler)
  }
  f.integration.start()
  await flush()
  assert.equal(f.actions.size, 6)
  assert.equal(f.actions.has('nexttrack'), true)
  f.integration.dispose()
  assert.equal(f.actions.size, 0)
})

test('progress does not rebuild metadata or publish Discord; continuous playback updates on track changes', async () => {
  const f = fixture()
  f.integration.start()
  await flush()
  assert.equal(f.activities.length, 1)
  for (let i = 0; i < 100; i++) {
    f.currentTime.value = i
    await flush()
  }
  assert.equal(f.metadataCreates(), 1)
  assert.equal(f.activities.length, 1)
  f.setClock(2000)
  f.currentTrack.value = { ...f.track, id: 'b', title: 'B' }
  await flush()
  assert.equal(f.activities.at(-1)?.title, 'B')
  assert.equal(f.activities.at(-1)?.startTime, 2000)
  assert.equal(f.metadataCreates(), 2)
  f.setClock(3000)
  f.currentTrack.value = { ...f.currentTrack.value!, queueEntryId: 'second-b' }
  await flush()
  assert.equal(f.activities.at(-1)?.startTime, 3000)
  f.currentTrack.value = { ...f.currentTrack.value!, title: 'Corrected B' }
  await flush()
  assert.equal(f.activities.at(-1)?.title, 'Corrected B')
  assert.equal(f.activities.at(-1)?.startTime, 3000)
  f.integration.dispose()
  await flush()
})

test('paused, disabled and empty-track publications clear presence and stale position state', async () => {
  const f = fixture()
  f.integration.start()
  await flush()
  f.isPlaying.value = false
  await flush()
  assert.equal(f.activities.at(-1), null)
  assert.equal(f.session.playbackState, 'paused')
  f.setClock(4000)
  f.isPlaying.value = true
  await flush()
  assert.equal(f.activities.at(-1)?.startTime, 4000)
  f.discordEnabled.value = false
  await flush()
  assert.equal(f.activities.at(-1), null)
  f.currentTrack.value = null
  await flush()
  assert.equal(f.session.metadata, null)
  assert.equal(f.session.playbackState, 'none')
  assert.equal(f.positions.at(-1), undefined)
  f.integration.dispose()
})

test('Discord serializes one in-flight update, coalesces pending changes and clears after failures', async () => {
  const first = deferred<void>()
  const calls: Array<string | null> = []
  let active = 0
  let peak = 0
  const f = fixture({
    discord: {
      updateActivity: async (activity) => {
        calls.push(activity.title)
        peak = Math.max(peak, ++active)
        try {
          if (activity.title === 'A') await first.promise
        } finally {
          active--
        }
      },
      clearActivity: async () => {
        calls.push(null)
      }
    }
  })
  f.integration.start()
  await flush()
  f.currentTrack.value = { ...f.track, id: 'b', title: 'B' }
  await flush()
  f.currentTrack.value = { ...f.track, id: 'c', title: 'C' }
  await flush()
  assert.deepEqual(calls, ['A'])
  first.reject(new Error('connection lost'))
  await flush()
  assert.deepEqual(calls, ['A', 'C'])
  assert.equal(peak, 1)
  f.integration.dispose()
  await flush()
  assert.deepEqual(calls, ['A', 'C', null])
})

test('runtime replacement supersedes the old pending clear and keeps one Discord publisher', async () => {
  const first = deferred<void>()
  const calls: Array<string | null> = []
  const port = {
    updateActivity: async (activity: { title: string }) => {
      calls.push(activity.title)
      if (activity.title === 'A') await first.promise
    },
    clearActivity: async () => {
      calls.push(null)
    }
  }
  const a = fixture({ discord: port })
  a.integration.start()
  await flush()
  a.integration.dispose()
  const b = fixture({ discord: port })
  b.currentTrack.value = { ...b.track, id: 'b', title: 'B' }
  b.integration.start()
  await flush()
  first.resolve()
  await flush()
  assert.deepEqual(calls, ['A', 'B'])
  a.integration.dispose()
  assert.deepEqual(calls, ['A', 'B'])
  b.integration.dispose()
  await flush()
  assert.deepEqual(calls, ['A', 'B', null])
})

test('dispose before start is inert and a slow update is followed by clear, never more updates', async () => {
  const unused = fixture()
  unused.integration.dispose()
  unused.integration.start()
  await flush()
  assert.equal(unused.statusReads(), 0)
  assert.deepEqual(unused.activities, [])
  const first = deferred<void>()
  const calls: Array<string | null> = []
  const f = fixture({
    discord: {
      updateActivity: async (activity) => {
        calls.push(activity.title)
        await first.promise
      },
      clearActivity: async () => {
        calls.push(null)
      }
    }
  })
  f.integration.start()
  await flush()
  f.currentTrack.value = { ...f.track, title: 'B' }
  await flush()
  f.integration.dispose()
  first.resolve()
  await flush()
  assert.deepEqual(calls, ['A', null])
})
