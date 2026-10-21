import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { LibraryDatabase } from '../library/libraryDatabase.ts'
import { libraryQueueResumeMode } from '../../shared/libraryDatabase.ts'
import * as afterglow from '../../shared/afterglowMode.ts'
import { isPlaybackSession } from '../../shared/playbackSession.ts'
import { createSleepTimerState } from '../../shared/sleepTimer.ts'
import { PersistentDataRevisionConflictError } from '../../shared/versionedPersistence.ts'
import type { playbackSessionService as SessionOwner } from './playbackSessionService.ts'
import type * as Presentation from './afterglowSnapshot.ts'
import type { PlaybackSession } from '../core/types.ts'
import type { PlaybackInfo } from '../audio/audioEngineTypes.ts'

function load<T>(relative: string, dependencies: Record<string, unknown>): T {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const context = vm.createContext({
    exports: {},
    console,
    Buffer,
    require: (id: string) => {
      assert.ok(id in dependencies, `unmocked dependency ${id}`)
      return dependencies[id]
    }
  })
  vm.runInContext(code, context)
  return context.exports as T
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const tick = () => new Promise<void>((done) => setImmediate(done))
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

test('main session writes never retain a fired or cancelled sleep timer', async (t) => {
  const f = fixture(t)
  await f.owner.adoptRendererSnapshot(f.snapshot)
  const armed = createSleepTimerState('queueEnd', Date.now(), {
    defaultMinutes: 1,
    fadeSeconds: 10
  })
  f.owner.syncSleepTimer(armed)
  await f.owner.flush()
  assert.deepEqual(plain(f.saved.at(-1)?.sleepTimer), armed)
  f.owner.syncSleepTimer({ ...armed, active: false, triggered: true })
  await f.owner.flush()
  assert.equal(f.saved.at(-1)?.sleepTimer, undefined)
  f.owner.syncSleepTimer(armed)
  f.owner.syncSleepTimer(null)
  await f.owner.flush()
  assert.equal(f.saved.at(-1)?.sleepTimer, undefined)
  assert.equal(f.saved.at(-1)?.libraryQueue?.entryId, f.snapshot.libraryQueue?.entryId)
})

test('an unknown native queue cannot persist a guessed duplicate occurrence, even when stopped', async (t) => {
  const f = fixture(t)
  await f.owner.adoptRendererSnapshot(f.snapshot)
  f.engine.token = ''
  for (const state of ['playing', 'stopped'] as const) {
    await assert.rejects(
      f.presentation.applyAfterglowEngineState({ ...f.state(400), state }, true),
      /queue_changed/
    )
    await assert.rejects(f.presentation.buildRestoreState(), /queue_changed/)
  }
  assert.equal(f.owner.getCachedSession()?.libraryQueue?.index, 399)
  assert.deepEqual(f.edits, [])
})

test('stopped recovery reads SQL authority without native mapping, cursor edits or resolved URL reuse', async (t) => {
  const f = fixture(t)
  await f.owner.adoptRendererSnapshot(f.snapshot)
  f.engine.token = ''
  f.engine.info = {
    ...f.engine.info,
    state: 'stopped',
    queueIndex: 2,
    source: 'stale-native-source'
  }
  f.presentation.setAfterglowEngineMapping(null)
  const queue = f.db.editLibraryQueue(f.queue.id, f.queue.revision, {
    kind: 'mode',
    mode: 'shuffle'
  }).queue
  const state = await f.presentation.buildStoppedLibraryRestoreState(() => true)
  assert.ok(state)
  assert.equal(state.recovery, 'native-queue-unknown')
  assert.deepEqual(plain(state.libraryQueue), {
    id: queue.id,
    revision: queue.revision,
    index: queue.index,
    entryId: queue.selectedEntryId
  })
  assert.equal(state.playMode, 'shuffle')
  assert.equal(state.state, 'stopped')
  assert.equal(state.position, 0)
  assert.equal(state.queueLength, 605)
  assert.equal((state.track as Record<string, unknown>).streamUrl, undefined)
  assert.deepEqual(plain(state.queue), [])
  assert.deepEqual(plain(state.nativeQueueIndices), [])
  assert.equal(state.queueToken, '')
  assert.ok(f.reads.every((read) => read.limit === 1))
  assert.deepEqual(f.edits, [])
})

test('stopped recovery preserves a deleted SQL occurrence as a hole, and fences late authority changes', async (t) => {
  const f = fixture(t)
  await f.owner.adoptRendererSnapshot(f.snapshot)
  f.engine.token = ''
  f.engine.info.state = 'stopped'
  f.db.replaceDocument({ version: 2, revision: 0, tracks: [], folders: [], exclusions: [] })
  const state = await f.presentation.buildStoppedLibraryRestoreState(() => true)
  assert.equal(state?.track, null)
  assert.equal(state?.libraryQueue?.entryId, f.snapshot.libraryQueue?.entryId)
  let current = true
  const read = f.database.readLibraryQueue
  f.database.readLibraryQueue = async (...args) => {
    const page = await read(...args)
    current = false
    return page
  }
  await assert.rejects(
    f.presentation.buildStoppedLibraryRestoreState(() => current),
    /queue_changed/
  )
  assert.deepEqual(f.edits, [])
})

function fixture(t: test.TestContext, resume = 'trackAndPosition') {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    exclusions: [],
    folders: [],
    tracks: [
      {
        id: 'cue',
        title: 'CUE occurrence',
        artist: 'Artist',
        album: 'Album',
        duration: 90,
        filePath: 'D:/Music/disc.flac',
        cueRange: { startSeconds: 90, endSeconds: 180 },
        cueSheetPath: 'D:/Music/disc.cue',
        cueEncoding: 'gb18030'
      },
      { id: 'other', title: 'Other', filePath: 'D:/Music/other.flac', duration: 90 }
    ]
  })
  let queue = db.createLibraryQueue({
    ids: Array.from({ length: 605 }, () => 'cue'),
    sort: 'playlist'
  })
  const entry = (index: number) => db.readLibraryQueue(queue.id, index, 1).items[0]
  queue = db.editLibraryQueue(queue.id, queue.revision, {
    kind: 'select',
    entryId: entry(399).queueEntryId
  }).queue
  const initial = entry(399)
  const reference = {
    id: queue.id,
    revision: queue.revision,
    index: 399,
    entryId: initial.queueEntryId
  }
  const snapshot: afterglow.AfterglowRendererSnapshot = {
    queue: [],
    libraryQueue: reference,
    queueIndex: 399,
    track: { ...initial.track!, queueEntryId: initial.queueEntryId },
    position: 12,
    playMode: 'listLoop',
    volume: 0.7,
    playbackRate: 1,
    nativeQueueIndices: [399, 400, 401]
  }
  const reads: Array<{ offset: number; limit: number }> = [],
    edits: string[] = [],
    saved: PlaybackSession[] = []
  const database = {
    getLibraryQueue: async (id: string) => db.getLibraryQueue(id),
    readLibraryQueue: async (...args: Parameters<LibraryDatabase['readLibraryQueue']>) => {
      reads.push({ offset: args[1] ?? 0, limit: args[2] ?? 200 })
      return db.readLibraryQueue(...args)
    },
    editLibraryQueue: async (...args: Parameters<LibraryDatabase['editLibraryQueue']>) => {
      edits.push(args[2].kind)
      return db.editLibraryQueue(...args)
    }
  }
  let envelope: { data: PlaybackSession; revision: number } | null = null
  const storage = {
    load: async () => envelope,
    save: async (session: PlaybackSession, revision: number) => {
      assert.equal(
        isPlaybackSession(session),
        true,
        'all main writes obey the shared session contract'
      )
      assert.equal(revision, envelope?.revision ?? 0)
      envelope = { data: structuredClone(session), revision: revision + 1 }
      saved.push(envelope.data)
      return envelope
    }
  }
  class Engine extends EventEmitter {
    token = 'live-token'
    info = {
      state: 'playing',
      queueIndex: 0,
      source: 'D:/Music/disc.flac',
      position: 12,
      duration: 90,
      volume: 0.7,
      playbackRate: 1,
      playMode: 'sequential'
    } as PlaybackInfo
    items = [399, 400, 401].map((index) => ({
      id: 'cue',
      queueEntryId: entry(index).queueEntryId,
      source: 'D:/Music/disc.flac'
    }))
    async getPlaybackInfo() {
      return { ...this.info }
    }
    getQueueToken() {
      return this.token
    }
    getQueueSnapshot() {
      return this.items.map((item) => ({ ...item }))
    }
  }
  const engine = new Engine()
  const remote: Record<string, unknown>[] = []
  const runtime = {
    appSettings: { playbackResumeMode: resume, playMode: 'listLoop' },
    libraryDatabase: { database },
    audioEngineManager: engine,
    publishRemotePlaybackSnapshot: (state: Record<string, unknown>) => remote.push(state),
    latestMiniPlayerState: null as Record<string, unknown> | null
  }
  const owner = load<{ playbackSessionService: typeof SessionOwner }>(
    './playbackSessionService.ts',
    {
      '../core/runtime.ts': { runtime },
      '../persistence/playbackSessionStore.ts': {
        getPlaybackSessionStoreBundle: () => ({ storage })
      },
      '../../shared/versionedPersistence.ts': { PersistentDataRevisionConflictError },
      '../../shared/libraryDatabase.ts': { LIBRARY_PAGE_SIZE: 200 },
      '../../shared/afterglowMode.ts': afterglow
    }
  ).playbackSessionService
  const presentation = load<typeof Presentation>('./afterglowSnapshot.ts', {
    '../core/runtime.ts': { runtime },
    '../core/settings.ts': {
      normalizeAppSettings: (value: unknown) => value,
      writeAppSettings: () => {}
    },
    '../integrations/discord.ts': { updateDiscordActivity: () => {} },
    '../library/coverCache.ts': {},
    './playbackSessionService.ts': { playbackSessionService: owner },
    '../../shared/libraryDatabase.ts': { libraryQueueResumeMode },
    '../../shared/afterglowMode.ts': afterglow
  })
  t.after(() => {
    presentation.stopAfterglowPresentation()
    db.close()
  })
  presentation.setAfterglowEngineMapping([399, 400, 401])
  const state = (index: number, position = 42) => ({
    ...engine.info,
    queueIndex: index - 399,
    position
  })
  const options = (index: number) => ({ logicalIndex: index, entryId: entry(index).queueEntryId })
  return {
    db,
    database,
    queue,
    entry,
    snapshot,
    owner,
    presentation,
    engine,
    runtime,
    storage,
    reads,
    edits,
    saved,
    state,
    options,
    remote,
    setEnvelope: (value: typeof envelope) => {
      envelope = value
    }
  }
}

