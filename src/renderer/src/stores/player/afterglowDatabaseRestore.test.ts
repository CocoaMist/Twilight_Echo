import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { ref, shallowRef } from 'vue'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import { createLibraryPlaybackController } from './libraryPlaybackController.ts'
import { NativeQueueLoader } from '../../utils/nativeQueueLoader.ts'
import { NativeQueueRevisionFence } from '../../utils/nativeQueueRevision.ts'
import { toPlaybackQueueSnapshots } from '../../utils/playbackQueueVirtualization.ts'
import type { LibraryQueueApi } from './libraryQueueSource.ts'
import type { AfterglowRestoreState } from '../../../../shared/afterglowMode.ts'
import type { Track } from '../../types/music'
import { libraryQueueResumeMode } from '../../../../shared/libraryDatabase.ts'

const source = readFileSync(new URL('../usePlayerStore.ts', import.meta.url), 'utf8')
const file = ts.createSourceFile('player.ts', source, ts.ScriptTarget.Latest, true)
function declaration(name: string): string {
  let result: ts.FunctionDeclaration | undefined
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(result, name)
  return result.getText(file)
}
const implementation = ts.transpileModule(
  `${declaration('detachLibraryPlayback')}\n${declaration('adoptAfterglowRestore')}`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function fixture(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    exclusions: [],
    folders: [],
    tracks: [
      {
        id: 'cue',
        title: 'Same recording',
        artist: 'Artist',
        album: 'Album',
        filePath: 'D:/Music/disc.flac',
        duration: 90,
        cueRange: { startSeconds: 90, endSeconds: 180 },
        cueSheetPath: 'D:/Music/disc.cue',
        cueEncoding: 'gb18030'
      }
    ]
  })
  let queue = db.createLibraryQueue({
    ids: Array.from({ length: 605 }, () => 'cue'),
    sort: 'playlist'
  })
  const entry = (index: number) => db.readLibraryQueue(queue.id, index, 1).items[0]
  queue = db.editLibraryQueue(queue.id, queue.revision, {
    kind: 'select',
    entryId: entry(400).queueEntryId
  }).queue
  const edits: string[] = [],
    reads: number[] = [],
    references: string[][] = []
  const api: LibraryQueueApi = {
    createQueue: async (...args) => db.createLibraryQueue(...args),
    getQueue: async (...args) => db.getLibraryQueue(...args),
    readQueue: async (...args) => {
      reads.push(args[1] ?? 0)
      return db.readLibraryQueue(...args)
    },
    editQueue: async (...args) => {
      edits.push(args[2].kind)
      return db.editLibraryQueue(...args)
    },
    deleteQueue: async (...args) => db.deleteLibraryQueue(...args),
    syncQueueReferences: async (_owner, ids) => {
      references.push([...ids])
    }
  }
  const libraryPlayback = createLibraryPlaybackController(api)
  const loader = new NativeQueueLoader()
  const nativeEntries = [399, 400, 401].map((index) => ({
    id: 'cue',
    queueEntryId: entry(index).queueEntryId,
    index
  }))
  const state: AfterglowRestoreState = {
    queueToken: 'uninterrupted-native-token',
    queue: [],
    queueIndex: 400,
    queueLength: 605,
    libraryQueue: {
      id: queue.id,
      revision: queue.revision,
      index: 400,
      entryId: entry(400).queueEntryId
    },
    track: {
      ...entry(400).track,
      queueEntryId: entry(400).queueEntryId,
      streamUrl: 'D:/Music/disc.flac'
    },
    nativeQueueIndices: [399, 400, 401],
    nativeQueueEntries: nativeEntries,
    state: 'playing',
    position: 51.25,
    duration: 90,
    volume: 0.7,
    playbackRate: 1.25,
    playMode: 'listLoop'
  }
  const context = {
    libraryPlayback,
    nativeQueueLoader: loader,
    nativeQueueRevisionFence: new NativeQueueRevisionFence(),
    nativeSourceToTrackId: new Map(),
    toPlaybackQueueSnapshots,
    queue: shallowRef<Track[]>([]),
    originalQueue: shallowRef<Track[]>([]),
    queueIndex: ref(-1),
    currentTrack: shallowRef<Track | null>(null),
    lastActiveTrack: null as Track | null,
    loadedTrackId: '',
    duration: ref(0),
    currentTime: ref(0),
    isPlaying: ref(false),
    isLoading: ref(false),
    volume: ref(0.5),
    playbackRate: ref(1),
    playMode: ref('sequential'),
    appSettings: ref({ audioDeviceProfiles: { volumeCeiling: 1 } }),
    rendererPlayModeBoundaryPending: ref(true),
    activeLoadToken: 0,
    libraryTransportIntent: 0,
    libraryPlayModeIntent: 0,
    requestedLibraryPlayMode: null,
    restoredPlaybackPending: true,
    restoredPlaybackPosition: 0,
    pendingLoadStartTime: 0,
    autoAdvanceInFlight: false,
    advancingFromEndedTrackId: '',
    nativePlaybackActive: false,
    nativeQueueAdoptionUncertain: false,
    nativeQueueDelegated: false,
    adoptedAfterglowRestore: false,
    errors: [] as string[],
    setAudioEngineError: (message: string) => context.errors.push(message),
    hydratePlaybackTrack: (track: Track) => ({ ...track }),
    hydrateActiveTrackFromDatabase: () => {},
    cueDuration: (track: Track) => track.duration,
    setCurrentTimeImmediate: (position: number) => {
      context.currentTime.value = position
    },
    normalizeAdoptedPlayMode: (mode: string) => mode,
    clearNativePlaybackInfoIntent: () => {},
    clearPlaybackToggleIntent: () => {},
    resetPlaybackClock: () => {},
    stopVisualizationPolling: () => {},
    stopRendererAudio: () => {},
    startRendererPlaybackClock: () => {},
    lyricsLoader: { ensureCurrentTrackLyricsLoaded: async () => {} },
    // Any accidental transport call fails instead of being counted as a successful adoption.
    window: {
      api: {
        audioEngine: new Proxy(
          {},
          {
            get: (_target, key) => {
              throw new Error(`adoption issued native transport ${String(key)}`)
            }
          }
        )
      }
    }
  }
  const sandbox = vm.createContext(context)
  vm.runInContext(implementation, sandbox)
  const adopt = sandbox.adoptAfterglowRestore as (state: AfterglowRestoreState) => Promise<void>
  t.after(() => {
    libraryPlayback.dispose()
    db.close()
  })
  return {
    db,
    queue,
    api,
    libraryPlayback,
    loader,
    state,
    context,
    adopt,
    entry,
    edits,
    reads,
    references
  }
}

