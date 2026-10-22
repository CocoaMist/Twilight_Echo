import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { ref, shallowRef } from 'vue'
import vm from 'node:vm'
import { ipcError, parseAppError } from '../../../shared/errors/appError.ts'
import { presentError } from '../../../shared/errors/presentError.ts'
import { translate } from '../../../shared/i18n/translate.ts'
import { getTrackSource, isLikelyLocalFilePath } from '../utils/playerTrackUtils.ts'
import { createPlaybackSessionController } from './player/playbackSessionController.ts'
import { createPlaybackClockController } from './player/playbackClockController.ts'
import { evaluateNativePlaybackInfoIntent } from '../utils/nativePlaybackInfoIntent.ts'
import { findNativeQueueTrackIndex } from '../utils/nativeQueueTrackIndex.ts'
import { NativeQueueLoader } from '../utils/nativeQueueLoader.ts'
import { LibraryDatabase } from '../../../main/library/libraryDatabase.ts'
import { createLibraryPlaybackController } from './player/libraryPlaybackController.ts'
import { libraryNativeQueueOptions, libraryQueueTrack } from '../utils/libraryQueuePlayback.ts'
import {
  NativeQueueRevisionFence,
  synchronizeLatestNativeQueue
} from '../utils/nativeQueueRevision.ts'
import {
  preparePlayerNativeQueue,
  preparedNativePlayMode
} from '../utils/nativeQueuePreparation.ts'
import { toPlaybackQueueSnapshot } from '../utils/playbackQueueVirtualization.ts'
import { compactPlaylistRecord } from '../../../shared/playlistSnapshot.ts'
import { SleepTimerService } from '../../../main/sleepTimerCore.ts'
import { createSleepTimerController } from './sleepTimerController.ts'
import { createSleepTimerState } from '../../../shared/sleepTimer.ts'
import { LIBRARY_PAGE_SIZE } from '../../../shared/libraryDatabase.ts'
import { createPlaylistController } from './library/playlistController.ts'
import {
  NATIVE_PLAYBACK_INFO_INTENT_GRACE_MS,
  NATIVE_PLAYBACK_INFO_POST_CONFIRMATION_GRACE_MS
} from '../utils/playerConstants.ts'

const source = stripTypeScriptTypes(
  readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
)

test('production SQL EOF reads native authority, suppresses a fired timer and never re-dates an old boundary after arming', async (t) => {
  for (const scenario of ['stale-native', 'revoked-native', 'triggered-native', 'html']) {
    const db = new LibraryDatabase(':memory:')
    db.replaceDocument({
      version: 2,
      revision: 0,
      folders: [],
      exclusions: [],
      tracks: [
        {
          id: 'cue',
          filePath: 'D:/Music/disc.flac',
          duration: 90,
          cueRange: { startSeconds: 90, endSeconds: 180 }
        }
      ]
    })
    const player = createLibraryPlaybackController({
      createQueue: async (...args) => db.createLibraryQueue(...args),
      getQueue: async (...args) => db.getLibraryQueue(...args),
      readQueue: async (...args) => db.readLibraryQueue(...args),
      editQueue: async (...args) => db.editLibraryQueue(...args),
      deleteQueue: async (...args) => db.deleteLibraryQueue(...args)
    })
    t.after(() => {
      player.dispose()
      db.close()
    })
    await player.create({ ids: Array(605).fill('cue'), sort: 'playlist' }, 'cue', 'listLoop')
    await player.select(604, 'listLoop')
    let state = null,
      reports = 0,
      plays = 0
    const service = new SleepTimerService({ now: () => 2000 })
    service.configure(
      createSleepTimerState('queueEnd', 2000, { defaultMinutes: 1, fadeSeconds: 0 })
    )
    if (scenario !== 'html')
      service.boundary('queueEnd', scenario === 'triggered-native' ? 2000 : 1999)
    state = service.snapshot()
    // Delay renderer status delivery to exercise the getState barrier too.
    if (scenario === 'triggered-native') state = { ...state, active: true, triggered: false }
    const controller = createSleepTimerController({
      bridge: {
        configure: async (next) => service.configure(next),
        cancel: async () => service.cancel(),
        getState: async () => {
          if (scenario === 'revoked-native') context.activeLoadToken++
          return service.snapshot()
        },
        boundary: async (event) => {
          reports++
          return service.boundary(event)
        }
      },
      getSettings: () => ({ defaultMinutes: 1, fadeSeconds: 0 }),
      getState: () => state,
      setState: (next) => {
        state = next
      },
      persistSession() {},
      setNotice() {},
      onTriggered() {}
    })
    const context = vm.createContext({
      nativeQueueAdoptionUncertain: false,
      nativePlaybackActive: true,
      libraryNativeHandoff: null,
      playbackInfo: ref(
        scenario === 'html'
          ? {}
          : {
              naturalBoundaries: {
                trackSerial: 1,
                queueSerial: 1,
                trackTimeMs: 1999,
                queueTimeMs: 1999
              }
            }
      ),
      getSleepTimerController: () => controller,
      libraryPlayback: player,
      libraryTransportIntent: 0,
      activeLoadToken: 1,
      nativeQueueRevisionFence: new NativeQueueRevisionFence(),
      clearNativePlaybackInfoIntent() {},
      intentionalTrackGuard: null,
      currentTrack: ref(player.track()),
      playMode: ref('listLoop'),
      isPlaying: ref(false),
      isLoading: ref(false),
      autoAdvanceInFlight: false,
      advancingFromEndedTrackId: '',
      flushLatestCurrentTime() {},
      clearCrossfadeTimer() {},
      stopVisualizationPolling() {},
      playLibraryWindow() {
        plays++
      },
      reportLibraryPlaybackError(error) {
        throw error
      }
    })
    for (const name of [
      'invalidateLibraryTransportIntent',
      'advanceLibraryPlayback',
      'advanceAfterPlaybackEnded',
      'handlePlaybackEnded',
      'handleNativePlaybackEnded'
    ])
      vm.runInContext(productionFunction(name), context)
    if (scenario === 'html') await context.handlePlaybackEnded()
    else {
      let pending
      const handle = context.handlePlaybackEnded
      context.handlePlaybackEnded = (...args) => (pending = handle(...args))
      context.handleNativePlaybackEnded()
      await pending
    }
    assert.equal(reports, scenario === 'html' ? 2 : 0, scenario)
    assert.equal(plays, scenario === 'stale-native' ? 1 : 0, scenario)
    assert.equal(player.reference().index, scenario === 'stale-native' ? 0 : 604, scenario)
    assert.equal(
      service.snapshot().active,
      scenario === 'stale-native' || scenario === 'revoked-native',
      scenario
    )
  }
})