test('confirmed logical shuffle survives compact persistence, presentation settings and the actual restore payload', async (t) => {
  const f = fixture(t)
  await f.owner.adoptRendererSnapshot(f.snapshot)
  const expected = { ...f.owner.getCachedSession()!.libraryQueue! }
  const selected = f.engine.items[0]
  const queue = f.db.editLibraryQueue(expected.id, expected.revision, {
    kind: 'mode',
    mode: 'shuffle'
  }).queue
  f.engine.items = [selected]
  f.presentation.setAfterglowEngineMapping([queue.index])
  f.owner.adoptLibraryQueueMode(expected, queue, 'shuffle')
  f.presentation.startAfterglowPresentation()
  await tick()
  const restore = await f.presentation.buildRestoreState()
  await f.owner.flush()
  assert.equal(restore!.playMode, 'shuffle')
  assert.equal(restore!.libraryQueue!.index, 0)
  assert.equal(restore!.libraryQueue!.entryId, selected.queueEntryId)
  assert.deepEqual(plain(restore!.nativeQueueIndices), [0])
  assert.deepEqual(plain(restore!.queue), [])
  assert.equal(f.runtime.appSettings.playMode, 'shuffle')
  assert.equal(f.saved.at(-1)!.playMode, 'shuffle')
  assert.equal(f.saved.at(-1)!.libraryQueue!.revision, queue.revision)
  assert.equal(f.saved.at(-1)!.queue, undefined)
  assert.equal(f.engine.info.playMode, 'sequential')
  assert.equal(f.engine.info.position, 12)
  await f.owner.load()
  assert.equal(f.owner.getCachedSession()!.playMode, 'shuffle')
  assert.equal(f.owner.getCachedSession()!.libraryQueue!.index, 0)
})