test('production live restore adopts the SQL source, token and exact deep CUE occurrence without transport or cursor edits', async (t) => {
  const f = fixture(t)
  await f.adopt(f.state)
  assert.deepEqual(plain(f.context.queue.value), [])
  assert.deepEqual(plain(f.context.originalQueue.value), [])
  assert.equal(f.context.queueIndex.value, -1)
  assert.equal(f.context.currentTrack.value?.queueEntryId, f.entry(400).queueEntryId)
  assert.deepEqual(plain(f.context.currentTrack.value?.cueRange), {
    startSeconds: 90,
    endSeconds: 180
  })
  assert.equal(f.context.currentTrack.value?.cueEncoding, 'gb18030')
  assert.equal(f.context.currentTime.value, 51.25)
  assert.equal(f.context.playbackRate.value, 1.25)
  assert.equal(f.context.playMode.value, 'listLoop')
  assert.equal(f.context.isPlaying.value, true)
  assert.equal(f.context.adoptedAfterglowRestore, true)
  assert.equal(f.context.nativeQueueDelegated, false)
  assert.deepEqual(f.libraryPlayback.reference(), f.state.libraryQueue)
  assert.ok(f.libraryPlayback.diagnostics.cachedTracks <= 400)
  assert.deepEqual(f.edits, [], 'live restore must not select/reorder/skip a cursor')
  assert.deepEqual(
    f.loader.findLibraryEntry({ queueToken: f.state.queueToken, queueIndex: 2 }, f.queue),
    f.state.nativeQueueEntries![2]
  )
  assert.equal(f.loader.findLogicalIndex({ queueToken: f.state.queueToken, queueIndex: 1 }, []), -1)
  assert.equal(f.loader.findLibraryEntry({ queueToken: 'wrong', queueIndex: 1 }, f.queue), null)
  assert.ok(
    f.references.some((ids) => ids[0] === f.queue.id),
    'renderer owns its reference before acknowledging main'
  )
  const next = await f.libraryPlayback.acceptNative(f.entry(401).queueEntryId, f.queue, 'listLoop')
  assert.ok(next)
  assert.equal(f.loader.rebaseLibraryCursor(f.queue, next.queue), true)
  assert.equal(f.libraryPlayback.reference()?.index, 401)
})