async function queuePlaylistFixture(t) {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: Array.from({ length: 605 }, (_, index) => ({
      id: String(index),
      title: `Song ${index}`,
      artist: 'Artist',
      album: 'Album',
      filePath: `D:/Music/${index}.flac`,
      duration: 180,
      ...(index === 200
        ? { cueRange: { startSeconds: 90, endSeconds: 180 }, cueSheetPath: 'D:/Music/disc.cue' }
        : {})
    }))
  })
  const api = {
    createQueue: async (...args) => db.createLibraryQueue(...args),
    getQueue: async (...args) => db.getLibraryQueue(...args),
    readQueue: async (...args) => db.readLibraryQueue(...args),
    editQueue: async (...args) => db.editLibraryQueue(...args),
    deleteQueue: async (...args) => db.deleteLibraryQueue(...args)
  }
  const player = createLibraryPlaybackController(api)
  await player.create({ sort: 'playlist' }, '0', 'sequential')
  await player.edit(
    {
      kind: 'insert',
      items: [
        { id: '0' },
        {
          id: 'demo:remote',
          snapshot: {
            id: 'demo:remote',
            title: 'Remote',
            source: 'demo',
            filePath: 'demo:remote',
            duration: 180
          }
        }
      ]
    },
    'sequential'
  )
  const f = handoffFixture(t)
  const writes = []
  f.context.window.api = {
    data: {
      savePlaylists: async (snapshot) => {
        writes.push(snapshot)
      }
    }
  }
  const playlists = shallowRef([])
  const controller = createPlaylistController({
    playlists,
    tracks: shallowRef([]),
    trackById: new Map(),
    getTracksRevision: () => 0,
    playlistPersistenceStatus: ref({
      state: 'idle',
      dirty: false,
      failureCount: 0,
      lastError: null
    }),
    playlistPersistenceNotice: ref(null)
  })
  Object.assign(f.context, {
    libraryPlayback: player,
    libraryTransportIntent: 0,
    libraryQueueTrack,
    saveArrayQueueAsPlaylist: (name, create) => create(name, [...f.context.queue.value]),
    setAudioEngineError() {}
  })
  f.context.queue.value = []
  vm.runInContext(productionFunction('saveQueueAsPlaylist'), f.context)
  t.after(() => {
    player.dispose()
    db.close()
  })
  return { ...f, db, api, player, controller, playlists, writes }
}

test('production queue save streams real SQLite order into one completed playlist transaction', async (t) => {
  const f = await queuePlaylistFixture(t)
  const legacy = () => {
    assert.fail('complete database queue must not use the array callback')
  }
  const sizes = []
  const id = await f.context.saveQueueAsPlaylist('Saved', legacy, (name, produce, signal) =>
    f.controller.createPlaylistWithTrackPages(
      name,
      async (append) =>
        produce(async (tracks) => {
          sizes.push(tracks.length)
          assert.equal(f.playlists.value.length, 0)
          await append(tracks)
        }),
      signal
    )
  )
  assert.ok(id)
  assert.deepEqual(sizes, [200, 200, 200, 7])
  assert.deepEqual(f.context.queue.value, [])
  assert.equal(
    f.playlists.value[0].trackIds.length,
    606,
    'ordinary playlist deduplicates repeated queue occurrences'
  )
  assert.equal(f.playlists.value[0].trackIds.at(-1), 'demo:remote')
  assert.deepEqual(f.playlists.value[0].trackSnapshots['200'].cueRange, {
    startSeconds: 90,
    endSeconds: 180
  })
  assert.ok(f.player.diagnostics.cachedTracks <= 2000)
  assert.equal(await f.controller.flushPlaylists(), true)
  assert.equal(f.writes.length, 1)
})

for (const failure of ['read', 'detach', 'late-detach', 'late-revision', 'abort']) {
  test(`production streaming queue save discards staging on ${failure}`, async (t) => {
    const f = await queuePlaylistFixture(t)
    const cancellation = new AbortController()
    const read = f.api.readQueue
    f.api.readQueue = async (...args) => {
      if (args[1] === 200) {
        if (failure === 'read') throw new Error('page read failed')
        if (failure === 'detach') f.player.detach()
        if (failure === 'abort') cancellation.abort()
      }
      return read(...args)
    }
    const creator = (name, produce, signal) =>
      f.controller.createPlaylistWithTrackPages(
        name,
        async (append) => {
          const guard = await produce(append)
          if (failure === 'late-detach') f.player.detach()
          if (failure === 'late-revision')
            f.player.invalidateLibrary(f.player.contentRevision.value + 1)
          return guard
        },
        signal
      )
    await assert.rejects(
      f.context.saveQueueAsPlaylist(
        'Saved',
        () => assert.fail('legacy fallback'),
        creator,
        cancellation.signal
      )
    )
    assert.deepEqual(f.playlists.value, [])
    assert.equal(await f.controller.flushPlaylists(), true)
    assert.equal(f.writes.length, 0)
    assert.deepEqual(f.context.queue.value, [])
  })
}

test('production save preserves the synchronous two-argument array callback contract', async (t) => {
  const f = await queuePlaylistFixture(t)
  f.player.detach()
  f.context.queue.value = [{ id: 'array' }]
  let captured
  const id = f.context.saveQueueAsPlaylist('Array', (name, tracks) => {
    captured = tracks
    return name
  })
  assert.equal(id, 'Array')
  assert.notEqual(captured, f.context.queue.value)
  assert.deepEqual(captured, [{ id: 'array' }])
})
function productionFunction(name) {
  const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'))
  assert.ok(start >= 0)
  const end = source.indexOf('\n}', start)
  assert.ok(end > start)
  return source.slice(start, end + 2)
}

for (const eventOrder of ['info-first', 'start-first']) {
  test(`Native queue ${eventOrder}: playbar retains the incoming source position and keeps advancing`, async (t) => {
    const f = handoffFixture(t)
    f.context.setNativePlaybackInfoIntent(1, f.outgoing, f.outgoing.filePath, 0)
    f.context.applyNativePlaybackInfo(f.info(f.outgoing, 0, 170))
    f.setNow(16000)
    f.context.applyNativePlaybackInfo(f.info(f.outgoing, 0, 186))
    const incomingInfo = f.info(f.incoming, 1, 4.18)
    if (eventOrder === 'start-first') f.startFile()
    assert.equal(f.context.applyNativePlaybackInfo(incomingInfo), true)
    if (eventOrder === 'info-first') f.startFile()
    await Promise.resolve()
    assert.equal(f.context.currentTrack.value.id, f.incoming.id)
    assert.equal(f.context.currentTime.value, 4.18)
    assert.equal(f.clock.playbackClockSnapshot.value.trackId, f.incoming.id)
    assert.equal(f.context.duration.value, 257)
    assert.equal(f.context.applyNativePlaybackInfo(f.info(f.outgoing, 0, 186)), false)
    f.setNow(16300)
    assert.equal(f.context.applyNativePlaybackInfo(f.info(f.incoming, 1, 4.48)), true)
    f.clock.flushLatestCurrentTime()
    assert.ok(Math.abs(f.context.currentTime.value - 4.48) < 0.001)
  })
}

test('confirming ordinary playing ticks cannot prolong the previous-track guard', (t) => {
  const f = handoffFixture(t)
  f.context.setNativePlaybackInfoIntent(1, f.outgoing, f.outgoing.filePath, 0)
  assert.equal(f.context.applyNativePlaybackInfo(f.info(f.outgoing, 0, 170)), true)
  f.setNow(300)
  assert.equal(f.context.applyNativePlaybackInfo(f.info(f.outgoing, 0, 170.3)), true)
  assert.equal(f.context.applyNativePlaybackInfo(f.info(f.incoming, 1, 4)), false)
  for (const time of [2300, 2700, 2990]) {
    f.setNow(time)
    assert.equal(f.context.applyNativePlaybackInfo(f.info(f.outgoing, 0, 170 + time / 1000)), true)
  }
  f.setNow(3001)
  assert.equal(f.context.applyNativePlaybackInfo(f.info(f.incoming, 1, 4.2)), true)
})