test('confirmed logical mode adoption rejects stale sessions and malformed confirmed cursors', async (t) => {
  const f = fixture(t)
  await f.owner.adoptRendererSnapshot(f.snapshot)
  const expected = { ...f.owner.getCachedSession()!.libraryQueue! }
  const queue = f.db.getLibraryQueue(expected.id)
  assert.throws(
    () =>
      f.owner.adoptLibraryQueueMode(
        { ...expected, revision: expected.revision + 1 },
        queue,
        'repeat'
      ),
    /queue_changed/
  )
  assert.throws(
    () => f.owner.adoptLibraryQueueMode(expected, { ...queue, index: NaN }, 'repeat'),
    /queue_changed/
  )
  f.owner.adoptLibraryQueueMode(expected, queue, 'repeat')
  assert.equal(f.owner.getCachedSession()!.playMode, 'repeat')
  assert.equal(f.owner.getCachedSession()!.position, 12)
})

test('SQL pre-unload snapshots accept deep native indices and reject mixed/contradictory references', (t) => {
  const { snapshot } = fixture(t)
  assert.deepEqual(afterglow.parseAfterglowRendererSnapshot(snapshot), snapshot)
  for (const invalid of [
    { libraryQueue: { ...snapshot.libraryQueue, id: '' } },
    { queue: [snapshot.track] },
    { queueIndex: 398 },
    { track: { id: 'cue', queueEntryId: 'wrong-occurrence' } },
    { nativeQueueIndices: [Number.MAX_SAFE_INTEGER + 1] }
  ])
    assert.equal(afterglow.parseAfterglowRendererSnapshot({ ...snapshot, ...invalid }), null)
})