test('a stale live reference is rejected rather than applying crash-resume cursor or order rules', async (t) => {
  const f = fixture(t)
  f.db.editLibraryQueue(f.queue.id, f.queue.revision, {
    kind: 'select',
    entryId: f.entry(401).queueEntryId
  })
  await assert.rejects(f.adopt(f.state), /变化/)
  assert.equal(f.libraryPlayback.active.value, false)
  assert.equal(f.context.adoptedAfterglowRestore, false)
  assert.equal(f.context.currentTrack.value, null)
  assert.deepEqual(f.edits, [])
})

test('production crash-session restoration returns the SQL mode and never lets stale session/settings reorder the queue', async (t) => {
  const f = fixture(t)
  const queue = f.db.editLibraryQueue(f.queue.id, f.queue.revision, {
    kind: 'mode',
    mode: 'shuffle'
  }).queue
  const context = vm.createContext({ ...f.context, libraryQueueResumeMode })
  vm.runInContext(
    ts.transpileModule(
      `${declaration('restoreLibraryQueueReference')}\n${declaration('restoreLibraryQueueSession')}`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
    ).outputText,
    context
  )
  const result = await context.restoreLibraryQueueSession(
    { libraryQueue: f.state.libraryQueue, playMode: 'repeat' },
    () => true
  )
  assert.equal(result.playMode, 'shuffle')
  assert.equal(context.playMode.value, 'shuffle')
  assert.equal(result.reference.revision, queue.revision)
  assert.equal(result.reference.index, 0)
  assert.equal(result.reference.entryId, f.state.libraryQueue!.entryId)
  assert.deepEqual(f.db.getLibraryQueue(queue.id), queue)
  assert.deepEqual(f.edits, [])
  assert.deepEqual(plain(context.queue.value), [])
  assert.deepEqual(plain(context.originalQueue.value), [])
  assert.equal(context.queueIndex.value, -1)
  assert.equal(context.rendererPlayModeBoundaryPending.value, false)
})

test('production explicit refresh recovers a lost mode acknowledgement before persisting or rebuilding the native window', async (t) => {
  const f = fixture(t)
  await f.libraryPlayback.restore(f.state.libraryQueue!, 'listLoop', () => true)
  f.context.currentTrack.value = f.libraryPlayback.track()
  f.context.playMode.value = 'listLoop'
  const edit = f.api.editQueue
  f.api.editQueue = async (...args) => {
    await edit(...args)
    throw new Error('lost renderer mode ACK')
  }
  await assert.rejects(
    f.libraryPlayback.edit({ kind: 'mode', mode: 'repeat' }, 'repeat'),
    /lost.*ACK/
  )
  assert.equal(f.libraryPlayback.diagnostics.requiresRefresh, true)
  assert.equal(f.context.playMode.value, 'listLoop')
  const persisted: string[] = []
  const context = vm.createContext({
    ...f.context,
    persistSelectedTrackSession: () => persisted.push(f.context.playMode.value),
    setAudioEngineError: (message: string) => assert.fail(message)
  })
  vm.runInContext(
    ts.transpileModule(declaration('applyLibraryQueueEdit'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText,
    context
  )
  await context.applyLibraryQueueEdit(() => f.libraryPlayback.refresh('listLoop'), true)
  assert.equal(f.context.playMode.value, 'repeat')
  assert.equal(f.libraryPlayback.window.value?.items.length, 1)
  assert.equal(f.libraryPlayback.diagnostics.requiresRefresh, false)
  assert.deepEqual(persisted, ['repeat'])
  assert.deepEqual(
    f.edits,
    ['mode'],
    'refresh reads the outcome rather than replaying the mode edit'
  )
  assert.deepEqual(plain(f.context.queue.value), [])
})

test('missing current tracks and malformed native mappings never skip to another song', async (t) => {
  const f = fixture(t)
  await assert.rejects(
    f.adopt({
      ...f.state,
      nativeQueueEntries: [
        { ...f.state.nativeQueueEntries![0], index: 400 },
        ...f.state.nativeQueueEntries!.slice(1)
      ]
    }),
    /映射/
  )
  f.db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [] })
  await assert.rejects(f.adopt(f.state), /无法读取/)
  assert.deepEqual(f.edits, [])
  assert.equal(f.db.getLibraryQueue(f.queue.id).index, 400)
  assert.equal(f.context.currentTrack.value, null)
})

