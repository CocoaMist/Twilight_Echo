import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { ref, shallowRef } from 'vue'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import { createLibraryPlaybackController } from './libraryPlaybackController.ts'
import { createLibraryArrayQueueSeed } from './libraryArrayQueueSeed.ts'
import { NativeQueueLoader } from '../../utils/nativeQueueLoader.ts'
import { NativeQueueRevisionFence } from '../../utils/nativeQueueRevision.ts'
import { preparePlayerNativeQueue } from '../../utils/nativeQueuePreparation.ts'
import { libraryNativeQueueOptions } from '../../utils/libraryQueuePlayback.ts'
import { toPlaybackQueueSnapshots } from '../../utils/playbackQueueVirtualization.ts'
import type { Track } from '../../types/music'
import type { PlayMode } from '../../types/settings'
import type { NativeQueueCommit, NativeQueueRebind } from '../../../../shared/nativeQueue.ts'
import type { LibraryQueuePageProducer } from './libraryPlaybackController.ts'

const source = readFileSync(new URL('../usePlayerStore.ts', import.meta.url), 'utf8')
const file = ts.createSourceFile('store.ts', source, ts.ScriptTarget.Latest, true)
const implementation = ts.transpileModule(
  ['appendLibraryQueuePages', 'stageLibraryQueuePages', 'detachLibraryPlayback']
    .map((name) => {
      const declaration = file.statements.find(
        (node): node is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(node) && node.name?.text === name
      )
      assert.ok(declaration)
      return declaration.getText(file)
    })
    .join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function fixture(
  t: test.TestContext,
  options: { native?: boolean; empty?: boolean; mode?: PlayMode; count?: number } = {}
) {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    tracks: [{ id: 'suffix', filePath: 'D:/Music/suffix.flac', title: 'Suffix', duration: 180 }],
    folders: [],
    exclusions: []
  })
  const builds: number[] = [],
    deleted: string[] = []
  const libraryPlayback = createLibraryPlaybackController({
    buildQueue: async (input) => {
      if (input.kind === 'append') builds.push(input.items.length)
      return db.buildLibraryQueue(input)
    },
    createQueue: async (...args) => db.createLibraryQueue(...args),
    getQueue: async (...args) => db.getLibraryQueue(...args),
    readQueue: async (...args) => db.readLibraryQueue(...args),
    editQueue: async (...args) => db.editLibraryQueue(...args),
    deleteQueue: async (...args) => {
      deleted.push(args[0])
      db.deleteLibraryQueue(...args)
    }
  })
  const original = toPlaybackQueueSnapshots(
    options.empty
      ? []
      : Array.from(
          { length: options.count ?? 405 },
          (_, index) =>
            ({
              id: 'temporary-local',
              source: 'local',
              title: `Occurrence ${index}`,
              filePath: 'D:/Temporary/disc.flac',
              fileName: 'disc.flac',
              artist: 'Artist',
              album: 'Album',
              duration: 90,
              size: 100,
              lyrics: null,
              cueRange: { startSeconds: index * 90, endSeconds: (index + 1) * 90 },
              cueSheetPath: 'D:/Temporary/disc.cue',
              cueEncoding: 'gb18030',
              streamUrl: 'twilight-media://temporary/transient'
            }) as Track
        )
  )
  const mode = options.mode ?? 'shuffle'
  const rows =
    mode === 'shuffle' && original.length > 2
      ? [...original.slice(200), ...original.slice(0, 200)]
      : [...original]
  const index = rows.length ? Math.min(199, rows.length - 1) : -1
  const current = rows[index]
    ? { ...rows[index], lyrics: 'live lyrics', streamUrl: rows[index].filePath }
    : null
  const loader = new NativeQueueLoader(),
    fence = new NativeQueueRevisionFence()
  const requests: NativeQueueRebind[] = [],
    errors: string[] = []
  let saves = 0,
    metadataReads = 0
  const boundary = { isAudioFileAuthorized: async () => true }
  const native = options.native !== false && !!current
  if (current && native) {
    const prepared = await preparePlayerNativeQueue(
      {
        queue: rows,
        currentTrack: current,
        currentTarget: current.filePath,
        currentIndex: index,
        playMode: mode
      },
      boundary
    )
    assert.ok(prepared)
    await loader.loadPrepared(prepared, { loadQueue: async () => ({ queueToken: 'old' }) }, rows)
  }
  const context = {
    libraryPlayback,
    nativeQueueLoader: loader,
    nativeQueueRevisionFence: fence,
    createLibraryArrayQueueSeed,
    libraryNativeQueueOptions,
    preparePlayerNativeQueue,
    queue: shallowRef(rows),
    originalQueue: shallowRef(original),
    queueIndex: ref(index),
    currentTrack: ref<Track | null>(current),
    lastActiveTrack: current,
    playMode: ref<PlayMode>(mode),
    isPlaying: ref(true),
    isLoading: ref(false),
    currentTime: ref(42.5),
    duration: ref(90),
    castTargetUsn: ref<string | null>(null),
    rendererPlayModeBoundaryPending: ref(false),
    activeLoadToken: 1,
    activeLoadCompletion: null as Promise<void> | null,
    libraryTransportIntent: 1,
    libraryPlayModeIntent: 1,
    requestedLibraryPlayMode: null,
    nativePlaybackActive: native,
    nativeQueueDelegated: native,
    nativeQueueAdoptionUncertain: false,
    intentionalTrackGuard: null,
    clearNativePlaybackInfoIntent: () => {},
    playbackAudio: { src: 'blob:existing-player' },
    clearRendererPlaybackWatchdog: () => {},
    scheduleRendererPlaybackWatchdog: (track: Track, token: number) => {
      assert.equal(track.queueEntryId, libraryPlayback.reference()?.entryId)
      assert.equal(token, context.activeLoadToken)
    },
    exitHeartModeForManualQueueReplacement: () => {
      if (context.playMode.value === 'heart') context.playMode.value = 'sequential'
    },
    endPersonalizedStream: () => {},
    persistSelectedTrackSession: () => {
      saves++
    },
    setAudioEngineError: (error: string) => {
      errors.push(error)
    },
    getTrackAudioSource: (track: Track) =>
      track.cueRange ? track.filePath : track.streamUrl || track.filePath,
    playbackQueueController: { commands: { revision: ref(0) } },
    playbackSessionController: {
      prepareQueueSelection: (track: Track | null) => {
        context.currentTrack.value = track
        context.isPlaying.value = false
        context.currentTime.value = 0
      }
    },
    window: {
      api: {
        library: {
          database: {
            getMetadata: async () => {
              metadataReads++
              return db.getMetadata()
            }
          }
        },
        fs: boundary,
        audioEngine: {
          getPlaybackInfo: async () => ({
            queueToken: 'old',
            queueIndex: index,
            source: current!.filePath
          }),
          rebindQueue: async (request: NativeQueueRebind): Promise<NativeQueueCommit | null> => {
            requests.push(request)
            return { queueToken: 'new' }
          }
        }
      }
    }
  }
  const sandbox = vm.createContext(context)
  const append = vm.runInContext(`${implementation}\nappendLibraryQueuePages`, sandbox) as (
    produce: LibraryQueuePageProducer,
    rethrow?: boolean,
    options?: { signal?: AbortSignal; guard?: () => void }
  ) => Promise<void>
  const detach = vm.runInContext('detachLibraryPlayback', sandbox) as () => void
  t.after(() => {
    libraryPlayback.dispose()
    db.close()
  })
  return {
    db,
    context,
    append,
    detach,
    original,
    rows,
    requests,
    builds,
    deleted,
    errors,
    get saves() {
      return saves
    },
    get metadataReads() {
      return metadataReads
    }
  }
}