test('SQL adoption removes old array fields; deep duplicate EOF commits cursor, metadata and compact session', async (t) => {
  const f = fixture(t)
  f.setEnvelope({
    revision: 3,
    data: {
      version: 1,
      savedAt: '',
      mode: 'trackAndPosition',
      track: { id: 'old' },
      position: 0,
      queue: [{ id: 'old' }],
      queueRevision: 9,
      queueIndex: 0
    }
  })
  await f.owner.adoptRendererSnapshot(f.snapshot)
  await f.owner.applyEngineState(f.state(400), f.options(400))
  await f.owner.flush()
  const session = f.owner.getCachedSession()!
  assert.equal(session.libraryQueue?.index, 400)
  assert.equal(session.libraryQueue?.entryId, f.entry(400).queueEntryId)
  assert.equal(session.libraryQueue?.revision, f.db.getLibraryQueue(f.queue.id).revision)
  assert.equal(
    session.playMode,
    'listLoop',
    'sequential native windows do not erase the logical mode'
  )
  assert.equal(session.position, 42)
  assert.equal((session.track as { queueEntryId: string }).queueEntryId, f.entry(400).queueEntryId)
  assert.equal(session.queue, undefined)
  assert.equal(session.queueRevision, undefined)
  assert.equal(session.queueIndex, undefined)
  assert.equal(f.owner.getCachedQueueLength(), 605)
  assert.deepEqual(f.reads, [{ offset: 400, limit: 1 }])
  assert.deepEqual(f.edits, ['select'])
  assert.ok(f.saved.every(isPlaybackSession))
})