test('user playback intent during the live SQL read fences late adoption', async (t) => {
  const f = fixture(t)
  let release!: () => void, started!: () => void
  const held = new Promise<void>((done) => {
    release = done
  })
  const entering = new Promise<void>((done) => {
    started = done
  })
  const get = f.api.getQueue
  f.api.getQueue = async (...args) => {
    started()
    await held
    return get(...args)
  }
  const adopting = f.adopt(f.state)
  await entering
  f.context.activeLoadToken++
  f.context.libraryTransportIntent++
  release()
  await assert.rejects(adopting, /取消/)
  assert.equal(f.libraryPlayback.active.value, false)
  assert.equal(f.context.currentTrack.value, null)
  assert.equal(f.context.adoptedAfterglowRestore, false)
  assert.deepEqual(f.edits, [])
})

test('legacy arrays still adopt synchronously and do not require database references', async (t) => {
  const f = fixture(t)
  const track = { ...f.entry(400).track, queueEntryId: 'legacy-occurrence' } as unknown as Track
  const adopting = f.adopt({
    ...f.state,
    libraryQueue: undefined,
    track: undefined,
    nativeQueueEntries: undefined,
    queue: [track],
    queueIndex: 0,
    queueLength: 1,
    nativeQueueIndices: [0]
  })
  assert.equal(f.context.currentTrack.value?.queueEntryId, 'legacy-occurrence')
  assert.equal(f.context.queue.value.length, 1)
  assert.equal(f.context.queueIndex.value, 0)
  assert.equal(f.context.adoptedAfterglowRestore, true)
  assert.equal(f.libraryPlayback.active.value, false)
  await adopting
  assert.deepEqual(f.reads, [])
  assert.deepEqual(f.edits, [])
})

const stoppedState = (state: AfterglowRestoreState): AfterglowRestoreState => ({
  ...state,
  recovery: 'native-queue-unknown',
  queueToken: '',
  nativeQueueIndices: [],
  nativeQueueEntries: [],
  state: 'stopped',
  position: 0
})