test('an uncertain conditional queue handoff suppresses native identity, start, property and EOF events until explicit recovery', (t) => {
  const f = handoffFixture(t)
  f.context.nativeQueueAdoptionUncertain = true
  f.context.nativeQueueDelegated = true
  f.context.libraryNativeHandoff = null
  let ended = 0,
    property
  f.context.handlePlaybackEnded = () => {
    ended++
  }
  vm.runInContext(
    productionFunction('handleNativePlaybackEnded') + productionFunction('isNativeQueueDelegated'),
    f.context
  )
  f.context.api.onPropertyChange = (callback) => {
    property = callback
  }
  const registration = source.match(
    /api\.onPropertyChange\(\(\{ name, data \}\) => \{[\s\S]*?\n    \}\)/
  )?.[0]
  assert.ok(registration)
  vm.runInContext(registration, f.context)
  assert.equal(f.context.applyNativePlaybackInfo(f.info(f.incoming, 1, 4.2)), false)
  f.startFile()
  for (const [name, data] of [
    ['time-pos', 3],
    ['duration', 200],
    ['pause', true],
    ['eof-reached', true]
  ])
    property({ name, data })
  f.context.handleNativePlaybackEnded()
  assert.equal(f.context.isNativeQueueDelegated(), false)
  assert.equal(f.context.currentTrack.value.id, f.outgoing.id)
  assert.equal(f.context.currentTime.value, 170)
  assert.equal(f.context.duration.value, 186)
  assert.equal(f.context.isPlaying.value, true)
  assert.equal(ended, 0)
  f.context.nativeQueueAdoptionUncertain = false
  assert.equal(f.context.isNativeQueueDelegated(), true)
  f.context.handleNativePlaybackEnded()
  assert.equal(ended, 1)
})

test('NetEase native windows map opaque grants to the incoming UI track and source clock', async (t) => {
  const f = handoffFixture(t)
  f.outgoing.id = 'ncm:a'
  f.outgoing.filePath = 'ncm:a'
  f.outgoing.streamUrl = 'twilight-media://audio/a'
  f.incoming.id = 'ncm:b'
  f.incoming.filePath = 'ncm:b'
  f.incoming.streamUrl = 'twilight-media://audio/b'
  f.context.queue.value = [
    { id: 'ncm:unresolved', filePath: 'ncm:unresolved' },
    f.outgoing,
    f.incoming
  ]
  f.context.queueIndex.value = 1
  f.context.loadedTrackId = f.outgoing.id
  const loader = new NativeQueueLoader()
  await loader.loadPrepared(
    {
      items: [
        { id: f.outgoing.id, source: f.outgoing.streamUrl },
        { id: f.incoming.id, source: f.incoming.streamUrl }
      ],
      startIndex: 0,
      delegated: false,
      queueIndices: [1, 2]
    },
    { loadQueue: async () => ({ queueToken: 'ncm-window' }) },
    f.context.queue.value
  )
  f.context.nativeQueueLoader = loader
  vm.runInContext(productionFunction('findTrackIndexFromPlaybackInfo'), f.context)
  const info = {
    ...f.info(f.incoming, 1, 4.18),
    source: 'https://cdn.test/b.flac',
    queueToken: 'ncm-window'
  }
  assert.equal(f.context.applyNativePlaybackInfo(info), true)
  assert.equal(f.context.queueIndex.value, 2)
  assert.equal(f.context.currentTrack.value.id, 'ncm:b')
  assert.equal(f.context.currentTime.value, 4.18)
  assert.equal(f.clock.playbackClockSnapshot.value.trackId, 'ncm:b')
})

function handoffFixture(t) {
  const outgoing = {
    id: 'outgoing',
    filePath: 'D:\\Music\\out.flac',
    source: 'local',
    duration: 186
  }
  const incoming = {
    id: 'incoming',
    filePath: 'D:\\Music\\in.flac',
    source: 'local',
    duration: 257
  }
  let now = 0
  const noop = () => {}
  const context = {
    playerSleepTimer: { interruptShutdown: noop },
    libraryPlayback: { active: ref(false), reference: () => null },
    currentTrack: shallowRef(outgoing),
    currentTime: ref(170),
    duration: ref(186),
    queue: shallowRef([outgoing, incoming]),
    queueIndex: ref(0),
    playbackInfo: shallowRef(null),
    loadedTrackId: outgoing.id,
    lastActiveTrack: outgoing,
    nativePlaybackActive: true,
    nativeQueueAdoptionUncertain: false,
    isPlaying: ref(true),
    isLoading: ref(false),
    playMode: ref('sequential'),
    restoredPlaybackPending: false,
    nativePlaybackInfoIntent: null,
    intentionalTrackGuard: null,
    playbackToggleIntent: null,
    pendingLoadStartTime: 0,
    nativeHistoryRestartPending: false,
    activeLoadToken: 1,
    streamNowPlaying: ref(''),
    startFilePlaybackInfoRefreshGeneration: 0,
    NATIVE_PLAYBACK_INFO_INTENT_GRACE_MS,
    NATIVE_PLAYBACK_INFO_POST_CONFIRMATION_GRACE_MS,
    getNowMs: () => now,
    getTrackAudioSource: (track) => track.filePath,
    evaluateNativePlaybackInfoIntent,
    normalizeNativePlaybackInfo: (info) => info,
    findTrackIndexFromPlaybackInfo: (info) =>
      findNativeQueueTrackIndex(
        context.queue.value,
        context.queueIndex.value,
        info,
        undefined,
        true
      ),
    mergeTrackTransientData: (track) => track,
    toPlaybackQueueSnapshot: (track) => track,
    hydratePlaybackTrack: (track) => track,
    nonEmptyString: (value) => value || '',
    lyricsLoader: { ensureCurrentTrackLyricsLoaded: noop },
    cueDuration: (track) => track.duration,
    clearAbLoop: noop,
    applyNativePlayingState: noop,
    applyNativeStreamBufferingFromInfo: noop,
    playbackHistoryController: { recordPlaybackStart: noop },
    scheduleCrossfadeIfNeeded: noop,
    clearPendingNativePause: noop,
    setPlaybackToggleIntent: noop,
    // The real snapshot already precedes start-file; isolate the event's immediate
    // effect so an asynchronous refresh cannot hide a destructive clock reset.
    refreshPlaybackInfoAfterStartFile: async () => {},
    window: { setTimeout, clearTimeout, setInterval, clearInterval }
  }
  const previousWindow = globalThis.window
  globalThis.window = context.window
  const clock = createPlaybackClockController({
    currentTrack: context.currentTrack,
    currentTime: context.currentTime,
    duration: context.duration,
    playbackRate: ref(1),
    isPlaying: context.isPlaying,
    isLoading: context.isLoading,
    abLoopA: ref(null),
    abLoopB: ref(null),
    playMode: context.playMode,
    getNow: () => now,
    getPlaybackToggleIntent: () => null,
    getAbLoopNativeActive: () => false,
    enforceAbLoop: noop,
    isCurrentTrackLiveStream: () => false,
    applyNativePlaybackInfo: (info) => context.applyNativePlaybackInfo(info)
  })
  Object.assign(context, clock)
  t.after(() => {
    clock.dispose()
    globalThis.window = previousWindow
  })
  vm.createContext(context)
  for (const name of [
    'setNativePlaybackInfoIntent',
    'clearNativePlaybackInfoIntent',
    'markNativePlaybackInfoIntentConfirmed',
    'shouldIgnoreNativePlaybackInfo',
    'applyNativePlaybackInfo'
  ])
    vm.runInContext(productionFunction(name), context)
  const registration = source.match(/api\.onStartFile\(\(\) => \{[\s\S]*?\n    \}\)/)?.[0]
  assert.ok(registration)
  let startFile
  context.api = {
    onStartFile: (callback) => {
      startFile = callback
    }
  }
  vm.runInContext(registration, context)
  clock.beginPlaybackPositionTransition(170)
  return {
    context,
    clock,
    outgoing,
    incoming,
    startFile,
    setNow: (value) => {
      now = value
    },
    info: (track, index, position) => ({
      source: track.filePath,
      queueIndex: index,
      position,
      duration: track.duration,
      state: 'playing',
      nativePlaybackActive: true
    })
  }
}