test('resume-off still commits the durable SQL cursor but writes no playback session', async (t) => {
  const f = fixture(t, 'off')
  await f.owner.adoptRendererSnapshot(f.snapshot)
  await f.owner.applyEngineState(f.state(401), f.options(401))
  await f.owner.flush()
  assert.equal(f.db.getLibraryQueue(f.queue.id).index, 401)
  assert.equal(f.owner.getCachedSession()?.libraryQueue?.index, 401)
  assert.deepEqual(f.saved, [])
})

test('slow SQL reads coalesce the latest demand, skip superseded cursor commits and keep time ticks in memory', async (t) => {
  const f = fixture(t, 'off')
  await f.owner.adoptRendererSnapshot(f.snapshot)
  const started = deferred<void>(),
    held = deferred<void>()
  const read = f.database.readLibraryQueue
  f.database.readLibraryQueue = async (...args) => {
    if (args[1] === 400) {
      started.resolve()
      await held.promise
    }
    return read(...args)
  }
  const first = f.owner.applyEngineState(f.state(400), f.options(400))
  await started.promise
  for (let i = 0; i < 500; i++)
    assert.equal(f.owner.applyEngineState(f.state(401, i), f.options(401)), first)
  held.resolve()
  await first
  assert.deepEqual(f.edits, ['select'])
  assert.equal(f.owner.getCachedSession()?.libraryQueue?.index, 401)
  assert.equal(f.owner.getCachedSession()?.position, 499)
  for (let i = 0; i < 50; i++) await f.owner.applyEngineState(f.state(401, i), f.options(401))
  assert.equal(f.reads.length, 2)
  assert.equal(f.owner.getCachedSession()?.position, 49)
})

test('late reads after source replacement cannot overwrite the new session or commit the old cursor', async (t) => {
  const f = fixture(t, 'off')
  await f.owner.adoptRendererSnapshot(f.snapshot)
  const started = deferred<void>(),
    held = deferred<void>()
  const read = f.database.readLibraryQueue
  f.database.readLibraryQueue = async (...args) => {
    started.resolve()
    await held.promise
    return read(...args)
  }
  const applying = f.owner.applyEngineState(f.state(400), f.options(400))
  await started.promise
  await f.owner.adoptRendererSnapshot({
    ...f.snapshot,
    libraryQueue: undefined,
    queue: [{ id: 'new' }],
    queueIndex: 0,
    track: { id: 'new' }
  })
  held.resolve()
  await applying
  assert.equal((f.owner.getCachedSession()?.track as { id: string }).id, 'new')
  assert.equal(f.db.getLibraryQueue(f.queue.id).index, 399)
  assert.deepEqual(f.edits, [])
})

test('bad occurrence mappings and stale database revisions fail without replaying a cursor edit', async (t) => {
  const f = fixture(t, 'off')
  await f.owner.adoptRendererSnapshot(f.snapshot)
  await assert.rejects(
    f.owner.applyEngineState(f.state(400), {
      logicalIndex: 400,
      entryId: f.entry(399).queueEntryId
    }),
    /mappable/
  )
  f.db.editLibraryQueue(f.queue.id, f.queue.revision, {
    kind: 'select',
    entryId: f.entry(401).queueEntryId
  })
  await assert.rejects(
    f.owner.applyEngineState(f.state(400), f.options(400)),
    /变化|revision|changed/i
  )
  assert.deepEqual(f.edits, [])
})