test('production stopped recovery retains the deep SQL selection but never adopts uncertain native authority', async (t) => {
  const f = fixture(t)
  await f.adopt(stoppedState(f.state))
  assert.equal(f.context.isPlaying.value, false)
  assert.equal(f.context.loadedTrackId, '')
  assert.equal(f.context.lastActiveTrack, null, 'recovery is not a playback-history start')
  assert.equal(f.context.nativePlaybackActive, false)
  assert.equal(f.context.nativeQueueAdoptionUncertain, true)
  assert.equal(f.context.nativeQueueDelegated, false)
  assert.equal(f.context.restoredPlaybackPending, true)
  assert.equal(f.context.currentTime.value, 0)
  assert.equal(f.context.currentTrack.value?.queueEntryId, f.entry(400).queueEntryId)
  assert.equal(f.context.currentTrack.value?.streamUrl, undefined)
  assert.deepEqual(f.libraryPlayback.reference(), f.state.libraryQueue)
  assert.deepEqual(f.edits, [])
  assert.deepEqual(plain(f.context.queue.value), [])
  assert.equal(f.loader.getCommittedIndices(), null)
  assert.match(f.context.errors[0], /已停止播放.*点击播放/)

  const plays: Array<{ track: Track; position: number }> = []
  Object.assign(f.context, {
    playerSleepTimer: { interruptShutdown: () => {} },
    loadAndPlay: async (track: Track, position: number) => {
      plays.push({ track, position })
    }
  })
  const code = ts.transpileModule(declaration('togglePlayState'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  vm.runInContext(code, f.context)
  await (f.context as unknown as { togglePlayState(): Promise<void> }).togglePlayState()
  assert.equal(plays.length, 1)
  assert.equal(plays[0].track.queueEntryId, f.entry(400).queueEntryId)
  assert.equal(plays[0].position, 0)
})

test('stopped recovery keeps a selected hole and the full queue without silently selecting a replacement', async (t) => {
  const f = fixture(t)
  f.db.replaceDocument({ version: 2, revision: 0, tracks: [], folders: [], exclusions: [] })
  await f.adopt({ ...stoppedState(f.state), track: null })
  assert.equal(f.context.currentTrack.value, null)
  assert.equal(f.context.adoptedAfterglowRestore, true)
  assert.equal(f.libraryPlayback.active.value, true)
  assert.deepEqual(f.libraryPlayback.reference(), f.state.libraryQueue)
  assert.equal(f.libraryPlayback.snapshot.value?.total, 605)
  assert.deepEqual(f.edits, [])
  assert.match(f.context.errors[0], /选择可用歌曲/)
})

test('stopped recovery accepts an empty SQL result without replaying the old selection', async (t) => {
  const f = fixture(t)
  await f.adopt({
    ...stoppedState(f.state),
    libraryQueue: undefined,
    queueLength: 0,
    queueIndex: -1,
    track: null
  })
  assert.equal(f.context.currentTrack.value, null)
  assert.equal(f.context.isPlaying.value, false)
  assert.equal(f.context.adoptedAfterglowRestore, true)
  assert.deepEqual(f.reads, [])
})

test('malformed stopped recovery cannot impersonate live playback or carry a native mapping', async (t) => {
  for (const patch of [
    { state: 'playing' },
    { queueToken: 'uncertain' },
    { nativeQueueIndices: [400] },
    { position: 5 },
    { queue: [{}] }
  ]) {
    const f = fixture(t)
    await assert.rejects(
      f.adopt({ ...stoppedState(f.state), ...patch } as AfterglowRestoreState),
      /状态无效/
    )
    assert.equal(f.context.currentTrack.value, null)
    assert.deepEqual(f.reads, [])
  }
})

test('a user selection during stopped recovery fences its late SQL attachment', async (t) => {
  const f = fixture(t)
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const entering = new Promise<void>((resolve) => {
    entered = resolve
  })
  const read = f.api.readQueue
  f.api.readQueue = async (...args) => {
    entered()
    await held
    return read(...args)
  }
  const adopting = f.adopt(stoppedState(f.state))
  const rejected = assert.rejects(adopting, /取消/)
  await entering
  f.context.activeLoadToken++
  release()
  await rejected
  assert.equal(f.libraryPlayback.active.value, false)
  assert.equal(f.context.currentTrack.value, null)
  assert.deepEqual(f.edits, [])
})

test('production startup acknowledges only a successful live adoption and never replays a saved session on failure', async () => {
  const app = readFileSync(new URL('../../App.vue', import.meta.url), 'utf8')
  const start = app.indexOf('  const afterglowRestoreRequested =')
  const end = app.indexOf('  // Run independent startup operations', start)
  assert.ok(start >= 0 && end > start)
  const code = ts.transpileModule(
    `globalThis.setup = (async () => { ${app.slice(start, end)}; await playbackSessionSetupPromise })()`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText
  for (const failure of ['none', 'state', 'adopt', 'persistence']) {
    const calls: string[] = []
    let release!: () => void
    const held = new Promise<void>((done) => {
      release = done
    })
    const context = vm.createContext({
      window: {
        location: { search: '?afterglowRestore=1' },
        api: {
          app: {
            afterglow: {
              getRestoreState: async () => (failure === 'state' ? null : { queueToken: 'live' }),
              rendererAdoptComplete: async () => {
                calls.push('ack')
              }
            },
            onSavePlaybackSession: () => () => {}
          }
        }
      },
      isAfterglowRendererRestore: () => true,
      adoptAfterglowRestore: async () => {
        calls.push('adopt-start')
        await held
        if (failure === 'adopt') throw new Error('adoption failed')
        calls.push('adopted')
      },
      playbackSessionPersistence: {
        adoptLivePlaybackSession: async () => {
          calls.push('revision-sync')
          if (failure === 'persistence') throw new Error('store unavailable')
        },
        restoreSavedPlaybackSession: async () => {
          calls.push('replay')
        },
        startAutosaveWatchers: () => {
          calls.push('watch')
        }
      },
      reportStartupDataError: () => {
        calls.push('error')
      },
      removePlaybackSessionSaveListener: null,
      loadedSettings: { playbackResumeMode: 'trackAndPosition' }
    })
    vm.runInContext(code, context)
    await new Promise<void>((done) => setImmediate(done))
    assert.equal(
      calls.includes('ack'),
      false,
      'the SQL read/adoption must settle before acknowledgement'
    )
    release()
    await context.setup
    assert.equal(calls.includes('replay'), false)
    assert.equal(calls.includes('ack'), failure === 'none' || failure === 'persistence')
    assert.equal(calls.includes('watch'), failure === 'none' || failure === 'persistence')
    if (calls.includes('ack')) assert.ok(calls.indexOf('ack') > calls.indexOf('adopted'))
  }
})