test('a missing non-NetEase provider cache is re-resolved with force instead of replayed', async () => {
  const calls = []
  const track = { id: 'demo:one', source: 'demo', streamUrl: 'D:\\Cache\\removed.flac' }
  const context = {
    window: { api: { fs: { isAudioFileAuthorized: async () => false } } },
    getTrackSource,
    isLikelyLocalFilePath,
    shouldReuseResolvedStreamUrl: () => true,
    syncPluginProviders: async () => {},
    appSettings: ref({ ncmPlaybackQuality: 'lossless' }),
    useMediaProviders: () => ({
      resolvePlaybackUrl: async (_, options) => {
        calls.push(options)
        return 'https://media.example/fresh.flac'
      }
    })
  }
  vm.createContext(context)
  vm.runInContext(
    productionFunction('isUsableLocalPlaybackFile') + productionFunction('resolvePlayTarget'),
    context
  )
  assert.equal(await context.resolvePlayTarget(track), 'https://media.example/fresh.flac')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].force, true)
})

test('unavailable targets reach source recovery without being labeled an engine outage', async () => {
  const f = loadFixture()
  await f.context.loadAndPlay(f.track)
  assert.equal(f.fallbacks.length, 1)
  assert.match(presentError('zh-CN', f.errors[0]), /播放地址/)
  assert.doesNotMatch(presentError('zh-CN', f.errors[0]), /引擎不可用|Native playback/)
  assert.equal(f.context.isLoading.value, false)
  assert.equal(f.context.isPlaying.value, false)
  assert.equal(f.context.autoAdvanceInFlight, false)
})

test('a rejected recovery settles playback and retains the original failure', async () => {
  const f = loadFixture({
    fallback: async () => {
      throw new Error('rematch unavailable')
    }
  })
  await assert.doesNotReject(f.context.loadAndPlay(f.track))
  assert.equal(f.fallbacks.length, 1)
  assert.equal(f.context.isLoading.value, false)
  assert.equal(f.context.isPlaying.value, false)
  assert.match(presentError('zh-CN', f.errors[0]), /播放地址/)
})

test('queue IPC failures retain output fallback without attempting source recovery', async () => {
  const f = loadFixture()
  f.context.nativeQueueLoader.prepareAndLoad = async () => {
    throw new Error('native queue IPC unavailable')
  }
  await f.context.loadAndPlay(f.track)
  assert.equal(f.fallbacks.length, 0)
  assert.match(f.errors[0], /native queue IPC unavailable/)
  assert.equal(f.context.isLoading.value, false)
  assert.equal(f.context.isPlaying.value, false)
})

test('an older failed load cannot clear a newer load after waiting for source recovery', async () => {
  let release, notify
  const started = new Promise((resolve) => {
    notify = resolve
  })
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const f = loadFixture({
    fallback: () => {
      notify()
      return gate
    }
  })
  f.context.resolvePlayTarget = async () => {
    throw new Error('original source unavailable')
  }
  const pending = f.context.loadAndPlay(f.track)
  await started
  f.context.activeLoadToken++
  f.context.currentTrack.value = { ...f.track, id: 'local:new' }
  f.context.isLoading.value = true
  f.context.isPlaying.value = true
  release(false)
  await pending
  assert.equal(f.context.isLoading.value, true)
  assert.equal(f.context.isPlaying.value, true)
  assert.deepEqual(f.errors, [])
})

function loadFixture({ fallback = async () => false } = {}) {
  const track = { id: 'local:one', source: 'local', filePath: 'D:\\Music\\one.flac', duration: 180 }
  const errors = [],
    fallbacks = []
  const noop = () => {}
  const context = {
    libraryPlayback: { active: ref(false), reference: () => null },
    nativeQueueRevisionFence: new NativeQueueRevisionFence(),
    ipcError,
    parseAppError,
    translate,
    currentLocale: () => 'zh-CN',
    getTrackSource,
    currentTrack: ref(track),
    queue: ref([track]),
    queueIndex: ref(0),
    lastActiveTrack: null,
    activeLoadToken: 0,
    playMode: ref('sequential'),
    playbackRate: ref(1),
    isLoading: ref(false),
    isPlaying: ref(true),
    duration: ref(180),
    streamNowPlaying: ref(''),
    playbackAudio: null,
    autoAdvanceInFlight: true,
    appSettings: ref({ ncmPlaybackQuality: 'lossless' }),
    ncmStreamUrlCommittedAt: new Map(),
    nativeSourceToTrackId: new Map(),
    playbackHistoryController: { beginPlaybackAttempt: noop, clearResumeOfferForOtherTrack: noop },
    playbackSessionController: { clearPendingPlaybackPosition: noop },
    clampCuePlaybackPosition: (_, time) => time,
    cueDuration: (item) => item.duration,
    stopNativeAudio: async () => {},
    resolvePlayTarget: async (item) => item.filePath,
    isActiveLoad: (token, item) =>
      token === context.activeLoadToken && item.id === context.currentTrack.value.id,
    shouldUseNativePlayback: () => true,
    stripStaleNcmStreamUrls: (items) => items,
    nativeQueueLoader: { prepareAndLoad: async () => null },
    handlePlaybackFallback: async (...args) => {
      fallbacks.push(args)
      return fallback(...args)
    },
    setAudioEngineError: (error) => errors.push(error),
    window: { api: { fs: {}, audioEngine: { isHtmlAudioFallbackAllowed: async () => false } } },
    console: { warn: noop, error: noop }
  }
  for (const name of [
    'clearPlaybackToggleIntent',
    'setNativePlaybackInfoIntent',
    'stopVisualizationPolling',
    'resetNativeStreamBufferingState',
    'stopRendererAudio',
    'beginPlaybackPositionTransition',
    'clearAbLoop',
    'clearCrossfadeTimer',
    'patchTrackInQueues',
    'clearNativePlaybackInfoIntentForLoad'
  ])
    context[name] = noop
  vm.createContext(context)
  vm.runInContext(productionFunction('loadAndPlay'), context)
  return { context, track, errors, fallbacks }
}