test('presentation and restore use the complete SQL extent, exact occurrence and native token, never a full queue', async (t) => {
  const f = fixture(t)
  await f.owner.adoptRendererSnapshot(f.snapshot)
  f.engine.info = f.state(400, 51.25)
  f.presentation.startAfterglowPresentation()
  await tick()
  await tick()
  assert.equal(f.runtime.latestMiniPlayerState?.queueIndex, 400)
  assert.equal(f.runtime.latestMiniPlayerState?.queueLength, 605)
  const remote = f.remote.findLast((state) => state.queueIndex !== undefined)
  assert.equal(remote?.queueIndex, 400)
  assert.equal(remote?.queueLength, 605)
  f.presentation.stopAfterglowPresentation()
  const restore = await f.presentation.buildRestoreState()
  assert.ok(restore)
  assert.equal(restore.libraryQueue?.entryId, f.entry(400).queueEntryId)
  assert.equal(restore.libraryQueue?.revision, f.db.getLibraryQueue(f.queue.id).revision)
  assert.equal(restore.queueToken, 'live-token')
  assert.equal(restore.position, 51.25)
  assert.equal(restore.queueIndex, 400)
  assert.equal(restore.queueLength, 605)
  assert.equal(restore.playMode, 'listLoop')
  assert.deepEqual(plain(restore.queue), [])
  assert.deepEqual(plain(restore.nativeQueueIndices), [399, 400, 401])
  assert.deepEqual(plain(restore.nativeQueueEntries?.map((entry) => entry.index)), [399, 400, 401])
  assert.ok(f.reads.every((read) => read.limit === 1))
})

test('missing mapping and a token change during restore never fall back to native-index identity', async (t) => {
  const f = fixture(t, 'off')
  await f.owner.adoptRendererSnapshot(f.snapshot)
  f.presentation.setAfterglowEngineMapping(null)
  await assert.rejects(f.presentation.buildRestoreState(), /mappable/)
  f.presentation.setAfterglowEngineMapping([399, 400, 401])
  const read = f.database.readLibraryQueue
  f.database.readLibraryQueue = async (...args) => {
    const result = await read(...args)
    f.engine.token = 'replacement'
    return result
  }
  await assert.rejects(f.presentation.buildRestoreState(), /changed/)
})

test('a delayed initial engine response cannot replace a newer event or publish after stopping', async (t) => {
  const f = fixture(t, 'off')
  await f.owner.adoptRendererSnapshot(f.snapshot)
  const first = deferred<PlaybackInfo>()
  f.engine.getPlaybackInfo = () => first.promise
  f.presentation.startAfterglowPresentation()
  f.engine.emit('playback-info', f.state(400, 23))
  await tick()
  await tick()
  first.resolve(f.state(399, 1))
  await tick()
  assert.equal(f.runtime.latestMiniPlayerState?.queueIndex, 400)
  f.presentation.stopAfterglowPresentation()
  const before = f.remote.length
  f.engine.emit('playback-info', f.state(401))
  await tick()
  assert.equal(f.remote.length, before)
})

test('explicit restore reconciles a lost cursor ACK through bounded identity checks without replaying the edit', async (t) => {
  const f = fixture(t, 'off')
  await f.owner.adoptRendererSnapshot(f.snapshot)
  const edit = f.database.editLibraryQueue
  f.database.editLibraryQueue = async (...args) => {
    await edit(...args)
    throw new Error('lost cursor reply')
  }
  await assert.rejects(f.owner.applyEngineState(f.state(400), f.options(400)), /lost cursor reply/)
  assert.equal(f.owner.getCachedSession()?.libraryQueue?.index, 399)
  assert.equal(f.db.getLibraryQueue(f.queue.id).index, 400)
  f.engine.info = f.state(400, 45)
  const restored = await f.presentation.buildRestoreState()
  assert.equal(restored?.libraryQueue?.index, 400)
  assert.equal(restored?.libraryQueue?.revision, f.db.getLibraryQueue(f.queue.id).revision)
  assert.deepEqual(f.edits, ['select'])
  assert.ok(f.reads.every((read) => read.limit <= 200))
  assert.deepEqual(
    f.reads.filter((read) => read.limit === 200).map((read) => read.offset),
    [200, 400]
  )
})