test('production append converts duplicate CUE arrays with bounded pages and a conditional native handoff, preserving playing/paused state', async (t) => {
  for (const playing of [true, false]) {
    const f = await fixture(t)
    f.context.isPlaying.value = playing
    const current = f.context.currentTrack.value!
    await f.append(async (append) => {
      await append([{ id: 'suffix' }])
    })
    const reference = f.context.libraryPlayback.reference()!
    assert.equal(reference.index, 199)
    assert.equal(f.context.libraryPlayback.snapshot.value?.total, 406)
    assert.equal(f.context.isPlaying.value, playing)
    assert.equal(f.context.currentTime.value, 42.5)
    assert.equal(f.context.duration.value, 90)
    assert.equal(f.context.currentTrack.value?.lyrics, 'live lyrics')
    assert.equal(f.context.currentTrack.value?.streamUrl, current.streamUrl)
    assert.deepEqual(f.context.currentTrack.value?.cueRange, current.cueRange)
    assert.notEqual(f.context.currentTrack.value?.queueEntryId, current.queueEntryId)
    assert.equal(f.context.queue.value.length, 0)
    assert.equal(f.context.originalQueue.value.length, 0)
    assert.equal(f.context.queueIndex.value, -1)
    assert.deepEqual(f.builds, [200, 200, 5, 1])
    assert.equal(f.requests.length, 1)
    assert.equal(f.requests[0].items.length, 2)
    assert.equal(f.requests[0].expected.index, 199)
    assert.equal(f.requests[0].expected.queueToken, 'old')
    assert.equal(f.requests[0].playMode, 'sequential')
    assert.equal(f.requests[0].items[0].queueEntryId, reference.entryId)
    assert.deepEqual(f.requests[0].items[0].cueRange, current.cueRange)
    assert.equal(f.context.nativeQueueAdoptionUncertain, false)
    assert.equal(f.context.nativeQueueDelegated, false)
    assert.equal(f.saves, 1)
    assert.equal(f.deleted.length, 0)
    const selected = f.db.readLibraryQueue(reference.id, 199, 1).items[0]
    assert.equal(selected.track?.streamUrl, undefined)
    assert.equal(selected.track?.cueEncoding, 'gb18030')
    const restored = f.db.editLibraryQueue(reference.id, reference.revision, {
      kind: 'order',
      order: 'original'
    })
    const originalRows = [0, 200, 400].flatMap(
      (offset) => f.db.readLibraryQueue(reference.id, offset).items
    )
    assert.deepEqual(
      originalRows.slice(0, 405).map((item) => item.track?.title),
      f.original.map((item) => item.title)
    )
    assert.equal(originalRows.at(-1)?.track?.id, 'suffix')
    assert.equal(restored.queue.total, 406)
  }
})