test('a real player load survives a queue edit during native authorization and starts before the resync', async () => {
  const f = loadFixture(),
    calls = []
  let release, notify
  const entered = new Promise((resolve) => {
      notify = resolve
    }),
    blocked = new Promise((resolve) => {
      release = resolve
    })
  Object.assign(f.context, {
    nativeQueueLoader: new NativeQueueLoader(),
    preparePlayerNativeQueue,
    preparedNativePlayMode,
    synchronizeLatestNativeQueue,
    toPlaybackQueueSnapshot,
    nativeQueueSyncRequest: null,
    getTrackAudioSource: (track) => track.filePath,
    pruneNativeSourceToTrackId: () => {},
    startVisualizationPolling: () => {}
  })
  f.context.playbackHistoryController.maybeOfferResumeForTrack = () => {}
  f.context.playbackHistoryController.recordPlaybackStart = () => {}
  f.context.playbackSessionController.consumePendingPlaybackPosition = (_, start) => start
  f.context.window.api.fs.isAudioFileAuthorized = async () => {
    notify()
    await blocked
    return true
  }
  Object.assign(f.context.window.api.audioEngine, {
    loadQueue: async () => {
      calls.push('load')
      return { queueToken: String(calls.length) }
    },
    setPlayMode: async () => {
      calls.push('mode')
    },
    play: async () => {
      calls.push('play')
      return { nativeStarted: true }
    }
  })
  for (const name of [
    'captureNativeQueueState',
    'syncNativeQueueState',
    'trackNativeQueueSyncRequest',
    'queueNativeQueueStateSync'
  ])
    vm.runInContext(productionFunction(name), f.context)
  const load = f.context.loadAndPlay(f.track)
  await entered
  const sync = f.context.queueNativeQueueStateSync()
  release()
  await Promise.all([load, sync])
  assert.deepEqual(calls, ['load', 'mode', 'play', 'load', 'mode'])
  assert.deepEqual(f.fallbacks, [])
  assert.equal(f.context.isPlaying.value, true)
})