test('explicit reconciliation rejects native identities that no longer match the database order', async (t) => {
  const f = fixture(t, 'off')
  await f.owner.adoptRendererSnapshot(f.snapshot)
  f.db.editLibraryQueue(f.queue.id, f.queue.revision, {
    kind: 'select',
    entryId: f.entry(400).queueEntryId
  })
  f.engine.info = f.state(400)
  f.engine.items[0].queueEntryId = f.entry(398).queueEntryId
  await assert.rejects(f.presentation.buildRestoreState(), /changed/)
  assert.equal(f.owner.getCachedSession()?.libraryQueue?.index, 399)
  assert.deepEqual(f.edits, [])
})

test('entry preparation verifies a native window straddling the previous page and retains no detail array', async (t) => {
  const f = fixture(t, 'off')
  const current = f.entry(400)
  const queue = f.db.editLibraryQueue(f.queue.id, f.queue.revision, {
    kind: 'select',
    entryId: current.queueEntryId
  }).queue
  const snapshot = {
    ...f.snapshot,
    queueIndex: 400,
    libraryQueue: {
      id: queue.id,
      revision: queue.revision,
      index: 400,
      entryId: current.queueEntryId
    },
    track: { ...current.track, queueEntryId: current.queueEntryId }
  }
  await f.owner.adoptRendererSnapshot(snapshot)
  const serviceSource = readFileSync(new URL('./AfterglowModeService.ts', import.meta.url), 'utf8')
  const file = ts.createSourceFile('owner.ts', serviceSource, ts.ScriptTarget.Latest, true)
  const owner = file.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === 'AfterglowModeService'
  )!
  const prepare = owner.members.find(
    (node) =>
      ts.isMethodDeclaration(node) && node.name.getText(file) === 'prepareLibraryQueueSnapshot'
  )!
  const code = ts.transpileModule(
    `class Owner { ${prepare.getText(file)} }; globalThis.owner = new Owner()`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText
  const context = vm.createContext({
    runtime: f.runtime,
    playbackSessionService: f.owner,
    LIBRARY_PAGE_SIZE: 200
  })
  vm.runInContext(code, context)
  const prepareSnapshot = context.owner.prepareLibraryQueueSnapshot.bind(context.owner) as (
    snapshot: afterglow.AfterglowRendererSnapshot,
    native: typeof f.engine.items,
    current: () => boolean
  ) => Promise<{
    mapping: number[]
    queue: unknown
    loadQueueItem: (index: number) => Promise<Record<string, unknown>>
  }>
  const prepared = await prepareSnapshot(snapshot, f.engine.items, () => true)
  assert.deepEqual(plain(prepared.mapping), [399, 400, 401])
  assert.deepEqual(
    f.reads.map((read) => read.offset),
    [200, 400]
  )
  assert.equal('queueWindow' in prepared, false)
  assert.equal((await prepared.loadQueueItem(402)).queueEntryId, f.entry(402).queueEntryId)
  assert.equal(f.reads.at(-1)?.limit, 1)
})

test('stopped SQL restore uses the selected native source, not a failed decoder leftover; revoked native authority is rejected', async (t) => {
  const f = fixture(t, 'off')
  await f.owner.adoptRendererSnapshot(f.snapshot)
  f.engine.info.state = 'stopped'
  f.engine.info.source = 'D:/Music/old-decoder.flac'
  const restored = await f.presentation.buildRestoreState()
  assert.equal((restored?.track as { streamUrl: string }).streamUrl, 'D:/Music/disc.flac')
  assert.equal(
    restored?.duration,
    90,
    'duration comes from the selected occurrence, not an old decoder'
  )
  f.engine.info.source = 'D:/Music/disc.flac'
  f.engine.info.duration = 91.25
  assert.equal(
    (await f.presentation.buildRestoreState())?.duration,
    91.25,
    'an unchanged stopped source retains its measured native duration'
  )
  f.engine.token = ''
  await assert.rejects(f.presentation.buildRestoreState(), /queue_changed/)
})