test('empty and renderer-only sources adopt without a native transport command; empty insertion selects a paused row', async (t) => {
  for (const empty of [true, false]) {
    const f = await fixture(t, { native: false, empty })
    await f.append(async (append) => {
      await append([{ id: 'suffix' }])
    })
    assert.equal(f.requests.length, 0)
    assert.equal(f.context.libraryPlayback.active.value, true)
    assert.equal(f.context.currentTrack.value?.id, empty ? 'suffix' : 'temporary-local')
    assert.equal(f.context.isPlaying.value, !empty)
    assert.equal(f.context.currentTime.value, empty ? 0 : 42.5)
  }
})

test('the current load settles before seed capture, without rejecting loading playback or invalidating its occurrence', async (t) => {
  const f = await fixture(t)
  const load = deferred<void>()
  f.context.activeLoadCompletion = load.promise
  f.context.isLoading.value = true
  const oldOccurrence = f.context.currentTrack.value!.queueEntryId
  const request = f.append(async (append) => {
    await append([{ id: 'suffix' }])
  })
  await tick()
  assert.equal(f.metadataReads, 0)
  assert.equal(f.context.currentTrack.value!.queueEntryId, oldOccurrence)
  f.context.isLoading.value = false
  f.context.currentTrack.value!.lyrics = 'finished load'
  f.context.activeLoadCompletion = null
  load.resolve()
  await request
  assert.equal(f.context.libraryPlayback.active.value, true)
  assert.equal(f.context.currentTrack.value!.lyrics, 'finished load')
})