test('a waiting resync keeps its pre-advance cursor rather than advancing twice after optimistic UI selection', async () => {
  const fence = new NativeQueueRevisionFence(),
    snapshots = []
  let release
  const blocked = fence.serialize(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const context = {
    nativeQueueRevisionFence: fence,
    cursor: 0,
    captureNativeQueueState: (revision) => ({ revision, currentIndex: context.cursor }),
    syncNativeQueueState: async (snapshot) => {
      snapshots.push(snapshot.currentIndex)
    },
    trackNativeQueueSyncRequest: (request) => request
  }
  vm.createContext(context)
  vm.runInContext(productionFunction('queueNativeQueueStateSync'), context)
  await Promise.resolve()
  const sync = context.queueNativeQueueStateSync()
  context.cursor = 1
  release()
  await Promise.all([blocked, sync])
  assert.deepEqual(snapshots, [0])
})

for (const direction of ['next', 'previous']) {
  for (const stage of ['queue', 'advance', 'info']) {
    test(`${direction}: restoring a paused selection cancels stale work during ${stage}`, async () => {
      const f = fixture(stage)
      const pending = f.advanceNativePlayback(direction)
      await f.started
      f.controller.prepareQueueSelection(f.track('restored-session'), 37)
      f.release()
      await pending
      assert.deepEqual(f.loads, [])
      assert.equal(f.isPlaying.value, false)
      assert.equal(f.currentTrack.value.id, 'restored-session')
      assert.equal(f.isLoading.value, false)
      assert.equal(f.visualizationStarts(), 0)
    })
  }
}

test('a current native advance still reloads its predicted track when no native confirmation arrives', async () => {
  const f = fixture('advance')
  const pending = f.advanceNativePlayback('next')
  await f.started
  f.release()
  await pending
  assert.deepEqual(f.loads, ['old-B'])
  assert.equal(f.isPlaying.value, true)
})

function fixture(stage) {
  const track = (id) => ({
    id,
    queueEntryId: id,
    title: id,
    artist: '',
    album: '',
    source: 'local',
    filePath: `/Music/${id}.flac`,
    fileName: `${id}.flac`,
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null
  })
  const currentTrack = shallowRef(track('old-A'))
  const isPlaying = ref(true)
  const isLoading = ref(false)
  const queueIndex = ref(0)
  const duration = ref(180)
  let release
  let notify
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const started = new Promise((resolve) => {
    notify = resolve
  })
  const wait = async (at) => {
    if (stage === at) {
      notify()
      await gate
    }
  }
  const loads = []
  const windowStub = {
    setTimeout: (callback) => setTimeout(callback, 0),
    api: {
      audioEngine: {
        next: () => wait('advance'),
        previous: () => wait('advance'),
        getPlaybackInfo: async () => {
          await wait('info')
          return { state: 'stopped' }
        }
      }
    }
  }
  const harness = new Function(
    'refs',
    'createPlaybackSessionController',
    'window',
    'loads',
    'track',
    'wait',
    `
    const { currentTrack, isPlaying, isLoading, queueIndex, duration } = refs;
    const libraryPlayback = { active: { value: false } };
    let activeLoadToken = 1, nativePlaybackActive = true, nativeQueueDelegated = true, restoredPlaybackPending = false;
    let startFilePlaybackInfoRefreshGeneration = 0, loadedTrackId = 'old-A', visualizationStarts = 0;
    const nativeQueueRevisionFence = { next() {} }, nativeSourceToTrackId = new Map(), playbackInfo = { value: null }, castTargetUsn = { value: null };
    const NATIVE_PLAYBACK_INFO_REFRESH_DELAY_MS = 0;
    const clearPlaybackToggleIntent = () => {}, setNativePlaybackInfoIntent = () => {}, clearNativePlaybackInfoIntent = () => {};
    const resetPlaybackClock = () => {}, resetNativeStreamBufferingState = () => {}, stopVisualizationPolling = () => {}, stopRendererAudio = () => {}, stopNativeAudio = async () => {};
    const startVisualizationPolling = () => { visualizationStarts++ }, setAudioEngineError = error => { throw new Error(error) };
    const getNativeQueueAdvanceTarget = () => ({ track: track('old-B'), queueIndex: 1 });
    const getTrackAudioSource = track => track.filePath;
    const activateCurrentTrack = track => { currentTrack.value = track };
    const waitForNativeQueueStateSync = () => wait('queue');
    const findTrackIndexFromPlaybackInfo = () => -1, shouldIgnoreNativePlaybackInfo = () => true;
    const loadAndPlay = async selected => { loads.push(selected.id); isPlaying.value = true; };
    ${productionFunction('resetPlaybackRuntimeStateForRestore')}
    ${productionFunction('applyNativePlaybackInfo')}
    ${productionFunction('advanceNativePlayback')}
    const controller = createPlaybackSessionController({
      currentTrack, duration, isPlaying, isLoading, resetPlaybackRuntimeStateForRestore,
      clearCrossfadeTimer() {}, hydratePlaybackTrack: value => value,
      setRestoredPlaybackPending: value => { restoredPlaybackPending = value },
      setRestoredPlaybackPosition() {}, setPendingLoadStartTime() {}, setAutoAdvanceInFlight() {},
      setAdvancingFromEndedTrackId() {}, setCurrentTimeImmediate() {}, loadLyricsForTrack() {}
    });
    return { advanceNativePlayback, controller, visualizationStarts: () => visualizationStarts };
  `
  )(
    { currentTrack, isPlaying, isLoading, queueIndex, duration },
    createPlaybackSessionController,
    windowStub,
    loads,
    track,
    wait
  )
  return { ...harness, loads, started, release, currentTrack, isPlaying, isLoading, track }
}

test('real player commits a cross-page SQLite CUE handoff and renews native preload without play/seek/stop', async (t) => {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: Array.from({ length: 405 }, (_, index) => ({
      id: String(index),
      title: String(index),
      filePath: 'D:/Music/disc.flac',
      duration: 90,
      cueRange: { startSeconds: index * 90, endSeconds: (index + 1) * 90 }
    }))
  })
  const player = createLibraryPlaybackController({
    createQueue: async (...args) => db.createLibraryQueue(...args),
    getQueue: async (...args) => db.getLibraryQueue(...args),
    readQueue: async (...args) => db.readLibraryQueue(...args),
    editQueue: async (...args) => db.editLibraryQueue(...args),
    deleteQueue: async (...args) => db.deleteLibraryQueue(...args)
  })
  t.after(() => {
    player.dispose()
    db.close()
  })
  const initial = await player.create({ sort: 'playlist' }, '199', 'sequential')
  const f = handoffFixture(t)
  const calls = [],
    saved = [],
    modesSaved = []
  const loader = new NativeQueueLoader()
  let token = 0
  const engine = {
    loadQueue: async (items, index) => {
      calls.push({ kind: 'load', items, index })
      return { queueToken: `db-${++token}` }
    },
    setPlayMode: async (mode) => {
      calls.push({ kind: 'mode', mode })
    },
    play: async () => {
      throw new Error('native handoff must not restart playing audio')
    },
    stop: async () => {
      throw new Error('native handoff must not stop playing audio')
    },
    seek: async () => {
      throw new Error('native handoff must not seek playing audio')
    }
  }
  const boundary = {
    isAudioFileAuthorized: async () => true,
    areAudioFilesAuthorized: async (paths) => paths.map(() => true)
  }
  await loader.prepareAndLoad(
    libraryNativeQueueOptions(initial, player.track(), player.track().filePath, 'sequential'),
    boundary,
    engine
  )
  Object.assign(f.context, {
    libraryPlayback: player,
    requestedLibraryPlayMode: null,
    libraryPlayModeIntent: 0,
    libraryNativeHandoff: null,
    latestLibraryHandoffInfo: null,
    libraryQueueTrack,
    libraryNativeQueueOptions,
    nativeQueueLoader: loader,
    nativeQueueDelegated: false,
    nativeQueueRevisionFence: new NativeQueueRevisionFence(),
    nativeQueueSyncRequest: null,
    preparePlayerNativeQueue,
    preparedNativePlayMode,
    synchronizeLatestNativeQueue,
    persistSelectedTrackSession: () => saved.push(player.reference()),
    rendererPlayModeBoundaryPending: ref(false),
    updateSettings: async (settings) => {
      modesSaved.push(settings.playMode)
    },
    reportLibraryPlaybackError: (error) => {
      throw error
    }
  })
  f.context.window.api = { audioEngine: engine, fs: boundary }
  f.context.queue.value = []
  f.context.queueIndex.value = -1
  f.context.currentTrack.value = player.track()
  f.context.loadedTrackId = player.track().id
  for (const name of [
    'findTrackIndexFromPlaybackInfo',
    'captureNativeQueueState',
    'syncNativeQueueState',
    'trackNativeQueueSyncRequest',
    'queueNativeQueueStateSync',
    'acceptLibraryNativeHandoff',
    'setPlayModeInternal'
  ])
    vm.runInContext(productionFunction(name), f.context)
  const incoming = libraryQueueTrack(initial.items[1].track, initial.items[1].queueEntryId)
  const oldInfo = { ...f.info(incoming, 1, 2.5), queueToken: 'db-1' }
  assert.equal(f.context.applyNativePlaybackInfo(oldInfo), false)
  const pending = f.context.libraryNativeHandoff
  assert.ok(pending)
  await pending
  assert.equal(f.context.currentTrack.value.id, '200')
  assert.equal(f.context.currentTrack.value.queueEntryId, initial.items[1].queueEntryId)
  assert.equal(f.context.currentTime.value, 2.5)
  assert.equal(f.context.queue.value.length, 0)
  assert.equal(f.context.queueIndex.value, -1)
  assert.equal(db.getLibraryQueue(initial.queue.id).index, 200)
  assert.equal(saved[0].entryId, initial.items[1].queueEntryId)
  assert.deepEqual(
    calls.map((call) => call.kind),
    ['load', 'load', 'mode']
  )
  assert.deepEqual(
    calls[1].items.map((item) => item.id),
    ['200', '201']
  )
  assert.equal(calls[1].items[0].cueRange.startSeconds, 18_000)
  assert.equal(f.context.applyNativePlaybackInfo(oldInfo), false)
  assert.equal(
    f.context.applyNativePlaybackInfo({
      ...oldInfo,
      queueIndex: 0,
      queueToken: 'db-2',
      position: 2.8
    }),
    true
  )
  // A mode edit queued behind the incoming cursor must not make its own
  // pending/busy flag suppress the native selection that preceded it.
  const next = libraryQueueTrack(
    player.window.value.items[1].track,
    player.window.value.items[1].queueEntryId
  )
  f.context.applyNativePlaybackInfo({ ...f.info(next, 1, 1.2), queueToken: 'db-2' })
  const handoff = f.context.libraryNativeHandoff
  f.context.setPlayModeInternal('shuffle')
  await handoff
  for (let attempt = 0; attempt < 20 && f.context.playMode.value !== 'shuffle'; attempt++)
    await new Promise((resolve) => setImmediate(resolve))
  if (f.context.nativeQueueSyncRequest) await f.context.nativeQueueSyncRequest
  assert.equal(f.context.currentTrack.value.id, '201')
  assert.equal(player.track().id, '201')
  assert.equal(player.reference().index, 0)
  assert.equal(f.context.playMode.value, 'shuffle')
  assert.equal(
    loader.findLibraryEntry({ queueIndex: 0, queueToken: `db-${token}` }, player.reference()).id,
    '201'
  )
  f.context.setPlayModeInternal('sequential')
  f.context.setPlayModeInternal('shuffle')
  for (let attempt = 0; attempt < 20 && f.context.requestedLibraryPlayMode !== null; attempt++)
    await new Promise((resolve) => setImmediate(resolve))
  assert.equal(player.window.value.queue.order, 'shuffle')
  assert.equal(f.context.playMode.value, 'shuffle')
  assert.deepEqual(modesSaved, ['shuffle', 'shuffle'])
})

test('real foreground player loads SQLite current+next while legacy arrays remain empty', async (t) => {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [
      { id: 'a', filePath: 'D:/Music/a.flac', duration: 180 },
      { id: 'b', filePath: 'D:/Music/b.flac', duration: 180 }
    ]
  })
  const player = createLibraryPlaybackController({
    createQueue: async (...args) => db.createLibraryQueue(...args),
    getQueue: async (...args) => db.getLibraryQueue(...args),
    readQueue: async (...args) => db.readLibraryQueue(...args),
    editQueue: async (...args) => db.editLibraryQueue(...args),
    deleteQueue: async (...args) => db.deleteLibraryQueue(...args)
  })
  t.after(() => {
    player.dispose()
    db.close()
  })
  await player.create({ sort: 'playlist' }, 'a', 'sequential')
  const f = loadFixture()
  const calls = []
  const loader = new NativeQueueLoader()
  Object.assign(f.context, {
    libraryPlayback: player,
    libraryNativeQueueOptions,
    nativeQueueLoader: loader,
    preparedNativePlayMode,
    pruneNativeSourceToTrackId: () => {},
    startVisualizationPolling: () => {}
  })
  f.context.currentTrack.value = player.track()
  f.context.queue.value = []
  f.context.queueIndex.value = -1
  f.context.playbackHistoryController.maybeOfferResumeForTrack = () => {}
  f.context.playbackHistoryController.recordPlaybackStart = () => {}
  f.context.playbackSessionController.consumePendingPlaybackPosition = (_, start) => start
  Object.assign(f.context.window.api.fs, {
    isAudioFileAuthorized: async () => true,
    areAudioFilesAuthorized: async (paths) => paths.map(() => true)
  })
  Object.assign(f.context.window.api.audioEngine, {
    loadQueue: async (items, index) => {
      calls.push({ kind: 'load', items, index })
      return { queueToken: 'db' }
    },
    setPlayMode: async (mode) => {
      calls.push({ kind: 'mode', mode })
    },
    play: async (target, position) => {
      calls.push({ kind: 'play', target, position })
      return { nativeStarted: true }
    }
  })
  await f.context.loadAndPlay(f.context.currentTrack.value, 12)
  assert.deepEqual(f.errors, [''])
  assert.deepEqual(f.fallbacks, [])
  assert.equal(f.context.isPlaying.value, true)
  assert.deepEqual(
    calls.map((call) => call.kind),
    ['load', 'mode', 'play']
  )
  assert.deepEqual(
    calls[0].items.map((item) => item.id),
    ['a', 'b']
  )
  assert.equal(calls[2].position, 12)
  assert.equal(calls[0].items[0].queueEntryId, player.reference().entryId)
  assert.equal(f.context.queue.value.length, 0)
  assert.equal(f.context.queueIndex.value, -1)
  assert.equal(loader.getLibraryQueueReference().id, player.reference().id)
})

test('actual next/previous and EOF route through the SQLite cursor without populating array queues', async (t) => {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: ['a', 'b', 'c'].map((id) => ({ id, filePath: `D:/Music/${id}.flac`, duration: 180 }))
  })
  const player = createLibraryPlaybackController({
    createQueue: async (...args) => db.createLibraryQueue(...args),
    getQueue: async (...args) => db.getLibraryQueue(...args),
    readQueue: async (...args) => db.readLibraryQueue(...args),
    editQueue: async (...args) => db.editLibraryQueue(...args),
    deleteQueue: async (...args) => db.deleteLibraryQueue(...args)
  })
  t.after(() => {
    player.dispose()
    db.close()
  })
  await player.create({ sort: 'playlist' }, 'a', 'sequential')
  const f = handoffFixture(t)
  const plays = []
  Object.assign(f.context, {
    libraryPlayback: player,
    libraryTransportIntent: 0,
    originalQueue: shallowRef([]),
    nativeQueueRevisionFence: new NativeQueueRevisionFence(),
    clearCrossfadeTimer: () => {},
    stopVisualizationPolling: () => {},
    persistSelectedTrackSession: () => {},
    getSleepTimerController: () => ({ reportBoundary: async () => false }),
    appSettings: ref({ previousButtonAction: 'previous' }),
    playQueueTrack: (track) => {
      f.context.currentTrack.value = track
      f.context.isLoading.value = false
      f.context.isPlaying.value = true
      plays.push(track.id)
    },
    reportLibraryPlaybackError: (error) => {
      throw error
    }
  })
  f.context.queue.value = []
  f.context.queueIndex.value = -1
  f.context.currentTrack.value = player.track()
  for (const name of [
    'invalidateLibraryTransportIntent',
    'playLibraryWindow',
    'advanceLibraryPlayback',
    'next',
    'previous'
  ])
    vm.runInContext(productionFunction(name), f.context)
  f.context.next()
  f.context.next()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(plays, ['c'])
  assert.equal(player.reference().index, 2)
  f.context.previous()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(plays, ['c', 'b'])
  await f.context.advanceLibraryPlayback(1, false)
  await f.context.advanceLibraryPlayback(1, false)
  assert.deepEqual(plays, ['c', 'b', 'c'])
  assert.equal(f.context.isPlaying.value, false)
  assert.equal(player.reference().index, 2)
  f.context.playMode.value = 'listLoop'
  await f.context.advanceLibraryPlayback(1, false)
  assert.equal(plays.at(-1), 'a')
  assert.equal(player.reference().index, 0)
  assert.equal(f.context.queue.value.length, 0)
  assert.equal(f.context.originalQueue.value.length, 0)
  assert.equal(f.context.queueIndex.value, -1)
})