test('explicit native refusal and unsupported engine retain the exact old arrays and mapping; no LoadQueue fallback', async (t) => {
  for (const unsupported of [false, true]) {
    const f = await fixture(t)
    f.context.window.api.audioEngine.rebindQueue = unsupported ? undefined! : async () => null
    await assert.rejects(
      f.append(async (append) => {
        await append([{ id: 'suffix' }])
      }),
      /未接管/
    )
    assert.equal(f.context.queue.value, f.rows)
    assert.equal(f.context.originalQueue.value, f.original)
    assert.equal(f.context.libraryPlayback.active.value, false)
    assert.equal(f.context.currentTime.value, 42.5)
    assert.equal(f.context.isPlaying.value, true)
    assert.equal(f.context.nativeQueueAdoptionUncertain, false)
    assert.equal(
      f.context.nativeQueueLoader.findLogicalIndex({ queueToken: 'old', queueIndex: 199 }, f.rows),
      199
    )
    assert.equal(f.deleted.length, 1)
    assert.equal(f.saves, 0)
  }
})

test('unknown native outcome retains the SQL seed, revokes mapping and blocks automatic events without replay or rollback', async (t) => {
  const f = await fixture(t)
  let attempts = 0
  f.context.window.api.audioEngine.rebindQueue = async () => {
    attempts++
    throw new Error('lost reply')
  }
  await assert.rejects(
    f.append(async (append) => {
      await append([{ id: 'suffix' }])
    }),
    /结果未知/
  )
  assert.equal(attempts, 1)
  assert.equal(f.deleted.length, 0)
  assert.equal(f.context.queue.value, f.rows)
  assert.equal(f.context.libraryPlayback.active.value, false)
  assert.equal(f.context.nativeQueueAdoptionUncertain, true)
  assert.equal(f.context.nativeQueueDelegated, false)
  assert.equal(
    f.context.nativeQueueLoader.findLogicalIndex({ queueToken: 'old', queueIndex: 199 }, f.rows),
    -1
  )
  assert.equal(f.context.isPlaying.value, true)
  assert.equal(f.context.currentTime.value, 42.5)
})

test('cancellation after confirmed native commit retains the referenced seed instead of deleting it or publishing a cancelled source', async (t) => {
  const f = await fixture(t)
  const abort = new AbortController()
  f.context.window.api.audioEngine.rebindQueue = async () => {
    abort.abort()
    return { queueToken: 'new' }
  }
  await assert.rejects(
    f.append(
      async (append) => {
        await append([{ id: 'suffix' }])
      },
      true,
      { signal: abort.signal }
    ),
    /取消/
  )
  assert.equal(f.deleted.length, 0)
  assert.equal(f.context.libraryPlayback.active.value, false)
  assert.equal(f.context.queue.value, f.rows)
  assert.equal(f.context.nativeQueueAdoptionUncertain, true)
  assert.equal(f.context.nativeQueueLoader.getLibraryQueueReference(), null)
})

test('source/queue/mode changes while streaming leave the old source intact and never issue native handoff', async (t) => {
  for (const change of ['source', 'queue', 'mode', 'load'] as const) {
    const f = await fixture(t)
    await assert.rejects(
      f.append(async (append) => {
        await append([{ id: 'suffix' }])
        if (change === 'source') f.detach()
        if (change === 'queue') f.context.playbackQueueController.commands.revision.value++
        if (change === 'mode') f.context.playMode.value = 'repeat'
        if (change === 'load') f.context.activeLoadToken++
      }),
      /变化|中断/
    )
    assert.equal(f.requests.length, 0)
    assert.equal(f.context.queue.value, f.rows)
    assert.equal(f.context.libraryPlayback.active.value, false)
    // Inactive detach fences staging without revoking the array mapping.
    assert.equal(
      f.context.nativeQueueLoader.findLogicalIndex({ queueToken: 'old', queueIndex: 199 }, f.rows),
      199
    )
  }
})

test('producer failure after bounded prefix writes never changes the live array queue or transport', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    f.append(async () => {
      throw new Error('source failed')
    }),
    /source failed/
  )
  assert.equal(f.context.queue.value, f.rows)
  assert.equal(f.context.libraryPlayback.active.value, false)
  assert.equal(f.requests.length, 0)
  assert.equal(f.context.currentTime.value, 42.5)
})