test('actual query replacement retains bookmark seek and pending shuffle intent without constructing legacy arrays', async (t) => {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: Array.from({ length: 405 }, (_, i) => ({
      id: String(i),
      filePath: 'D:/Music/disc.flac',
      duration: 90,
      cueRange: { startSeconds: i * 90, endSeconds: (i + 1) * 90 }
    }))
  })
  const player = createLibraryPlaybackController({
    createQueue: async (...args) => db.createLibraryQueue(...args),
    getQueue: async (...args) => db.getLibraryQueue(...args),
    readQueue: async (...args) => db.readLibraryQueue(...args),
    editQueue: async (...args) => db.editLibraryQueue(...args),
    deleteQueue: async (...args) => db.deleteLibraryQueue(...args)
  })
  t.after(() => {
    player.dispose()
    db.close()
  })
  const f = handoffFixture(t),
    loads = [],
    modes = []
  Object.assign(f.context, {
    libraryPlayback: player,
    libraryTransportIntent: 0,
    libraryPlayModeIntent: 0,
    requestedLibraryPlayMode: null,
    originalQueue: shallowRef([]),
    nativeQueueLoader: new NativeQueueLoader(),
    nativeQueueRevisionFence: new NativeQueueRevisionFence(),
    castTargetUsn: ref(null),
    rendererPlayModeBoundaryPending: ref(false),
    nativePlaybackActive: false,
    exitHeartModeForManualQueueReplacement() {},
    endPersonalizedStream() {},
    resetPlaybackRuntimeStateForRestore() {
      f.context.nativePlaybackActive = false
    },
    activateCurrentTrack(track, options) {
      f.context.currentTrack.value = track
      f.context.currentTime.value = options.position
    },
    loadAndPlay: async (track, position) =>
      loads.push({ id: track.id, position, range: track.cueRange }),
    persistSelectedTrackSession() {},
    updateSettings: async ({ playMode }) => modes.push(playMode),
    queueNativePlayModeSync: async () => {},
    reportLibraryPlaybackError(error) {
      throw error
    }
  })
  for (const name of [
    'detachLibraryPlayback',
    'invalidateLibraryTransportIntent',
    'playLibraryWindow',
    'playLibraryQuery',
    'playQueueTrack',
    'setPlayModeInternal'
  ])
    vm.runInContext(productionFunction(name), f.context)
  await f.context.playLibraryQuery({ sort: 'playlist' }, '199', { positionSeconds: 12.5 })
  assert.equal(player.snapshot.value.total, 405)
  assert.equal(loads[0].position, 12.5)
  assert.equal(loads[0].range.startSeconds, 199 * 90)
  assert.equal(f.context.currentTime.value, 12.5)
  f.context.requestedLibraryPlayMode = 'shuffle'
  await f.context.playLibraryQuery({ sort: 'playlist' }, '200')
  assert.equal(player.snapshot.value.order, 'shuffle')
  assert.equal(f.context.playMode.value, 'shuffle')
  assert.equal(player.track().id, '200')
  assert.deepEqual(modes, ['shuffle'])
  f.context.playMode.value = 'sequential'
  const random = Math.random
  Math.random = () => 0.8
  try {
    await f.context.playLibraryQuery({ sort: 'playlist' }, undefined, {
      playMode: 'shuffle',
      randomStart: true
    })
  } finally {
    Math.random = random
  }
  assert.equal(player.track().id, '324')
  assert.equal(player.snapshot.value.order, 'shuffle')
  assert.equal(f.context.queue.value.length, 0)
  assert.equal(f.context.originalQueue.value.length, 0)
  assert.equal(f.context.queueIndex.value, -1)
  const failures = [],
    recovered = []
  f.context.reportLibraryPlaybackError = (error) => failures.push(error.message)
  await f.context.playLibraryQuery({ playlistView: 'expired' }, undefined, {
    onQueryFailure: (error) => recovered.push(error.message)
  })
  assert.equal(failures.length, 1)
  assert.match(failures[0], /expired/)
  assert.deepEqual(recovered, failures)
  assert.equal(player.active.value, false)
})

test('drawer production commands select duplicate occurrences, propagate failures and recover cleared queues', async (t) => {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: ['a', 'b', 'c'].map((id) => ({ id, filePath: `D:/Music/${id}.flac`, duration: 180 }))
  })
  const player = createLibraryPlaybackController({
    createQueue: async (...args) => db.createLibraryQueue(...args),
    getQueue: async (...args) => db.getLibraryQueue(...args),
    readQueue: async (...args) => db.readLibraryQueue(...args),
    editQueue: async (...args) => db.editLibraryQueue(...args),
    deleteQueue: async (...args) => db.deleteLibraryQueue(...args)
  })
  t.after(() => {
    player.dispose()
    db.close()
  })
  await player.create({ ids: ['a', 'b', 'a', 'c'], sort: 'playlist' }, 'a', 'sequential')
  const f = handoffFixture(t),
    plays = [],
    prepared = [],
    errors = []
  Object.assign(f.context, {
    libraryPlayback: player,
    libraryTransportIntent: 0,
    originalQueue: shallowRef([]),
    nativePlaybackActive: false,
    nativeQueueRevisionFence: new NativeQueueRevisionFence(),
    clearCrossfadeTimer() {},
    stopVisualizationPolling() {},
    persistSelectedTrackSession() {},
    persistPlaybackSessionAfterQueueMutation() {},
    resetPlaybackRuntimeStateForRestore() {},
    playQueueTrack(track) {
      f.context.currentTrack.value = track
      plays.push(track.queueEntryId)
    },
    playbackSessionController: {
      prepareQueueSelection(track) {
        f.context.currentTrack.value = track
        prepared.push(track?.id)
      }
    },
    reportLibraryPlaybackError: (error) => errors.push(error.message),
    setAudioEngineError: (error) => errors.push(error)
  })
  f.context.queue.value = []
  f.context.queueIndex.value = -1
  f.context.currentTrack.value = player.track()
  for (const name of [
    'invalidateLibraryTransportIntent',
    'playLibraryWindow',
    'applyLibraryQueueEdit',
    'playLibraryQueueEntry',
    'editLibraryQueue'
  ])
    vm.runInContext(productionFunction(name), f.context)
  const original = { ...player.snapshot.value },
    duplicate = (await player.loadPage(0)).items[2]
  await f.context.playLibraryQueueEntry(duplicate.queueEntryId, original)
  assert.deepEqual(plays, [duplicate.queueEntryId])
  assert.equal(f.context.currentTrack.value.queueEntryId, duplicate.queueEntryId)
  await assert.rejects(
    f.context.playLibraryQueueEntry(duplicate.queueEntryId, original),
    /播放队列已变化/
  )
  await assert.rejects(f.context.editLibraryQueue({ kind: 'clear' }, original), /播放队列已变化/)
  assert.equal(player.snapshot.value.total, 4)
  await f.context.editLibraryQueue({ kind: 'clear' }, player.snapshot.value)
  assert.equal(f.context.currentTrack.value, null)
  assert.equal(player.snapshot.value.total, 0)
  assert.equal(player.snapshot.value.selectedEntryId, null)
  await f.context.applyLibraryQueueEdit(() => player.refresh('sequential'), true)
  await f.context.editLibraryQueue({ kind: 'insert', trackIds: ['b'] }, player.snapshot.value)
  assert.deepEqual(prepared, ['b'])
  assert.equal(f.context.currentTrack.value.id, 'b')
  assert.equal(f.context.queue.value.length, 0)
  assert.equal(f.context.queueIndex.value, -1)
  Object.assign(f.context, {
    compactPlaylistRecord,
    getTrackSource,
    LIBRARY_PAGE_SIZE,
    appendArrayQueueTracks() {
      throw new Error('legacy array append')
    }
  })
  for (const name of [
    'queueInsertItems',
    'appendLibraryQueuePages',
    'appendLibraryTracks',
    'appendQueueTracksAsync'
  ])
    vm.runInContext(productionFunction(name), f.context)
  const local = { id: 'a', source: 'local' }
  const remote = {
    id: 'ncm:77',
    source: 'ncm',
    filePath: 'ncm:77',
    title: '远程',
    artist: '艺人',
    album: '专辑',
    lyrics: 'heavy lyrics'
  }
  const tracks = Array.from({ length: 1105 }, (_, index) => (index === 1001 ? remote : local))
  await f.context.appendQueueTracksAsync(tracks)
  assert.equal(player.snapshot.value.total, 1106)
  const page = db.readLibraryQueue(player.snapshot.value.id, 1000, 5)
  assert.equal(page.items[2].track.id, 'ncm:77')
  assert.equal(page.items[2].track.lyrics, null)
  assert.equal(f.context.queue.value.length, 0)
  assert.equal(plays.length, 1, 'batch append must not start playback')
  f.context.libraryPlayback = {
    ...player,
    appendPages: async () => {
      throw new Error('reply lost')
    }
  }
  await assert.rejects(f.context.appendQueueTracksAsync([local]), /reply lost/)
  assert.match(errors.at(-1), /reply lost/)
})