test('cancelling a pending load wait returns immediately, and a newer load cannot be adopted before it settles', async (t) => {
  for (const change of ['abort', 'load'] as const) {
    const f = await fixture(t)
    const held = deferred<void>(),
      abort = new AbortController()
    f.context.activeLoadCompletion = held.promise
    const request = f.append(
      async (append) => {
        await append([{ id: 'suffix' }])
      },
      true,
      { signal: abort.signal }
    )
    await tick()
    if (change === 'abort') abort.abort()
    else {
      f.context.activeLoadToken++
      held.resolve()
    }
    await assert.rejects(request, change === 'abort' ? /取消/ : /当前播放已变化/)
    held.resolve()
    assert.equal(f.metadataReads, 0)
    assert.equal(f.context.queue.value, f.rows)
  }
})

test('late native handoff cannot publish over a newer source or remove its committed mapping', async (t) => {
  const f = await fixture(t)
  const held = deferred<NativeQueueCommit | null>(),
    entered = deferred<void>()
  f.context.window.api.audioEngine.rebindQueue = async () => {
    entered.resolve()
    return held.promise
  }
  const request = f.append(async (append) => {
    await append([{ id: 'suffix' }])
  })
  await entered.promise
  f.detach()
  f.context.nativeQueueRevisionFence.next()
  f.context.nativeQueueAdoptionUncertain = false
  f.context.nativeQueueLoader.adopt(f.rows, { queueToken: 'newer-source', queueIndex: 199 })
  held.resolve({ queueToken: 'late' })
  await assert.rejects(request, /变化/)
  assert.equal(f.context.libraryPlayback.active.value, false)
  assert.equal(f.deleted.length, 0)
  assert.equal(f.context.queue.value, f.rows)
  assert.equal(f.context.nativeQueueAdoptionUncertain, false)
  assert.equal(
    f.context.nativeQueueLoader.findLogicalIndex(
      { queueToken: 'newer-source', queueIndex: 199 },
      f.rows
    ),
    199
  )
})

test('a library notification during native commit retains the seed but refuses stale activation', async (t) => {
  const f = await fixture(t)
  f.context.window.api.audioEngine.rebindQueue = async () => {
    f.context.libraryPlayback.invalidateLibrary(f.db.getMetadata().revision + 1)
    return { queueToken: 'new' }
  }
  await assert.rejects(
    f.append(async (append) => {
      await append([{ id: 'suffix' }])
    }),
    /曲库已变化/
  )
  assert.equal(f.context.libraryPlayback.active.value, false)
  assert.equal(f.deleted.length, 0)
  assert.equal(f.context.nativeQueueAdoptionUncertain, true)
  assert.equal(f.context.queue.value, f.rows)
})

test('pending mode planning uses lightweight positions, preserves both orders and leaves the old arrays untouched', async () => {
  const original = toPlaybackQueueSnapshots(
    Array.from(
      { length: 5 },
      (_, i) =>
        ({
          id: String(i),
          source: 'local',
          filePath: `D:/Temporary/${i}.flac`,
          title: String(i),
          lyrics: null
        }) as Track
    )
  )
  const displayed = [original[3], original[0], original[4], original[1], original[2]]
  for (const mode of ['sequential', 'shuffle'] as const) {
    const seed = createLibraryArrayQueueSeed(displayed, original, displayed[2], 2, mode, true)
    const items: import('../../../../shared/libraryQueueBuild.ts').LibraryQueueSeedItem[] = []
    await seed.produce(async (page) => {
      items.push(...page)
    })
    assert.deepEqual(items.map((item) => item.originalPosition).sort(), [0, 1, 2, 3, 4])
    assert.equal(items[seed.selectedIndex!].id, '4')
    if (mode === 'shuffle') assert.equal(seed.selectedIndex, 0)
    else
      assert.deepEqual(
        items.map((item) => item.id),
        ['0', '1', '2', '3', '4']
      )
    assert.deepEqual(
      displayed.map((item) => item.id),
      ['3', '0', '4', '1', '2']
    )
  }
  assert.throws(
    () =>
      createLibraryArrayQueueSeed(displayed, original.slice(1), displayed[2], 2, 'shuffle', false),
    /不一致/
  )
  assert.throws(
    () => createLibraryArrayQueueSeed(displayed, original, displayed[0], 2, 'shuffle', false),
    /当前歌曲/
  )
})
