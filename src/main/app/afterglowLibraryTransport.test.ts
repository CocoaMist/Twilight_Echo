import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { SleepTimerService } from '../sleepTimerCore.ts'
import {
  NativeSleepTimerBoundaryCursor,
  registerNativeSleepTimerBoundaries
} from '../audio/sleepTimerNativeBoundary.ts'
import { SleepTimerShutdown } from '../sleepTimerShutdown.ts'
import { createSleepTimerState } from '../../shared/sleepTimer.ts'
import test from 'node:test'
import ts from 'typescript'
import { LibraryDatabase } from '../library/libraryDatabase.ts'
import { libraryQueueResumeMode } from '../../shared/libraryDatabase.ts'
import { navigateAfterglowLibraryQueue } from './afterglowLibraryTransport.ts'
import { AfterglowLibraryQueueCore } from './afterglowLibraryQueueCore.ts'
import {
  changeAfterglowLibraryMode,
  reconcileAfterglowLibraryMode
} from './afterglowLibraryMode.ts'
import type { AfterglowLibraryModePending } from './afterglowLibraryMode.ts'
import {
  authorizeAfterglowNativeSource,
  type AfterglowSourceResolver
} from './afterglowSourceResolver.ts'
import type { NativeQueueRebind } from '../../shared/nativeQueue.ts'
import * as shared from '../../shared/afterglowMode.ts'
import { PersistentDataRevisionConflictError } from '../../shared/versionedPersistence.ts'
import type { PlaybackInfo } from '../audio/audioEngineTypes.ts'
import type { AudioEngineQueueItem } from '../../shared/audioEngineTypes.ts'
import type { playbackSessionService as Session } from './playbackSessionService.ts'
import type { dispatchRendererFreeTransport as Dispatch } from './rendererFreePlayback.ts'

function load<T>(relative: string, dependencies: Record<string, unknown>): T {
  const code = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const context = vm.createContext({
    exports: {},
    Error,
    console,
    require: (id: string) => {
      assert.ok(id in dependencies, `unmocked dependency: ${id}`)
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

type ModeOwner = {
  phase: string
  generation: number
  error: string | null
  transportMutationDrain: Promise<void>
  queueCore: AfterglowLibraryQueueCore | null
  pendingLibraryMode: AfterglowLibraryModePending | null
  getRestoreState(): Promise<unknown>
  startQueueCore(
    snapshot: unknown,
    mapping: number[],
    current: number,
    length: number
  ): Promise<void>
  stopQueueCore(): Promise<void>
  bindWindowedAutoRestore(): void
  unbindWindowedAutoRestore(): void
  cancelLibraryControlPreview(): void
  bindSleepTimerShutdown(): void
  releaseSleepTimerShutdown(): void
  setRendererSnapshot(payload: unknown): boolean | Promise<boolean>
  settleRendererSleepShutdownHandoff(): Promise<boolean>
  sleepShutdown: SleepTimerShutdown | null
  enter(): Promise<shared.AfterglowModeStatus>
  restore(): Promise<shared.AfterglowModeStatus>
  dispatch(command: shared.AfterglowTransportCommand): Promise<void>
}

async function fixture(t: test.TestContext, index = 399) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    exclusions: [],
    folders: [],
    tracks: [
      {
        id: 'cue',
        filePath: 'D:/Music/disc.flac',
        title: 'Cue',
        duration: 90,
        cueRange: { startSeconds: 90, endSeconds: 180, virtualPregapSeconds: 1 }
      }
    ]
  })
  let queue = db.createLibraryQueue({ ids: Array(605).fill('cue'), sort: 'playlist' })
  const entry = (position: number) => db.readLibraryQueue(queue.id, position, 1).items[0]
  queue = db.editLibraryQueue(queue.id, queue.revision, {
    kind: 'select',
    entryId: entry(index).queueEntryId
  }).queue
  const reads: number[] = [],
    edits: string[] = [],
    transport: string[] = []
  const database = {
    getLibraryQueue: async (id: string) => db.getLibraryQueue(id),
    readLibraryQueue: async (...args: Parameters<LibraryDatabase['readLibraryQueue']>) => {
      reads.push(args[2] ?? 200)
      return db.readLibraryQueue(...args)
    },
    readLibraryQueueNeighbor: async (
      ...args: Parameters<LibraryDatabase['readLibraryQueueNeighbor']>
    ) => {
      reads.push(1)
      return db.readLibraryQueueNeighbor(...args)
    },
    readLibraryQueuePlaybackWindow: async (
      ...args: Parameters<LibraryDatabase['readLibraryQueuePlaybackWindow']>
    ) => {
      const window = db.readLibraryQueuePlaybackWindow(...args)
      reads.push(window.items.length)
      return window
    },
    editLibraryQueue: async (...args: Parameters<LibraryDatabase['editLibraryQueue']>) => {
      edits.push(args[2].kind)
      return db.editLibraryQueue(...args)
    }
  }
  const library = Object.assign(new EventEmitter(), { database })
  const runtime = { appSettings: { playbackResumeMode: 'off' }, libraryDatabase: library }
  const session = load<{ playbackSessionService: typeof Session }>('./playbackSessionService.ts', {
    '../core/runtime.ts': { runtime },
    '../persistence/playbackSessionStore.ts': {},
    '../../shared/versionedPersistence.ts': { PersistentDataRevisionConflictError },
    '../../shared/afterglowMode.ts': shared,
    '../../shared/libraryDatabase.ts': { LIBRARY_PAGE_SIZE: 200 }
  }).playbackSessionService
  const first = entry(index)
  await session.adoptRendererSnapshot({
    queue: [],
    queueIndex: index,
    track: { ...first.track, queueEntryId: first.queueEntryId },
    libraryQueue: { id: queue.id, revision: queue.revision, index, entryId: first.queueEntryId },
    playMode: 'listLoop',
    position: 12,
    volume: 0.7,
    playbackRate: 1.25
  })
  const engine = {
    ended: false,
    token: 'initial',
    items: [
      {
        id: 'cue',
        queueEntryId: first.queueEntryId,
        source: 'D:/Music/disc.flac',
        logicalQueueEnd: index === 604
      }
    ] as AudioEngineQueueItem[],
    info: {
      state: 'playing',
      queueIndex: 0,
      source: 'D:/Music/disc.flac',
      position: 12,
      duration: 90,
      volume: 0.7,
      playbackRate: 1.25,
      playMode: 'sequential'
    } as PlaybackInfo,
    getQueueToken() {
      return this.token
    },
    getQueueSnapshot() {
      return this.items.map((item) => ({ ...item }))
    },
    async getPlaybackInfo() {
      return { ...this.info }
    },
    getPlaybackEnd() {
      return this.ended && this.info.state === 'stopped'
        ? {
            intent: 1,
            selection: {
              queueToken: this.token,
              index: this.info.queueIndex,
              id: this.items[this.info.queueIndex].id,
              source: this.info.source
            }
          }
        : null
    },
    async continueAfterPlaybackEnd(
      request: Parameters<
        import('../audioEngineManager.ts').AudioEngineManager['continueAfterPlaybackEnd']
      >[0]
    ) {
      if (
        !request.isCurrent() ||
        JSON.stringify(request.expected) !== JSON.stringify(this.getPlaybackEnd())
      )
        return false
      await this.loadQueue([request.item])
      request.onSelected()
      await this.setPlayMode(request.playMode)
      await this.play(request.item.source, 0)
      this.ended = false
      return true
    },
    async loadQueue(items: AudioEngineQueueItem[]) {
      transport.push('load')
      this.items = items
      this.token += ':load'
      this.info.queueIndex = 0
    },
    async rebindQueue(request: NativeQueueRebind) {
      transport.push('guard')
      assert.equal(request.expected.queueToken, this.token)
      assert.equal(request.expected.index, this.info.queueIndex)
      assert.equal(request.items[0].queueEntryId, this.items[this.info.queueIndex].queueEntryId)
      assert.ok(request.playMode === 'repeat' || request.playMode === 'sequential')
      this.items = request.items
      this.token += ':guard'
      this.info.queueIndex = 0
      this.info.playMode = request.playMode
      return { queueToken: this.token }
    },
    async setPlayMode(mode: PlaybackInfo['playMode']) {
      transport.push(`mode:${mode}`)
      this.info.playMode = mode
    },
    async play(source: string, position = 0) {
      transport.push('play')
      this.info = { ...this.info, state: 'playing', position, source }
      this.ended = false
      engineEvents.emit('playback-info', { ...this.info })
      return { nativeStarted: true, fallbackReason: '' }
    },
    async stop() {
      transport.push('stop')
      this.info.state = 'stopped'
      this.info.position = 0
      this.ended = false
      engineEvents.emit('playback-info', { ...this.info })
    },
    recoveryRevision: 0,
    async stopForQueueRecovery() {
      await this.stop()
      return ++this.recoveryRevision
    },
    isQueueRecoveryCurrent(revision: number) {
      return !this.token && this.info.state === 'stopped' && revision === this.recoveryRevision
    },
    async togglePause() {
      transport.push('pause')
      this.info.state = this.info.state === 'playing' ? 'paused' : 'playing'
    },
    async seek(position: number) {
      transport.push('seek')
      this.info.position = position
    },
    async setVolume(volume: number) {
      transport.push('volume')
      this.info.volume = volume
    },
    gain: 1,
    async setSleepTimerGain(gain: number) {
      transport.push(`gain:${gain}`)
      this.gain = gain
    },
    async next() {
      transport.push('native-next')
    },
    async previous() {
      transport.push('native-previous')
    }
  }
  let mapping = [index],
    active = true
  const engineEvents = new EventEmitter()
  const sleepClock = { now: Date.now(), tick: null as (() => void) | null }
  const sleepTimer = new SleepTimerService({
    now: () => sleepClock.now,
    setInterval: (callback) => {
      sleepClock.tick = callback
      return {} as NodeJS.Timeout
    },
    clearInterval: () => {
      sleepClock.tick = null
    }
  })
  Object.assign(engine, {
    on: engineEvents.on.bind(engineEvents),
    off: engineEvents.off.bind(engineEvents)
  })
  let interval: (() => void) | null = null
  let restored = 0
  let createWindow: (() => unknown) | null = null
  const timers = new Map<object, { callback: () => void; ms: number }>()
  const context = vm.createContext({
    Error,
    AbortController,
    runtime: { ...runtime, audioEngineManager: engine },
    playbackSessionService: session,
    sleepTimerService: sleepTimer,
    SleepTimerShutdown,
    AFTERGLOW_RESTORE_ACCELERATOR: shared.AFTERGLOW_RESTORE_ACCELERATOR,
    AFTERGLOW_RESTORE_ACCELERATORS: shared.AFTERGLOW_RESTORE_ACCELERATORS,
    fallbackMediaKeys: [],
    globalShortcut: { isRegistered: () => false, register: () => true, unregister: () => {} },
    AFTERGLOW_UI_DESTROY_DELAY_MS: 80,
    createAfterglowAnchorWindow: () => null,
    destroyAfterglowAnchorWindow: () => {},
    require: (id: string) => {
      if (id === '../integrations/shortcutsTray.ts') return { createTray: () => {} }
      assert.equal(id, './window.ts')
      assert.ok(createWindow)
      return { createWindow }
    },
    process: { platform: 'linux' },
    parseAfterglowRendererSnapshot: shared.parseAfterglowRendererSnapshot,
    navigateAfterglowLibraryQueue: (...args: Parameters<typeof navigateAfterglowLibraryQueue>) =>
      navigateAfterglowLibraryQueue(args[0], {
        ...args[1],
        resolver: options.resolver,
        authorize: options.authorize
      }),
    changeAfterglowLibraryMode,
    reconcileAfterglowLibraryMode,
    createAfterglowSourceResolver: () => options.resolver,
    resolveAuthorizedAudioSource: (source: string) => options.authorize(source),
    setAfterglowEngineMapping: (next: number[] | null) => {
      mapping = next ? [...next] : []
    },
    getAfterglowEngineMapping: () => [...mapping],
    stopAfterglowPresentation: () => transport.push('presentation-stop'),
    startAfterglowPresentation: () => transport.push('presentation-start'),
    buildRestoreState: async () => ({
      session: plain(session.getCachedSession()),
      mapping: [...mapping]
    }),
    applyAfterglowEngineState: async (
      info: PlaybackInfo,
      force: boolean,
      current?: () => boolean
    ) =>
      session.applyEngineState(info, {
        force,
        isCurrent: current,
        logicalIndex: mapping[info.queueIndex],
        entryId: engine.items[info.queueIndex]?.queueEntryId,
        nativeEntries: engine.items.map((item, i) => ({
          id: item.id,
          queueEntryId: item.queueEntryId!,
          index: mapping[i]
        }))
      }),
    console: { warn: () => {}, info: () => {} },
    AFTERGLOW_WINDOWED_AUTO_RESTORE_DELAY_MS: 6_000,
    restoreAfterglowMode: () => {
      restored++
    },
    setTimeout: (callback: () => void, ms: number) => {
      const handle = { unref: () => {} }
      timers.set(handle, { callback, ms })
      return handle
    },
    clearTimeout: (handle: object) => timers.delete(handle)
  })
  Object.assign(context, {
    AfterglowLibraryQueueCore,
    writeDiagnostic: () => {},
    setInterval: (callback: () => void) => {
      interval = callback
      return { unref: () => {} }
    },
    clearInterval: () => {
      interval = null
    }
  })
  const rendererFree = load<{
    dispatchRendererFreeTransport: typeof Dispatch
    enqueueRendererFreeTransport: typeof import('./rendererFreePlayback.ts').enqueueRendererFreeTransport
    rendererFreePlayModes: typeof import('./rendererFreePlayback.ts').rendererFreePlayModes
  }>('./rendererFreePlayback.ts', {
    '../../shared/afterglowMode.ts': shared,
    '../audio/engineIpc.ts': {
      ensureAudioEngineRuntime: async () => engine,
      stopActiveOutputTest: async () => {},
      scheduleSoftwareVolumePersist: () => {}
    },
    '../security/localPaths.ts': {
      resolveAuthorizedAudioSource: async (source: string) => source
    },
    './playbackSessionService.ts': { playbackSessionService: session },
    './afterglowSourceResolver.ts': { authorizeAfterglowNativeSource }
  })
  const dispatch = rendererFree.dispatchRendererFreeTransport
  Object.assign(context, {
    dispatchRendererFreeTransport: dispatch,
    enqueueRendererFreeTransport: rendererFree.enqueueRendererFreeTransport,
    rendererFreePlayModes: rendererFree.rendererFreePlayModes
  })
  const serviceSource = readFileSync(new URL('./AfterglowModeService.ts', import.meta.url), 'utf8')
  const file = ts.createSourceFile('owner.ts', serviceSource, ts.ScriptTarget.Latest, true)
  const owner = file.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === 'AfterglowModeService'
  )!
  vm.runInContext(
    ts.transpileModule(`${owner.getText(file)}; globalThis.owner = new AfterglowModeService()`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText,
    context
  )
  const modeOwner = context.owner as ModeOwner
  const originalStart = modeOwner.startQueueCore.bind(modeOwner),
    originalStop = modeOwner.stopQueueCore.bind(modeOwner)
  t.after(() => originalStop())
  t.after(() => modeOwner.unbindWindowedAutoRestore())
  t.after(async () => {
    await modeOwner.sleepShutdown?.cancel()
    modeOwner.releaseSleepTimerShutdown()
  })
  Object.assign(modeOwner, {
    phase: 'active',
    generation: 1,
    queueCoreResume: { snapshot: { queue: [] }, queueLength: 605 },
    stopQueueCore: async () => {
      transport.push('core-stop')
    },
    startQueueCore: async () => {
      transport.push('core-start')
    }
  })
  const options = {
    engine,
    database,
    session,
    resolver: {
      resolve: async (track: unknown) => ({
        source: (track as { filePath: string }).filePath,
        expiresAt: null
      })
    } as AfterglowSourceResolver,
    authorize: async (source: string) => source,
    isCurrent: () => active,
    setMapping: (next: number[]) => {
      mapping = [...next]
    },
    mutate: async (operation: () => Promise<void>) => operation()
  }
  return {
    db,
    database,
    queue,
    entry,
    session,
    engine,
    options,
    transport,
    reads,
    edits,
    owner: modeOwner,
    dispatch,
    library,
    engineEvents,
    sleepTimer,
    elapseSleep: (ms: number) => {
      sleepClock.now += ms
      sleepClock.tick?.()
    },
    timers,
    restored: () => restored,
    interval: () => interval,
    useProductionEntry: () => {
      Object.assign(modeOwner, {
        phase: 'inactive',
        evaluateEntryRejection: async () => null,
        prepareLibraryQueueSnapshot: async (snapshot: shared.AfterglowRendererSnapshot) => ({
          queue,
          mapping: [...snapshot.nativeQueueIndices!]
        }),
        setAfterglowLibraryQueueReference: async () => {},
        releaseAfterglowLibraryQueueReference: () => {},
        registerRestoreShortcut: () => true,
        registerFallbackMediaKeys: () => {},
        unregisterOwnedShortcuts: () => {},
        saveMainWindowBounds: () => {},
        destroyAllUiWindows: async () => transport.push('destroy-ui')
      })
    },
    useProductionRestoreLifecycle: (adopt: () => Promise<void>) => {
      createWindow = () => {
        transport.push('create-ui')
        return { isDestroyed: () => false, show: () => {}, focus: () => {} }
      }
      Object.assign(modeOwner, {
        waitForWindowReady: async () => true,
        waitForRendererAdopt: async () => {
          await adopt()
          Object.assign(modeOwner, { adoptCompleted: true })
        }
      })
    },
    useProductionRestore: () => {
      const presentation = load<typeof import('./afterglowSnapshot.ts')>('./afterglowSnapshot.ts', {
        '../core/runtime.ts': { runtime: { ...runtime, audioEngineManager: engine } },
        '../core/settings.ts': {
          normalizeAppSettings: (value: unknown) => value,
          writeAppSettings: () => {}
        },
        '../integrations/discord.ts': {},
        '../library/coverCache.ts': {},
        './playbackSessionService.ts': { playbackSessionService: session },
        '../../shared/libraryDatabase.ts': { libraryQueueResumeMode },
        '../../shared/afterglowMode.ts': shared
      })
      context.buildRestoreState = async () => {
        presentation.setAfterglowEngineMapping(mapping)
        return presentation.buildRestoreState()
      }
      context.buildStoppedLibraryRestoreState = presentation.buildStoppedLibraryRestoreState
    },
    maintenance: async () => {
      modeOwner.startQueueCore = originalStart
      modeOwner.stopQueueCore = originalStop
      await modeOwner.startQueueCore(
        { queue: [], libraryQueue: session.getCachedSession()!.libraryQueue },
        mapping,
        session.getCachedSession()!.libraryQueue!.index,
        605
      )
      await modeOwner.queueCore?.tick()
    },
    mapping: () => mapping,
    deactivate: () => {
      active = false
    }
  }
}

test('production SQL owner maintains a bounded global loop, synchronizes automatic EOF and never replays the current decoder', async (t) => {
  const f = await fixture(t, 604)
  await f.maintenance()
  assert.deepEqual(f.mapping(), [604, 0])
  assert.equal(f.engine.info.playMode, 'sequential')
  assert.equal(f.engine.info.position, 12)
  f.engine.info.queueIndex = 1
  f.engine.info.position = 0
  f.engineEvents.emit('playback-info', { ...f.engine.info })
  await f.owner.queueCore!.tick()
  assert.deepEqual(f.mapping(), [0, 1])
  assert.equal(f.session.getCachedSession()?.libraryQueue?.index, 0)
  assert.equal(f.session.getCachedSession()?.playMode, 'listLoop')
  assert.equal(f.session.getCachedQueueLength(), 605)
  assert.ok(f.reads.every((size) => size <= 2))
  assert.equal(f.transport.includes('load'), false)
  assert.equal(f.transport.includes('play'), false)
  assert.equal(f.transport.includes('stop'), false)
  assert.equal(f.owner.error, null)
  assert.equal(f.library.listenerCount('changed'), 1)
  assert.ok(f.interval())
  await f.owner.stopQueueCore()
  assert.equal(f.library.listenerCount('changed'), 0)
  assert.equal(f.engineEvents.listenerCount('playback-info'), 0)
  assert.equal(f.interval(), null)
})

test('manual SQL navigation refuses expiry before dispatch, after its guard and before decoder start', async (t) => {
  let now = 1_000
  t.mock.method(Date, 'now', () => now)
  for (const delay of ['authorization', 'guard', 'mode']) {
    now = 1_000
    const f = await fixture(t)
    f.options.resolver.resolve = async () => ({
      source: 'https://cdn.example/short.flac',
      expiresAt: 2_000
    })
    if (delay === 'authorization')
      f.options.authorize = async (source) => {
        now = 2_000
        return source
      }
    if (delay === 'guard') {
      const rebind = f.engine.rebindQueue.bind(f.engine)
      f.engine.rebindQueue = async (request) => {
        const result = await rebind(request)
        now = 2_000
        return result
      }
    }
    if (delay === 'mode') {
      const setMode = f.engine.setPlayMode.bind(f.engine)
      f.engine.setPlayMode = async (mode) => {
        await setMode(mode)
        now = 2_000
      }
    }
    await assert.rejects(navigateAfterglowLibraryQueue(1, f.options), /no_resumable_track/)
    assert.equal(f.transport.includes('play'), false, delay)
    assert.equal(f.transport.includes('load'), delay === 'mode', delay)
    if (delay === 'mode') {
      assert.equal(f.engine.info.state, 'stopped')
      assert.equal(f.db.getLibraryQueue(f.queue.id).index, 400)
      assert.equal(f.session.getCachedSession()?.libraryQueue?.entryId, f.entry(400).queueEntryId)
    } else assert.equal(f.db.getLibraryQueue(f.queue.id).index, 399)
  }
})

test('the SQL owner stops once on a timestamped logical cycle, while ignoring a prior cycle after arming', async (t) => {
  const f = await fixture(t, 604)
  await f.maintenance()
  assert.deepEqual(
    f.engine.items.map((item) => item.logicalQueueEnd),
    [true, false]
  )
  f.owner.bindSleepTimerShutdown()
  registerNativeSleepTimerBoundaries(f.engineEvents, f.sleepTimer)
  const cursor = new NativeSleepTimerBoundaryCursor()
  const armed = Date.now()
  f.sleepTimer.configure(
    createSleepTimerState('queueEnd', armed, { defaultMinutes: 1, fadeSeconds: 0 })
  )
  const publish = (time: number, serial: number) => {
    for (const event of cursor.consume({
      trackSerial: serial,
      queueSerial: serial,
      trackTimeMs: time,
      queueTimeMs: time
    })!)
      f.engineEvents.emit('sleep-timer-boundary', event)
  }
  publish(armed - 1000, 1)
  await tick()
  assert.equal(f.engine.info.state, 'playing')
  f.elapseSleep(1000)
  publish(armed + 1, 2)
  publish(armed + 1, 2)
  await tick()
  assert.equal(f.engine.info.state, 'stopped')
  assert.equal(f.transport.filter((call) => call === 'stop').length, 1)
  assert.equal(f.transport.includes('load'), false)
  assert.equal(f.transport.includes('play'), false)
  assert.equal(f.session.getCachedSession()?.sleepTimer, undefined)
})

test('manual SQL navigation and mode changes retain the last playable marker across tail holes', async (t) => {
  const f = await fixture(t, 601)
  f.db.sql
    .prepare('UPDATE queue_entries SET track_id=? WHERE queue_id=? AND position>602')
    .run('missing', f.queue.id)
  const guards: boolean[] = []
  const rebind = f.engine.rebindQueue.bind(f.engine)
  f.engine.rebindQueue = async (request) => {
    if (request.playMode === 'repeat') guards.push(request.items[0].logicalQueueEnd!)
    return rebind(request)
  }
  await f.owner.dispatch({ type: 'next' })
  assert.equal(f.session.getCachedSession()?.libraryQueue?.index, 602)
  assert.equal(f.engine.items[0].logicalQueueEnd, true)
  const loads = f.transport.filter((call) => call === 'load').length
  for (const marker of [false, true, true]) {
    await f.owner.dispatch({ type: 'cycle-play-mode' })
    assert.equal(f.engine.items[0].logicalQueueEnd, marker)
  }
  assert.equal(f.transport.filter((call) => call === 'load').length, loads)
  assert.ok(guards.length >= 4)
  assert.ok(
    guards.every((marker) => marker === false),
    'temporary guards cannot invent queue cycles'
  )
  await f.owner.dispatch({ type: 'next' })
  assert.equal(f.session.getCachedSession()?.libraryQueue?.index, 0)
  assert.equal(f.engine.items[0].logicalQueueEnd, false)
})

test('the production owner executes a minutes timer without a renderer, cancelling slow navigation before stop', async (t) => {
  const f = await fixture(t)
  f.owner.bindSleepTimerShutdown()
  f.sleepTimer.configure(
    createSleepTimerState('minutes', Date.now(), { defaultMinutes: 1, fadeSeconds: 0 })
  )
  assert.equal(f.session.getCachedSession()?.sleepTimer?.active, true)
  const entered = deferred<void>(),
    release = deferred<void>()
  t.after(() => release.resolve())
  f.options.resolver.resolve = async () => {
    entered.resolve()
    await release.promise
    return { source: 'D:/Music/disc.flac', expiresAt: null }
  }
  const navigation = f.owner.dispatch({ type: 'next' })
  await entered.promise
  f.elapseSleep(61_000)
  await tick()
  assert.equal(f.engine.info.state, 'stopped')
  assert.equal(f.transport.filter((call) => call === 'stop').length, 1)
  assert.equal(f.transport.includes('load'), false)
  assert.equal(f.session.getCachedSession()?.sleepTimer, undefined)
  assert.equal(f.engine.info.volume, 0.7)
  assert.equal([...f.timers.values()][0]?.ms, 6_000)
  release.resolve()
  await navigation
  await tick()
  assert.equal(f.transport.includes('play'), false)
})

test('a sleep trigger drains an already-issued manual handoff, then stops its confirmed duplicate occurrence', async (t) => {
  const f = await fixture(t)
  f.owner.bindSleepTimerShutdown()
  f.sleepTimer.configure(
    createSleepTimerState('minutes', Date.now(), { defaultMinutes: 1, fadeSeconds: 0 })
  )
  const entered = deferred<void>(),
    release = deferred<void>()
  t.after(() => release.resolve())
  const load = f.engine.loadQueue.bind(f.engine)
  f.engine.loadQueue = async (items) => {
    await load(items)
    entered.resolve()
    await release.promise
  }
  const navigation = f.owner.dispatch({ type: 'next' })
  await entered.promise
  f.elapseSleep(61_000)
  await tick()
  assert.equal(f.transport.includes('stop'), false)
  release.resolve()
  await navigation
  await tick()
  assert.equal(f.engine.info.state, 'stopped')
  assert.equal(f.session.getCachedSession()?.libraryQueue?.entryId, f.entry(400).queueEntryId)
  assert.equal(f.db.getLibraryQueue(f.queue.id).index, 400)
  assert.deepEqual(f.mapping(), [400])
  assert.equal(f.transport.filter((call) => call === 'play').length, 1)
  assert.equal(f.transport.filter((call) => call === 'stop').length, 1)
})

test('a renderer restore during sleep fade completes shutdown before its live SQL payload is read', async (t) => {
  const f = await fixture(t)
  f.useProductionRestore()
  f.owner.bindSleepTimerShutdown()
  f.sleepTimer.configure(
    createSleepTimerState('trackEnd', Date.now(), { defaultMinutes: 1, fadeSeconds: 120 })
  )
  f.sleepTimer.boundary('trackEnd')
  await tick()
  assert.equal(f.owner.sleepShutdown?.isActive(), true)
  f.owner.phase = 'restoring'
  f.owner.generation++
  f.owner.cancelLibraryControlPreview()
  const payload = (await f.owner.getRestoreState()) as shared.AfterglowRestoreState
  assert.equal(payload.state, 'stopped')
  assert.equal(payload.volume, 0.7)
  assert.equal(f.engine.gain, 1)
  assert.equal(f.owner.sleepShutdown?.isActive(), false)
  assert.equal(f.transport.filter((call) => call === 'stop').length, 1)
  assert.equal(f.transport.includes('load'), false)
  assert.equal(f.session.getCachedSession()?.sleepTimer, undefined)
})

test('cancel/reconfigure and explicit playback revoke renderer-free fade, but volume alone does not', async (t) => {
  const f = await fixture(t)
  f.owner.bindSleepTimerShutdown()
  const arm = () =>
    f.sleepTimer.configure(
      createSleepTimerState('trackEnd', Date.now(), { defaultMinutes: 1, fadeSeconds: 120 })
    )
  arm()
  f.sleepTimer.boundary('trackEnd')
  await tick()
  await f.owner.dispatch({ type: 'set-volume', volume: 0.4 })
  assert.equal(f.owner.sleepShutdown?.isActive(), true)
  assert.equal(f.session.getCachedSession()?.sleepTimer, undefined)
  f.sleepTimer.cancel()
  await tick()
  assert.equal(f.owner.sleepShutdown?.isActive(), false)
  assert.equal(f.engine.gain, 1)
  arm()
  f.sleepTimer.boundary('trackEnd')
  await tick()
  await f.owner.dispatch({ type: 'next' })
  assert.equal(f.owner.sleepShutdown?.isActive(), false)
  assert.equal(f.engine.info.state, 'playing')
  assert.equal(f.engine.info.volume, 0.4)
  assert.equal(f.db.getLibraryQueue(f.queue.id).index, 400)
  assert.equal(f.transport.includes('stop'), false)
})

test('an unconfirmed sleep stop stays explicit instead of starting an automatic restore/retry loop', async (t) => {
  const f = await fixture(t)
  f.owner.bindSleepTimerShutdown()
  f.engine.stop = async () => {
    throw new Error('sleep stop ACK lost')
  }
  f.sleepTimer.configure(
    createSleepTimerState('trackEnd', Date.now(), { defaultMinutes: 1, fadeSeconds: 0 })
  )
  f.sleepTimer.boundary('trackEnd')
  await tick()
  assert.match(f.owner.error ?? '', /sleep stop ACK lost/)
  assert.equal(f.owner.sleepShutdown?.isActive(), true)
  f.owner.bindWindowedAutoRestore()
  await tick()
  assert.equal(f.timers.size, 0)
  assert.equal(f.transport.includes('load'), false)
  assert.equal(f.transport.includes('play'), false)
})

function rendererSleepSnapshot(f: Awaited<ReturnType<typeof fixture>>, triggerRevision: number) {
  const session = f.session.getCachedSession()!
  return {
    queue: [],
    libraryQueue: session.libraryQueue!,
    queueIndex: session.libraryQueue!.index,
    track: session.track,
    position: 12,
    playMode: 'listLoop',
    volume: 0.7,
    playbackRate: 1.25,
    nativeQueueIndices: f.mapping(),
    sleepShutdown: { triggerRevision, startedAt: Date.now() - 60_000, volume: 0.7 }
  }
}

test('the SQL owner accepts one explicit running renderer fade, preserves its occurrence and never replays acceptance', async (t) => {
  const f = await fixture(t)
  f.sleepTimer.configure(
    createSleepTimerState('trackEnd', Date.now(), { defaultMinutes: 1, fadeSeconds: 120 })
  )
  const fired = f.sleepTimer.boundary('trackEnd')!
  f.engine.info.volume = 0.35
  f.owner.bindSleepTimerShutdown()
  assert.equal(
    f.owner.sleepShutdown?.isActive(),
    false,
    'a terminal snapshot does not start shutdown'
  )
  const snapshot = rendererSleepSnapshot(f, fired.triggerRevision!)
  const first = f.owner.setRendererSnapshot(snapshot)
  assert.equal(
    f.owner.setRendererSnapshot(snapshot),
    first,
    'repeated registration returns the same ACK barrier'
  )
  assert.equal(await first, true)
  assert.equal(f.sleepTimer.snapshot()?.shutdownOwner, 'main')
  assert.equal(f.engine.info.volume, 0.7)
  assert.ok(Math.abs(f.engine.gain - 0.5) < 0.02)
  assert.equal(f.session.getCachedSession()?.libraryQueue?.entryId, f.entry(399).queueEntryId)
  assert.deepEqual(f.mapping(), [399])
  assert.equal(f.transport.filter((item) => item === 'volume').length, 1)
  assert.equal(f.transport.includes('load'), false)
  assert.equal(f.transport.includes('play'), false)
  assert.equal(f.transport.includes('stop'), false)
  assert.ok(
    f.transport.findIndex((item) => item.startsWith('gain:')) < f.transport.indexOf('volume')
  )
  f.sleepTimer.cancel()
  await tick()
  assert.equal(
    await f.owner.setRendererSnapshot(snapshot),
    true,
    'late ACK retrieval must not restart cancellation'
  )
  assert.equal(f.owner.sleepShutdown?.isActive(), false)
  assert.equal(f.engine.gain, 1)
  assert.equal(f.transport.filter((item) => item === 'volume').length, 1)
})

test('the SQL owner rejects malformed, stale, changed and unclaimed fade handoffs without touching transport', async (t) => {
  const f = await fixture(t)
  const armed = createSleepTimerState('trackEnd', Date.now(), {
    defaultMinutes: 1,
    fadeSeconds: 120
  })
  f.sleepTimer.configure(armed)
  const fired = f.sleepTimer.boundary('trackEnd')!
  const snapshot = rendererSleepSnapshot(f, fired.triggerRevision!)
  assert.equal(await f.owner.setRendererSnapshot(snapshot), false, 'no main execution owner yet')
  f.owner.bindSleepTimerShutdown()
  for (const sleepShutdown of [
    { ...snapshot.sleepShutdown, triggerRevision: 0 },
    { ...snapshot.sleepShutdown, triggerRevision: 99 },
    { ...snapshot.sleepShutdown, volume: 0.5 },
    { ...snapshot.sleepShutdown, startedAt: Date.now() + 60_000 }
  ])
    assert.equal(await f.owner.setRendererSnapshot({ ...snapshot, sleepShutdown }), false)
  f.sleepTimer.configure(armed)
  assert.equal(await f.owner.setRendererSnapshot(snapshot), false)
  f.sleepTimer.cancel()
  assert.equal(await f.owner.setRendererSnapshot(snapshot), false)
  assert.equal(
    f.transport.some((item) => /^(gain:|volume|stop|load|play)/.test(item)),
    false
  )
})

test('entry checks explicit renderer execution after claiming triggers, and a lost flush reply does not lose an accepted fade', async (t) => {
  const f = await fixture(t)
  f.sleepTimer.configure(
    createSleepTimerState('trackEnd', Date.now(), { defaultMinutes: 1, fadeSeconds: 120 })
  )
  const fired = f.sleepTimer.boundary('trackEnd')!
  f.owner.bindSleepTimerShutdown()
  const snapshot = rendererSleepSnapshot(f, fired.triggerRevision!)
  let requests = 0
  f.session.flushFromRenderer = async () => {
    requests++
    assert.equal(await f.owner.setRendererSnapshot(snapshot), true)
    throw new Error('flush reply lost')
  }
  assert.equal(await f.owner.settleRendererSleepShutdownHandoff(), true)
  assert.equal(requests, 1)
  assert.equal(f.owner.sleepShutdown?.isActive(), true)
  assert.equal(f.engine.info.volume, 0.7)
})

test('entry refuses teardown when an unaccepted renderer fade cannot be read', async (t) => {
  const f = await fixture(t)
  f.sleepTimer.configure(
    createSleepTimerState('trackEnd', Date.now(), { defaultMinutes: 1, fadeSeconds: 120 })
  )
  f.sleepTimer.boundary('trackEnd')
  f.owner.bindSleepTimerShutdown()
  f.session.flushFromRenderer = async () => {
    throw new Error('renderer unavailable')
  }
  assert.equal(await f.owner.settleRendererSleepShutdownHandoff(), false)
  assert.equal(f.owner.sleepShutdown?.isActive(), false)
  assert.equal(f.sleepTimer.snapshot()?.shutdownOwner, undefined)
})

test('production entry retains the UI through a lost flush reply until both handoff ACKs drain', async (t) => {
  const f = await fixture(t)
  f.useProductionEntry()
  f.sleepTimer.configure(
    createSleepTimerState('trackEnd', Date.now(), { defaultMinutes: 1, fadeSeconds: 120 })
  )
  const fired = f.sleepTimer.boundary('trackEnd')!
  const snapshot = rendererSleepSnapshot(f, fired.triggerRevision!)
  const gainHeld = deferred<void>(),
    gainEntered = deferred<void>(),
    volumeHeld = deferred<void>(),
    volumeEntered = deferred<void>()
  const gain = f.engine.setSleepTimerGain.bind(f.engine),
    volume = f.engine.setVolume.bind(f.engine)
  f.engine.setSleepTimerGain = async (next) => {
    if (next < 1) {
      gainEntered.resolve()
      await gainHeld.promise
    }
    await gain(next)
  }
  f.engine.setVolume = async (next) => {
    volumeEntered.resolve()
    await volumeHeld.promise
    await volume(next)
  }
  let requests = 0
  f.session.flushFromRenderer = async () => {
    if (++requests === 1) {
      assert.equal(
        await f.owner.setRendererSnapshot({ ...snapshot, sleepShutdown: undefined }),
        true
      )
      return
    }
    // Ownership is accepted synchronously, but the outer renderer request
    // times out before its nested publish/engine ACK can return.
    void f.owner.setRendererSnapshot(snapshot)
    throw new Error('outer flush timed out')
  }
  let settled = false
  const entering = f.owner.enter().then((status) => {
    settled = true
    return status
  })
  await gainEntered.promise
  await tick()
  assert.equal(requests, 2)
  assert.equal(f.sleepTimer.snapshot()?.shutdownOwner, 'main')
  assert.equal(settled, false)
  assert.equal(f.timers.size, 0, 'no UI teardown timer while gain is unconfirmed')
  gainHeld.resolve()
  await volumeEntered.promise
  await tick()
  assert.equal(settled, false)
  assert.equal(f.timers.size, 0, 'preference ACK is also part of the teardown barrier')
  volumeHeld.resolve()
  assert.equal((await entering).phase, 'active')
  assert.equal(f.timers.size, 1)
  for (const { callback } of [...f.timers.values()]) callback()
  assert.equal(f.transport.filter((item) => item === 'destroy-ui').length, 1)
  assert.equal(f.transport.filter((item) => item === 'volume').length, 1)
  assert.equal(f.transport.includes('load'), false)
  assert.equal(f.transport.includes('play'), false)
})

test('failed production entry releases the shutdown claim and permits the same renderer fade to retry', async (t) => {
  const f = await fixture(t)
  f.useProductionEntry()
  f.sleepTimer.configure(
    createSleepTimerState('trackEnd', Date.now(), { defaultMinutes: 1, fadeSeconds: 120 })
  )
  const fired = f.sleepTimer.boundary('trackEnd')!
  const snapshot = rendererSleepSnapshot(f, fired.triggerRevision!)
  let requests = 0
  f.session.flushFromRenderer = async () => {
    if (++requests % 2 === 1) {
      assert.equal(
        await f.owner.setRendererSnapshot({ ...snapshot, sleepShutdown: undefined }),
        true
      )
      return
    }
    if (requests === 2) throw new Error('renderer unavailable before acceptance')
    assert.equal(await f.owner.setRendererSnapshot(snapshot), true)
  }
  const failed = await f.owner.enter()
  assert.equal(failed.phase, 'inactive')
  assert.equal(failed.error, 'afterglow_sleep_shutdown_handoff_failed')
  assert.equal(f.owner.sleepShutdown, null)
  assert.equal(f.timers.size, 0)
  assert.equal(f.sleepTimer.snapshot()?.shutdownOwner, undefined)
  assert.equal((await f.owner.enter()).phase, 'active')
  assert.equal(f.sleepTimer.snapshot()?.shutdownOwner, 'main')
  assert.equal(requests, 4)
  assert.equal(f.transport.filter((item) => item === 'volume').length, 1)
})

test('production restore during provisional active entry waits for adoption, then stops before recreating UI', async (t) => {
  const f = await fixture(t)
  f.useProductionEntry()
  f.useProductionRestore()
  f.sleepTimer.configure(
    createSleepTimerState('trackEnd', Date.now(), { defaultMinutes: 1, fadeSeconds: 120 })
  )
  const fired = f.sleepTimer.boundary('trackEnd')!
  const snapshot = rendererSleepSnapshot(f, fired.triggerRevision!)
  const held = deferred<void>(),
    entered = deferred<void>()
  const gain = f.engine.setSleepTimerGain.bind(f.engine)
  f.engine.setSleepTimerGain = async (next) => {
    if (next < 1) {
      entered.resolve()
      await held.promise
    }
    await gain(next)
  }
  let requests = 0
  f.session.flushFromRenderer = async () => {
    assert.equal(
      await f.owner.setRendererSnapshot(
        ++requests === 1 ? { ...snapshot, sleepShutdown: undefined } : snapshot
      ),
      true
    )
  }
  f.useProductionRestoreLifecycle(async () => {
    const payload = (await f.owner.getRestoreState()) as shared.AfterglowRestoreState
    assert.equal(payload.state, 'stopped')
    assert.equal(payload.volume, 0.7)
    assert.equal(payload.libraryQueue?.entryId, f.entry(399).queueEntryId)
    assert.equal(payload.queue.length, 0)
  })
  const entering = f.owner.enter()
  await entered.promise
  const restoring = f.owner.restore()
  await tick()
  assert.equal(f.owner.phase, 'active', 'entry is still provisional, not yet restoring')
  assert.equal(f.transport.includes('create-ui'), false)
  assert.equal(f.transport.includes('stop'), false)
  held.resolve()
  assert.equal((await entering).phase, 'active')
  assert.equal((await restoring).phase, 'inactive')
  assert.equal(f.transport.filter((item) => item === 'stop').length, 1)
  assert.ok(f.transport.indexOf('stop') < f.transport.indexOf('create-ui'))
  assert.equal(f.transport.includes('destroy-ui'), false)
  assert.equal(f.timers.size, 0)
  assert.equal(f.owner.sleepShutdown, null)
})

test('restoring during a renderer handoff drains its gain ACK and stops before reading the live SQL payload', async (t) => {
  const f = await fixture(t)
  f.useProductionRestore()
  f.sleepTimer.configure(
    createSleepTimerState('trackEnd', Date.now(), { defaultMinutes: 1, fadeSeconds: 120 })
  )
  const fired = f.sleepTimer.boundary('trackEnd')!
  f.owner.bindSleepTimerShutdown()
  const held = deferred<void>(),
    entered = deferred<void>()
  const gain = f.engine.setSleepTimerGain.bind(f.engine)
  f.engine.setSleepTimerGain = async (next) => {
    if (next < 1) {
      entered.resolve()
      await held.promise
    }
    await gain(next)
  }
  const accepting = f.owner.setRendererSnapshot(rendererSleepSnapshot(f, fired.triggerRevision!))
  await entered.promise
  f.owner.phase = 'restoring'
  const restoring = f.owner.getRestoreState()
  await tick()
  assert.equal(f.transport.includes('stop'), false)
  held.resolve()
  assert.equal(await accepting, true)
  const payload = (await restoring) as shared.AfterglowRestoreState
  assert.equal(payload.state, 'stopped')
  assert.equal(payload.volume, 0.7)
  assert.equal(payload.libraryQueue?.entryId, f.entry(399).queueEntryId)
  assert.equal(payload.queue.length, 0)
  assert.equal(f.transport.filter((item) => item === 'stop').length, 1)
  assert.equal(f.transport.includes('load'), false)
  assert.equal(f.transport.includes('play'), false)
})

test('production owner keeps manual stop responsive while background provider work is pending, and restore cancels it', async (t) => {
  const f = await fixture(t)
  const started = deferred<void>(),
    reply = deferred<void>()
  f.options.resolver.resolve = async () => {
    started.resolve()
    await reply.promise
    return { source: 'D:/Music/disc.flac', expiresAt: null }
  }
  const starting = f.maintenance()
  await started.promise
  await f.owner.dispatch({ type: 'stop' })
  assert.equal(f.engine.info.state, 'stopped')
  f.owner.generation++
  f.owner.phase = 'restoring'
  await f.owner.stopQueueCore()
  reply.resolve()
  await starting
  assert.equal(f.transport.includes('guard'), false)
  assert.equal(f.transport.includes('play'), false)
  assert.deepEqual(f.mapping(), [399])
})

test('production SQL maintenance discards a stale library payload and consumes the latest invalidation', async (t) => {
  const f = await fixture(t)
  const started = deferred<void>(),
    reply = deferred<void>()
  f.options.resolver.resolve = async () => {
    started.resolve()
    await reply.promise
    return { source: 'D:/Music/disc.flac', expiresAt: null }
  }
  const starting = f.maintenance()
  await started.promise
  f.db.patchTracks([
    {
      id: 'cue',
      expectedVersion: f.db.getTracksByIds(['cue']).versions.cue,
      patch: { title: 'Latest metadata' }
    }
  ])
  f.library.emit('changed', f.db.getMetadata().revision)
  reply.resolve()
  await starting
  await f.owner.queueCore!.tick()
  assert.equal(f.engine.items[1].title, 'Latest metadata')
  assert.equal(f.transport.filter((item) => item === 'guard').length, 1)
  assert.equal(f.owner.error, null)
})

test('production owner recovers a late SQL source across the global wrap and cancels its bounded restore timer after play', async (t) => {
  const f = await fixture(t, 604)
  const started = deferred<void>(),
    reply = deferred<void>()
  let resolves = 0
  f.options.resolver.resolve = async () => {
    if (++resolves === 1) {
      started.resolve()
      await reply.promise
    }
    return { source: 'D:/Music/disc.flac', expiresAt: null }
  }
  const run = f.maintenance()
  await started.promise
  f.owner.bindWindowedAutoRestore()
  await tick()
  f.engine.ended = true
  f.engine.info.state = 'stopped'
  f.engineEvents.emit('playback-info', { ...f.engine.info })
  assert.equal(f.timers.size, 1)
  assert.ok([...f.timers.values()][0].ms > 29_000)
  assert.ok([...f.timers.values()][0].ms <= 30_000)
  reply.resolve()
  await run
  assert.deepEqual(f.mapping(), [0, 1])
  assert.equal(f.db.getLibraryQueue(f.queue.id).index, 0)
  assert.equal(f.session.getCachedSession()?.libraryQueue?.entryId, f.entry(0).queueEntryId)
  assert.equal(f.session.getCachedSession()?.playMode, 'listLoop')
  assert.deepEqual(
    (f.session.getCachedSession()?.track as { cueRange: unknown })?.cueRange,
    f.entry(0).track!.cueRange
  )
  assert.equal(f.transport.filter((entry) => entry === 'load').length, 1)
  assert.equal(f.transport.filter((entry) => entry === 'play').length, 1)
  assert.equal(f.timers.size, 0)
  assert.equal(f.restored(), 0)
  assert.ok(f.reads.every((count) => count <= 2))
})

test('a main sleep-timer trigger revokes pending EOF continuation and retains the ordinary restore deadline', async (t) => {
  const f = await fixture(t)
  const started = deferred<void>(),
    reply = deferred<void>()
  f.options.resolver.resolve = async () => {
    started.resolve()
    await reply.promise
    return { source: 'D:/Music/disc.flac', expiresAt: null }
  }
  f.sleepTimer.configure(
    createSleepTimerState('trackEnd', Date.now(), { defaultMinutes: 1, fadeSeconds: 0 })
  )
  const run = f.maintenance()
  await started.promise
  f.owner.bindWindowedAutoRestore()
  await tick()
  f.sleepTimer.boundary('trackEnd')
  f.engine.ended = true
  f.engine.info.state = 'stopped'
  f.engineEvents.emit('playback-info', { ...f.engine.info })
  assert.equal([...f.timers.values()][0].ms, 6_000)
  reply.resolve()
  await run
  assert.equal(f.transport.includes('load'), false)
  assert.equal(f.transport.includes('play'), false)
  assert.equal(f.db.getLibraryQueue(f.queue.id).index, 399)
  ;[...f.timers.values()][0].callback()
  assert.equal(f.restored(), 1)
})

test('an explicit stop cancels EOF provider work and shortens, rather than prolongs, the restore grace', async (t) => {
  const f = await fixture(t)
  const started = deferred<void>(),
    reply = deferred<void>()
  f.options.resolver.resolve = async () => {
    started.resolve()
    await reply.promise
    return { source: 'D:/Music/disc.flac', expiresAt: null }
  }
  const run = f.maintenance()
  await started.promise
  f.owner.bindWindowedAutoRestore()
  await tick()
  f.engine.ended = true
  f.engine.info.state = 'stopped'
  f.engineEvents.emit('playback-info', { ...f.engine.info })
  assert.ok([...f.timers.values()][0].ms > 29_000)
  await f.owner.dispatch({ type: 'stop' })
  assert.equal(f.timers.size, 1)
  assert.equal([...f.timers.values()][0].ms, 6_000)
  const handle = [...f.timers.keys()][0]
  f.engineEvents.emit('playback-info', { ...f.engine.info })
  assert.equal([...f.timers.keys()][0], handle)
  reply.resolve()
  await run
  assert.equal(f.transport.includes('play'), false)
  assert.equal(f.transport.includes('load'), false)
})

test('production dispatcher/owner navigate the complete SQL queue, preserve duplicate CUE and restart bounded maintenance', async (t) => {
  const f = await fixture(t)
  await f.owner.dispatch({ type: 'previous' })
  assert.equal(f.owner.error, null)
  assert.equal(f.db.getLibraryQueue(f.queue.id).index, 398)
  assert.equal(f.session.getCachedSession()?.libraryQueue?.entryId, f.entry(398).queueEntryId)
  assert.deepEqual(f.mapping(), [398])
  assert.deepEqual(plain(f.engine.items[0].cueRange), {
    startSeconds: 90,
    endSeconds: 180,
    virtualPregapSeconds: 1
  })
  assert.equal(f.engine.info.playbackRate, 1.25)
  assert.equal(f.engine.info.volume, 0.7)
  await f.owner.dispatch({ type: 'next' })
  assert.equal(f.db.getLibraryQueue(f.queue.id).index, 399)
  assert.equal(f.session.getCachedSession()?.playMode, 'listLoop')
  assert.deepEqual(plain(f.session.getCachedQueue()), [])
  assert.ok(f.reads.every((count) => count === 1))
  assert.deepEqual(f.edits, ['select', 'select'])
  assert.equal(f.transport.includes('native-next'), false)
  assert.equal(f.transport.includes('native-previous'), false)
  assert.equal(f.transport.filter((call) => call === 'core-start').length, 2)
})

test('manual previous/next wraps the complete extent, never the one-entry native window', async (t) => {
  const f = await fixture(t, 0)
  await f.owner.dispatch({ type: 'previous' })
  assert.equal(f.session.getCachedSession()?.libraryQueue?.index, 604)
  await f.owner.dispatch({ type: 'next' })
  assert.equal(f.session.getCachedSession()?.libraryQueue?.index, 0)
  assert.deepEqual(f.mapping(), [0])
})

test('provider/authorization failure leaves both SQL and native cursors intact', async (t) => {
  const f = await fixture(t)
  f.options.authorize = async () => {
    throw new Error('not authorized')
  }
  await assert.rejects(navigateAfterglowLibraryQueue(1, f.options), /not authorized/)
  assert.equal(f.db.getLibraryQueue(f.queue.id).index, 399)
  assert.deepEqual(f.transport, [])
  assert.deepEqual(f.edits, [])
})

test('restoring during a slow provider read cancels undispatched navigation and queued media keys', async (t) => {
  const f = await fixture(t)
  const started = deferred<void>(),
    held = deferred<void>()
  f.options.resolver.resolve = async () => {
    started.resolve()
    await held.promise
    return { source: 'D:/Music/disc.flac', expiresAt: null }
  }
  const first = f.owner.dispatch({ type: 'next' })
  await started.promise
  const second = f.owner.dispatch({ type: 'previous' })
  f.owner.phase = 'restoring'
  f.owner.generation++
  f.owner.cancelLibraryControlPreview()
  await f.owner.transportMutationDrain
  await Promise.all([first, second])
  assert.equal(f.transport.includes('load'), false)
  assert.equal(f.transport.includes('core-start'), false)
  assert.deepEqual(f.edits, [])
  held.resolve()
  await tick()
  assert.deepEqual(f.edits, [])
})

test('stop cancels a manual provider preview and older queued navigation before the provider replies', async (t) => {
  const f = await fixture(t)
  const entered = deferred<void>(),
    release = deferred<void>()
  t.after(() => release.resolve())
  f.options.resolver.resolve = async () => {
    entered.resolve()
    await release.promise
    return { source: 'D:/Music/disc.flac', expiresAt: null }
  }
  const navigating = f.owner.dispatch({ type: 'next' })
  await entered.promise
  const queued = f.owner.dispatch({ type: 'previous' })
  let stopped = false
  const stopping = f.owner.dispatch({ type: 'stop' }).then(() => {
    stopped = true
  })
  t.after(() => Promise.all([navigating, queued, stopping]))
  await tick()
  assert.equal(stopped, true, 'stop must not wait for the provider reply')
  assert.equal(f.engine.info.state, 'stopped')
  assert.equal(f.db.getLibraryQueue(f.queue.id).index, 399)
  assert.deepEqual(f.edits, [])
  assert.equal(f.transport.includes('guard'), false)
  assert.equal(f.transport.includes('load'), false)
  release.resolve()
  await Promise.all([navigating, queued, stopping])
  await tick()
  assert.equal(f.transport.includes('play'), false)
  assert.equal(f.transport.filter((call) => call === 'stop').length, 1)
  assert.equal(f.owner.error, null)
})

for (const command of [
  { type: 'pause' },
  { type: 'toggle-play' },
  { type: 'play' },
  { type: 'seek', positionSeconds: 23 },
  { type: 'seek-by', deltaSeconds: 5 }
] as const) {
  test(`${command.type} cancels read-only authorization and consumes its late rejection`, async (t) => {
    const f = await fixture(t)
    const entered = deferred<void>(),
      release = deferred<void>()
    t.after(() => release.resolve())
    f.options.authorize = async () => {
      entered.resolve()
      await release.promise
      throw new Error('late authorization failure')
    }
    const navigating = f.owner.dispatch({ type: 'next' })
    await entered.promise
    let completed = false
    const interrupting = f.owner.dispatch(command).then(() => {
      completed = true
    })
    t.after(() => Promise.all([navigating, interrupting]))
    await tick()
    assert.equal(completed, true, 'the new intent must not wait for authorization')
    assert.equal(f.transport.includes('load'), false)
    assert.deepEqual(f.edits, [])
    release.resolve()
    await Promise.all([navigating, interrupting])
    await tick()
    assert.equal(f.owner.error, null)
    assert.equal(f.db.getLibraryQueue(f.queue.id).index, 399)
    if (command.type === 'pause' || command.type === 'toggle-play')
      assert.equal(f.engine.info.state, 'paused')
    if (command.type === 'seek') assert.equal(f.engine.info.position, 23)
    if (command.type === 'seek-by') assert.equal(f.engine.info.position, 17)
  })
}

test('volume changes do not cancel navigation and consecutive manual steps retain their order', async (t) => {
  const f = await fixture(t)
  const entered = deferred<void>(),
    release = deferred<void>()
  t.after(() => release.resolve())
  f.options.resolver.resolve = async () => {
    entered.resolve()
    await release.promise
    return { source: 'D:/Music/disc.flac', expiresAt: null }
  }
  const first = f.owner.dispatch({ type: 'next' })
  await entered.promise
  const volume = f.owner.dispatch({ type: 'set-volume', volume: 0.4 })
  const second = f.owner.dispatch({ type: 'next' })
  t.after(() => Promise.all([first, volume, second]))
  await tick()
  assert.equal(f.transport.includes('volume'), false)
  release.resolve()
  await Promise.all([first, volume, second])
  assert.equal(f.db.getLibraryQueue(f.queue.id).index, 401)
  assert.equal(f.engine.info.volume, 0.4)
  assert.deepEqual(f.edits, ['select', 'select'])
  assert.equal(f.owner.error, null)
})

test('stop waits for an issued manual load/play/cursor handoff, then leaves its exact SQL selection stopped', async (t) => {
  const f = await fixture(t)
  const entered = deferred<void>(),
    release = deferred<void>()
  t.after(() => release.resolve())
  const load = f.engine.loadQueue.bind(f.engine)
  f.engine.loadQueue = async (items) => {
    await load(items)
    entered.resolve()
    await release.promise
  }
  const navigating = f.owner.dispatch({ type: 'next' })
  await entered.promise
  let stopped = false
  const stopping = f.owner.dispatch({ type: 'stop' }).then(() => {
    stopped = true
  })
  t.after(() => Promise.all([navigating, stopping]))
  await tick()
  assert.equal(stopped, false, 'a dispatched mutation must drain')
  assert.equal(f.transport.includes('stop'), false)
  release.resolve()
  await Promise.all([navigating, stopping])
  assert.equal(f.engine.info.state, 'stopped')
  assert.equal(f.db.getLibraryQueue(f.queue.id).index, 400)
  assert.equal(f.session.getCachedSession()?.libraryQueue?.entryId, f.entry(400).queueEntryId)
  assert.deepEqual(f.mapping(), [400])
  assert.equal(f.transport.filter((call) => call === 'play').length, 1)
  assert.ok(f.transport.indexOf('play') < f.transport.indexOf('stop'))
  assert.equal(f.owner.error, null)
})

test('restoring drains an already-dispatched load/play/cursor handoff before release', async (t) => {
  const f = await fixture(t)
  const started = deferred<void>(),
    held = deferred<void>()
  const loadQueue = f.engine.loadQueue.bind(f.engine)
  f.engine.loadQueue = async (items) => {
    await loadQueue(items)
    started.resolve()
    await held.promise
  }
  const navigating = f.owner.dispatch({ type: 'next' })
  await started.promise
  f.owner.phase = 'restoring'
  f.owner.generation++
  let drained = false
  const stopping = f.owner.transportMutationDrain.then(() => {
    drained = true
  })
  await tick()
  assert.equal(drained, false)
  held.resolve()
  await Promise.all([navigating, stopping])
  assert.equal(f.db.getLibraryQueue(f.queue.id).index, 400)
  assert.deepEqual(f.mapping(), [400])
  assert.equal(f.engine.info.state, 'playing')
  assert.equal(f.transport.includes('core-start'), false)
  assert.equal(f.transport.includes('presentation-start'), false)
})

test('an EOF during preview is rejected before mutation, rather than navigating twice', async (t) => {
  const f = await fixture(t)
  f.options.authorize = async (source) => {
    f.engine.info.queueIndex = 1
    return source
  }
  await assert.rejects(navigateAfterglowLibraryQueue(1, f.options), /queue_changed/)
  assert.deepEqual(f.transport, [])
  assert.deepEqual(f.edits, [])
})

test('an external SQL edit during resolution is rejected before native transport', async (t) => {
  const f = await fixture(t)
  f.options.authorize = async (source) => {
    f.db.editLibraryQueue(f.queue.id, f.queue.revision, {
      kind: 'select',
      entryId: f.entry(401).queueEntryId
    })
    return source
  }
  await assert.rejects(navigateAfterglowLibraryQueue(1, f.options), /queue_changed/)
  assert.deepEqual(f.transport, [])
})

test('unknown cursor acknowledgement is not replayed or rolled back after native playback started', async (t) => {
  const f = await fixture(t)
  const edit = f.database.editLibraryQueue
  f.database.editLibraryQueue = async (...args) => {
    await edit(...args)
    throw new Error('lost reply')
  }
  await assert.rejects(navigateAfterglowLibraryQueue(1, f.options), /lost reply/)
  assert.equal(f.db.getLibraryQueue(f.queue.id).index, 400)
  assert.equal(f.engine.items[0].queueEntryId, f.entry(400).queueEntryId)
  assert.deepEqual(f.edits, ['select'])
  assert.deepEqual(f.transport, ['guard', 'load', 'mode:sequential', 'play'])
})

test('failed native play leaves a stopped SQL target which the ordinary play command can resume', async (t) => {
  const f = await fixture(t)
  f.engine.play = async () => {
    throw new Error('decoder failed')
  }
  await assert.rejects(navigateAfterglowLibraryQueue(1, f.options), /decoder failed/)
  assert.equal(f.engine.info.state, 'stopped')
  assert.equal(f.session.getCachedSession()?.libraryQueue?.index, 400)
  f.engine.info.source = 'D:/Music/old-decoder.flac'
  const sources: string[] = []
  f.engine.play = async (source) => {
    sources.push(source)
    return { nativeStarted: true, fallbackReason: '' }
  }
  await f.dispatch({ type: 'play' })
  assert.deepEqual(sources, ['D:/Music/disc.flac'])
})

test('an unknown native load never commits a cursor or automatically replays transport', async (t) => {
  const f = await fixture(t)
  f.engine.loadQueue = async () => {
    f.transport.push('load')
    f.engine.token = ''
    throw new Error('unknown native load')
  }
  await assert.rejects(navigateAfterglowLibraryQueue(1, f.options), /unknown native load/)
  assert.deepEqual(f.transport, ['guard', 'load'])
  assert.deepEqual(f.edits, [])
})

test('superseded native play is never stopped or persisted over the newer transport', async (t) => {
  const f = await fixture(t)
  f.engine.play = async () => ({ nativeStarted: false, fallbackReason: '', superseded: true })
  await assert.rejects(navigateAfterglowLibraryQueue(1, f.options), /native_playback/)
  assert.equal(f.transport.includes('stop'), false)
  assert.deepEqual(f.edits, [])
})

test('array navigation keeps the original native next/previous entry points', async (t) => {
  const f = await fixture(t)
  await f.session.adoptRendererSnapshot({
    queue: [{ id: 'array' }],
    queueIndex: 0,
    track: { id: 'array' },
    position: 0,
    playMode: 'sequential',
    volume: 1,
    playbackRate: 1
  })
  await f.owner.dispatch({ type: 'next' })
  await f.owner.dispatch({ type: 'previous' })
  assert.deepEqual(f.transport, ['native-next', 'native-previous'])
})

test('session-file persistence failure does not disable the live SQL navigation contract', async (t) => {
  const f = await fixture(t)
  f.session.flush = async () => {
    throw new Error('session file locked')
  }
  await f.owner.dispatch({ type: 'next' })
  assert.equal(f.owner.error, null)
  assert.equal(f.session.getCachedSession()?.libraryQueue?.index, 400)
  assert.equal(f.engine.info.state, 'playing')
})

test('the atomic native cursor guard rejects an intervening EOF without loading or replaying a target', async (t) => {
  const f = await fixture(t)
  f.engine.rebindQueue = async () => {
    f.transport.push('guard')
    return null as never
  }
  await assert.rejects(navigateAfterglowLibraryQueue(1, f.options), /queue_changed/)
  assert.deepEqual(f.transport, ['guard'])
  assert.deepEqual(f.edits, [])
  assert.deepEqual(f.mapping(), [399])
})

test('SQL mode cycling uses the logical mode, preserves the three-mode cycle, and never replays audio', async (t) => {
  const f = await fixture(t)
  for (const mode of ['repeat', 'sequential', 'listLoop']) {
    await f.owner.dispatch({ type: 'cycle-play-mode' })
    assert.equal(f.owner.error, null)
    assert.equal(f.session.getCachedSession()?.playMode, mode)
    assert.equal(f.db.getLibraryQueue(f.queue.id).playMode, mode)
    assert.equal(f.engine.info.playMode, mode === 'repeat' ? 'repeat' : 'sequential')
    assert.equal(f.engine.info.state, 'playing')
    assert.equal(f.engine.info.position, 12)
    assert.equal(f.engine.info.playbackRate, 1.25)
    assert.equal(f.engine.info.volume, 0.7)
    assert.deepEqual(f.mapping(), [399])
  }
  assert.deepEqual(f.edits, ['mode', 'mode', 'mode'])
  assert.ok(
    !f.transport.some(
      (action) => ['load', 'play', 'stop'].includes(action) || action.startsWith('mode:')
    )
  )
})

test('SQL shuffle anchors the exact duplicate occurrence, restores original order on exit and preserves paused CUE playback', async (t) => {
  const f = await fixture(t)
  const original = Array.from({ length: 605 }, (_, index) => f.entry(index).queueEntryId)
  const selected = original[399]
  f.engine.info.state = 'paused'
  f.engine.items[0].cueRange = {
    startSeconds: 90,
    endSeconds: 180,
    pregapSeconds: 0,
    virtualPregapSeconds: 1
  }
  await f.owner.dispatch({ type: 'set-play-mode', mode: 'shuffle' })
  assert.equal(f.owner.error, null)
  assert.equal(f.db.getLibraryQueue(f.queue.id).order, 'shuffle')
  assert.equal(f.session.getCachedSession()?.libraryQueue?.index, 0)
  assert.equal(f.session.getCachedSession()?.libraryQueue?.entryId, selected)
  assert.deepEqual(f.mapping(), [0])
  assert.equal(f.engine.items[0].queueEntryId, selected)
  assert.deepEqual(plain(f.engine.items[0].cueRange), {
    startSeconds: 90,
    endSeconds: 180,
    pregapSeconds: 0,
    virtualPregapSeconds: 1
  })
  assert.equal(f.engine.info.state, 'paused')
  assert.equal(f.engine.info.position, 12)
  await f.owner.dispatch({ type: 'set-play-mode', mode: 'repeat' })
  assert.equal(f.owner.error, null)
  assert.equal(f.db.getLibraryQueue(f.queue.id).order, 'original')
  assert.equal(f.session.getCachedSession()?.libraryQueue?.index, 399)
  assert.equal(f.session.getCachedSession()?.playMode, 'repeat')
  assert.deepEqual(
    Array.from({ length: 605 }, (_, index) => f.entry(index).queueEntryId),
    original
  )
  assert.deepEqual(f.edits, ['mode', 'mode'])
  assert.deepEqual(f.mapping(), [399])
  assert.deepEqual(plain(f.session.getCachedQueue()), [])
  assert.ok(f.reads.every((size) => size === 1))
})

test('rapid SQL mode requests serialize their order edits and leave only the last logical mode live', async (t) => {
  const f = await fixture(t)
  await Promise.all(
    ['shuffle', 'sequential', 'shuffle'].map((mode) =>
      f.owner.dispatch({ type: 'set-play-mode', mode: mode as 'shuffle' | 'sequential' })
    )
  )
  assert.equal(f.owner.error, null)
  assert.equal(f.session.getCachedSession()?.playMode, 'shuffle')
  assert.equal(f.db.getLibraryQueue(f.queue.id).order, 'shuffle')
  assert.deepEqual(f.edits, ['mode', 'mode', 'mode'])
  assert.equal(f.engine.info.position, 12)
  assert.equal(f.engine.info.state, 'playing')
})

test('refused or unsupported native mode guards never edit SQL or fall back to reloading', async (t) => {
  const f = await fixture(t)
  f.engine.rebindQueue = async () => null as never
  await f.owner.dispatch({ type: 'set-play-mode', mode: 'shuffle' })
  assert.equal(f.owner.error, 'afterglow_library_queue_changed')
  assert.equal(f.session.getCachedSession()?.playMode, 'listLoop')
  assert.deepEqual(f.edits, [])
  assert.equal(f.owner.pendingLibraryMode, null)
  assert.equal(f.transport.includes('load'), false)
})

test('an unknown native guard is never followed by a SQL order edit or replay', async (t) => {
  const f = await fixture(t)
  let guards = 0
  f.engine.rebindQueue = async () => {
    guards++
    f.engine.token = ''
    throw new Error('unknown guard reply')
  }
  await f.owner.dispatch({ type: 'set-play-mode', mode: 'shuffle' })
  assert.equal(guards, 1)
  assert.deepEqual(f.edits, [])
  assert.equal(f.owner.pendingLibraryMode, null)
  assert.equal(f.session.getCachedSession()?.playMode, 'listLoop')
  assert.equal(f.owner.error, 'unknown guard reply')
})

test('a lost SQL order acknowledgement is reconciled by reading the outcome, never reshuffled or replayed', async (t) => {
  const f = await fixture(t)
  const edit = f.database.editLibraryQueue
  f.database.editLibraryQueue = async (...args) => {
    await edit(...args)
    throw new Error('lost SQL ACK')
  }
  await f.owner.dispatch({ type: 'set-play-mode', mode: 'shuffle' })
  assert.equal(f.owner.error, null)
  assert.deepEqual(f.edits, ['mode'])
  assert.equal(f.session.getCachedSession()?.playMode, 'shuffle')
  assert.equal(
    f.session.getCachedSession()?.libraryQueue?.revision,
    f.db.getLibraryQueue(f.queue.id).revision
  )
  assert.deepEqual(f.mapping(), [0])
  assert.equal(f.owner.pendingLibraryMode, null)
})

test('a rejected SQL order write retains the old logical mode and is retryable without native replay', async (t) => {
  const f = await fixture(t)
  const edit = f.database.editLibraryQueue
  f.database.editLibraryQueue = async () => {
    throw new Error('database busy')
  }
  await f.owner.dispatch({ type: 'set-play-mode', mode: 'shuffle' })
  assert.equal(f.owner.error, 'database busy')
  assert.equal(f.session.getCachedSession()?.playMode, 'listLoop')
  assert.equal(f.owner.pendingLibraryMode, null)
  assert.deepEqual(f.mapping(), [399])
  assert.equal(f.engine.info.playMode, 'sequential')
  f.database.editLibraryQueue = edit
  await f.owner.dispatch({ type: 'set-play-mode', mode: 'shuffle' })
  assert.equal(f.owner.error, null)
  assert.deepEqual(f.edits, ['mode'])
})

test('mode-only SQL changes persist a revision and reconcile lost replies even when the occurrence order is unchanged', async (t) => {
  const f = await fixture(t)
  f.useProductionRestore()
  await f.owner.dispatch({ type: 'set-play-mode', mode: 'repeat' })
  const before = f.db.getLibraryQueue(f.queue.id)
  const edit = f.database.editLibraryQueue
  f.database.editLibraryQueue = async (...args) => {
    await edit(...args)
    throw new Error('lost mode-only ACK')
  }
  await f.owner.dispatch({ type: 'set-play-mode', mode: 'listLoop' })
  const queue = f.db.getLibraryQueue(f.queue.id)
  assert.equal(f.owner.error, null)
  assert.equal(queue.revision, before.revision + 1)
  assert.equal(queue.playMode, 'listLoop')
  assert.equal(queue.order, before.order)
  assert.equal(queue.index, before.index)
  assert.equal(queue.selectedEntryId, before.selectedEntryId)
  const restored = (await f.owner.getRestoreState()) as shared.AfterglowRestoreState
  assert.equal(restored.playMode, 'listLoop')
  assert.equal(restored.libraryQueue!.revision, queue.revision)
  assert.deepEqual(f.edits, ['mode', 'mode'])
  assert.ok(!f.transport.some((action) => ['load', 'play', 'stop'].includes(action)))
})

test('unreadable SQL mode outcomes keep a compact checkpoint, allow stop and recover before the next navigation', async (t) => {
  const f = await fixture(t)
  const get = f.database.getLibraryQueue,
    edit = f.database.editLibraryQueue
  let unavailable = false
  f.database.editLibraryQueue = async (...args) => {
    const result = await edit(...args)
    unavailable = true
    return result
  }
  f.database.getLibraryQueue = async (id) => {
    if (unavailable) throw new Error('SQL outcome unavailable')
    return get(id)
  }
  await f.owner.dispatch({ type: 'set-play-mode', mode: 'shuffle' })
  assert.equal(f.owner.error, 'SQL outcome unavailable')
  assert.ok(f.owner.pendingLibraryMode)
  assert.equal(f.engine.info.playMode, 'repeat')
  assert.equal(f.session.getCachedSession()?.playMode, 'listLoop')
  assert.equal(f.transport.includes('presentation-start'), false)
  assert.equal(f.transport.includes('core-start'), false)
  await f.owner.dispatch({ type: 'stop' })
  assert.equal(f.engine.info.state, 'stopped')
  unavailable = false
  f.database.editLibraryQueue = edit
  const target = f.entry(1).queueEntryId
  await f.owner.dispatch({ type: 'next' })
  assert.equal(f.owner.error, null)
  assert.equal(f.owner.pendingLibraryMode, null)
  assert.equal(f.session.getCachedSession()?.playMode, 'shuffle')
  assert.equal(f.session.getCachedSession()?.libraryQueue?.entryId, target)
  assert.deepEqual(f.edits, ['mode', 'select'])
})

test('concurrent restore payload requests share one SQL outcome recovery and its final native mode handoff', async (t) => {
  const f = await fixture(t)
  f.useProductionRestore()
  const get = f.database.getLibraryQueue,
    edit = f.database.editLibraryQueue
  let unavailable = false
  f.database.editLibraryQueue = async (...args) => {
    const result = await edit(...args)
    unavailable = true
    return result
  }
  f.database.getLibraryQueue = async (id) => {
    if (unavailable) throw new Error('SQL outcome unavailable')
    return get(id)
  }
  await f.owner.dispatch({ type: 'set-play-mode', mode: 'shuffle' })
  f.owner.generation++
  f.owner.phase = 'restoring'
  unavailable = false
  const entered = deferred<void>(),
    release = deferred<void>()
  let recoveries = 0
  f.database.getLibraryQueue = async (id) => {
    recoveries++
    entered.resolve()
    await release.promise
    return get(id)
  }
  const one = f.owner.getRestoreState(),
    two = f.owner.getRestoreState()
  await entered.promise
  release.resolve()
  const payloads = (await Promise.all([one, two])) as shared.AfterglowRestoreState[]
  assert.ok(
    recoveries >= 2 && recoveries <= 3,
    'one recovery plus coalesced read-only payload validation'
  )
  for (const payload of payloads) {
    assert.equal(payload.playMode, 'shuffle')
    assert.equal(payload.libraryQueue!.index, 0)
    assert.deepEqual(plain(payload.nativeQueueIndices), [0])
    assert.deepEqual(plain(payload.queue), [])
  }
  assert.deepEqual(f.edits, ['mode'])
  assert.equal(f.transport.filter((action) => action === 'guard').length, 2)
})

test('restore drains a dispatched SQL mode transaction and queued commands cannot run under the restored owner', async (t) => {
  const f = await fixture(t)
  f.useProductionRestore()
  const edit = f.database.editLibraryQueue
  const entered = deferred<void>(),
    release = deferred<void>()
  f.database.editLibraryQueue = async (...args) => {
    entered.resolve()
    await release.promise
    return edit(...args)
  }
  const changing = f.owner.dispatch({ type: 'set-play-mode', mode: 'shuffle' })
  await entered.promise
  const queued = f.owner.dispatch({ type: 'set-play-mode', mode: 'sequential' })
  f.owner.generation++
  f.owner.phase = 'restoring'
  let restored = false
  const reading = f.owner.getRestoreState().then((value) => {
    restored = true
    return value
  })
  await tick()
  assert.equal(restored, false)
  release.resolve()
  await Promise.all([changing, queued, reading])
  assert.deepEqual(f.edits, ['mode'])
  assert.equal(f.session.getCachedSession()?.playMode, 'shuffle')
  assert.deepEqual(f.mapping(), [0])
  assert.equal(f.transport.includes('core-start'), false)
})

test('restore does not wait for a cancelled, undispatched SQL mode preview', async (t) => {
  const f = await fixture(t)
  f.useProductionRestore()
  const get = f.database.getLibraryQueue
  const entered = deferred<void>(),
    release = deferred<void>()
  let reads = 0
  f.database.getLibraryQueue = async (id) => {
    if (++reads === 2) {
      entered.resolve()
      await release.promise
    }
    return get(id)
  }
  const changing = f.owner.dispatch({ type: 'set-play-mode', mode: 'shuffle' })
  await entered.promise
  f.owner.generation++
  f.owner.phase = 'restoring'
  await f.owner.getRestoreState()
  assert.deepEqual(f.edits, [])
  assert.equal(f.transport.includes('guard'), false)
  release.resolve()
  await changing
  assert.deepEqual(f.edits, [])
})

test('SQL mode control rejects renderer-owned heart without changing native or SQL state', async (t) => {
  const f = await fixture(t)
  await f.owner.dispatch({ type: 'set-play-mode', mode: 'heart' })
  assert.equal(f.owner.error, 'afterglow_requires_renderer_play_mode')
  assert.deepEqual(f.edits, [])
  assert.equal(f.transport.includes('guard'), false)
  assert.equal(f.session.getCachedSession()?.playMode, 'listLoop')
})

test('explicit restore drains an unknown handoff and native Stop ACK before recreating a stopped SQL UI', async (t) => {
  const f = await fixture(t)
  f.useProductionRestore()
  const mutation = deferred<void>(),
    stopEntered = deferred<void>(),
    stopped = deferred<void>()
  f.owner.transportMutationDrain = mutation.promise
  f.engine.token = ''
  const stop = f.engine.stopForQueueRecovery.bind(f.engine)
  f.engine.stopForQueueRecovery = async () => {
    stopEntered.resolve()
    await stopped.promise
    return stop()
  }
  let payload: shared.AfterglowRestoreState | undefined
  f.useProductionRestoreLifecycle(async () => {
    payload = (await f.owner.getRestoreState()) as shared.AfterglowRestoreState
    assert.equal(payload.recovery, 'native-queue-unknown')
    assert.equal(payload.state, 'stopped')
    assert.equal(payload.libraryQueue?.entryId, f.entry(399).queueEntryId)
    assert.deepEqual(plain(payload.nativeQueueIndices), [])
    assert.equal(payload.queueToken, '')
  })
  const restoring = f.owner.restore()
  await tick()
  assert.equal(f.transport.includes('stop'), false)
  assert.equal(f.transport.includes('create-ui'), false)
  mutation.resolve()
  await stopEntered.promise
  assert.equal(f.transport.includes('create-ui'), false)
  stopped.resolve()
  const status = await restoring
  assert.equal(status.phase, 'inactive')
  assert.ok(payload)
  assert.ok(f.transport.indexOf('stop') < f.transport.indexOf('create-ui'))
  assert.equal(f.transport.filter((item) => item === 'stop').length, 1)
  assert.equal(f.transport.includes('guard'), false)
  assert.equal(f.transport.includes('load'), false)
  assert.equal(f.transport.includes('play'), false)
  assert.deepEqual(f.edits, [])
})

test('unknown native authority blocks unsafe media controls and read-only restore never sends Stop', async (t) => {
  const f = await fixture(t)
  f.useProductionRestore()
  f.engine.token = ''
  f.engine.info.state = 'paused'
  for (const command of [
    { type: 'play' },
    { type: 'toggle-play' },
    { type: 'next' },
    { type: 'seek', positionSeconds: 30 },
    { type: 'set-play-mode', mode: 'shuffle' }
  ] as shared.AfterglowTransportCommand[])
    await f.owner.dispatch(command)
  assert.equal(f.owner.error, 'afterglow_library_queue_changed')
  assert.equal(f.transport.includes('pause'), false)
  assert.equal(f.transport.includes('play'), false)
  assert.equal(f.transport.includes('seek'), false)
  await assert.rejects(f.owner.getRestoreState(), /queue_changed/)
  assert.equal(f.transport.includes('stop'), false)
  f.owner.bindWindowedAutoRestore()
  f.engineEvents.emit('playback-info', { ...f.engine.info, state: 'stopped' })
  await tick()
  assert.equal(
    f.timers.size,
    0,
    'unknown authority cannot schedule automatic Stop/recovery retries'
  )
  assert.deepEqual(f.edits, [])
})

test('a failed recovery Stop stays explicit and the next user restore may retry Stop, never the queue mutation', async (t) => {
  const f = await fixture(t)
  f.useProductionRestore()
  f.engine.token = ''
  const stop = f.engine.stopForQueueRecovery.bind(f.engine)
  f.engine.stopForQueueRecovery = async () => {
    throw new Error('afterglow_queue_recovery_stop_failed')
  }
  const status = await f.owner.restore()
  assert.equal(status.phase, 'active')
  assert.equal(status.error, 'afterglow_queue_recovery_stop_failed')
  assert.equal(f.transport.includes('create-ui'), false)
  assert.equal(f.transport.includes('core-start'), false)
  assert.equal(f.timers.size, 0)
  f.engine.stopForQueueRecovery = stop
  f.useProductionRestoreLifecycle(async () => {
    const state = (await f.owner.getRestoreState()) as shared.AfterglowRestoreState
    assert.equal(state.recovery, 'native-queue-unknown')
  })
  assert.equal((await f.owner.restore()).phase, 'inactive')
  assert.equal(f.transport.filter((item) => item === 'stop').length, 1)
  assert.equal(f.transport.includes('guard'), false)
  assert.equal(f.transport.includes('load'), false)
})

test('normal production restore retains its uninterrupted native adoption and issues no recovery Stop', async (t) => {
  const f = await fixture(t)
  f.useProductionRestore()
  f.useProductionRestoreLifecycle(async () => {
    const state = (await f.owner.getRestoreState()) as shared.AfterglowRestoreState
    assert.equal(state.recovery, undefined)
    assert.equal(state.queueToken, f.engine.token)
    assert.equal(state.state, 'playing')
  })
  assert.equal((await f.owner.restore()).phase, 'inactive')
  assert.equal(f.transport.includes('stop'), false)
  assert.equal(f.transport.includes('load'), false)
  assert.equal(f.transport.includes('play'), false)
})

test('an unknown manual SQL load restores the durable selection whether or not native applied the target', async (t) => {
  for (const applied of [false, true]) {
    await t.test(String(applied), async (t) => {
      const f = await fixture(t)
      f.useProductionRestore()
      const load = f.engine.loadQueue.bind(f.engine)
      let calls = 0
      f.engine.loadQueue = async (items) => {
        calls++
        if (applied) await load(items)
        f.engine.token = ''
        throw new Error('load reply lost')
      }
      await f.owner.dispatch({ type: 'next' })
      assert.equal(f.owner.error, 'load reply lost')
      assert.equal(f.session.getCachedSession()?.libraryQueue?.index, 399)
      f.useProductionRestoreLifecycle(async () => {
        const state = (await f.owner.getRestoreState()) as shared.AfterglowRestoreState
        assert.equal(state.recovery, 'native-queue-unknown')
        assert.equal(state.libraryQueue?.entryId, f.entry(399).queueEntryId)
        assert.equal(state.libraryQueue?.index, 399)
      })
      assert.equal((await f.owner.restore()).phase, 'inactive')
      assert.equal(calls, 1, 'neither the unknown load nor its guard is replayed')
      assert.equal(f.transport.filter((item) => item === 'guard').length, 1)
      assert.equal(f.transport.filter((item) => item === 'stop').length, 1)
      assert.equal(f.transport.includes('play'), false)
      assert.deepEqual(f.edits, [])
    })
  }
})

test('a lost final native mode ACK during restore becomes stopped recovery of the committed SQL mode', async (t) => {
  const f = await fixture(t)
  f.useProductionRestore()
  const edit = f.database.editLibraryQueue,
    get = f.database.getLibraryQueue
  let unavailable = false
  f.database.editLibraryQueue = async (...args) => {
    const result = await edit(...args)
    unavailable = true
    return result
  }
  f.database.getLibraryQueue = async (id) => {
    if (unavailable) throw new Error('SQL temporarily unavailable')
    return get(id)
  }
  await f.owner.dispatch({ type: 'set-play-mode', mode: 'shuffle' })
  assert.ok(f.owner.pendingLibraryMode)
  unavailable = false
  const rebind = f.engine.rebindQueue.bind(f.engine)
  f.engine.rebindQueue = async (request) => {
    await rebind(request)
    f.engine.token = ''
    throw new Error('final native ACK lost')
  }
  f.useProductionRestoreLifecycle(async () => {
    const state = (await f.owner.getRestoreState()) as shared.AfterglowRestoreState
    assert.equal(state.recovery, 'native-queue-unknown')
    assert.equal(state.playMode, 'shuffle')
    assert.equal(state.libraryQueue?.index, 0)
    assert.equal(state.libraryQueue?.entryId, f.entry(0).queueEntryId)
  })
  assert.equal((await f.owner.restore()).phase, 'inactive')
  assert.deepEqual(f.edits, ['mode'])
  assert.equal(f.transport.filter((item) => item === 'guard').length, 2)
  assert.equal(f.transport.filter((item) => item === 'stop').length, 1)
  assert.equal(f.transport.includes('load'), false)
})

test('legacy array mode commands retain their original native entry points and cycle', async (t) => {
  const f = await fixture(t)
  await f.session.adoptRendererSnapshot({
    queue: [{ id: 'array' }],
    queueIndex: 0,
    track: { id: 'array' },
    position: 0,
    playMode: 'sequential',
    volume: 1,
    playbackRate: 1
  })
  await f.owner.dispatch({ type: 'cycle-play-mode' })
  await f.owner.dispatch({ type: 'cycle-play-mode' })
  await f.owner.dispatch({ type: 'set-play-mode', mode: 'sequential' })
  assert.deepEqual(f.transport, ['mode:listLoop', 'mode:repeat', 'mode:sequential'])
  assert.deepEqual(f.reads, [])
})

test('the live SQL core consumes a new logical shuffle mode and keeps the next window bounded', async (t) => {
  const f = await fixture(t)
  await f.maintenance()
  await f.owner.dispatch({ type: 'set-play-mode', mode: 'shuffle' })
  await tick()
  await f.owner.queueCore!.tick()
  assert.equal(f.owner.error, null)
  assert.equal(f.session.getCachedSession()?.playMode, 'shuffle')
  assert.deepEqual(f.mapping(), [0, 1])
  assert.equal(f.engine.items[1].queueEntryId, f.entry(1).queueEntryId)
  assert.equal(f.engine.items.length, 2)
  assert.equal(f.engine.info.position, 12)
  assert.equal(f.engine.info.playMode, 'sequential')
  assert.ok(!f.transport.some((action) => ['load', 'play', 'stop'].includes(action)))
})

test('stopped SQL selections can change mode without opening or replaying their decoder', async (t) => {
  const f = await fixture(t)
  f.engine.info.state = 'stopped'
  f.engine.info.source = 'D:/Music/old-decoder.flac'
  await f.owner.dispatch({ type: 'set-play-mode', mode: 'shuffle' })
  assert.equal(f.owner.error, null)
  assert.equal(f.session.getCachedSession()?.playMode, 'shuffle')
  assert.equal(f.engine.info.state, 'stopped')
  assert.equal(f.engine.items[0].source, 'D:/Music/disc.flac')
  assert.ok(!f.transport.some((action) => ['load', 'play', 'stop'].includes(action)))
})

test('an unrelated concurrent SQL edit is not mistaken for a confirmed mode transaction', async (t) => {
  const f = await fixture(t)
  const guard = f.engine.rebindQueue.bind(f.engine)
  f.engine.rebindQueue = async (request) => {
    const result = await guard(request)
    const queue = f.db.getLibraryQueue(f.queue.id)
    f.db.editLibraryQueue(queue.id, queue.revision, {
      kind: 'select',
      entryId: f.entry(20).queueEntryId
    })
    return result
  }
  await f.owner.dispatch({ type: 'set-play-mode', mode: 'shuffle' })
  assert.equal(f.owner.error, 'afterglow_library_queue_changed')
  assert.equal(f.session.getCachedSession()?.playMode, 'listLoop')
  assert.equal(f.db.getLibraryQueue(f.queue.id).order, 'original')
  assert.ok(f.owner.pendingLibraryMode)
  assert.deepEqual(f.edits, ['mode'])
  assert.equal(f.transport.includes('presentation-start'), false)
})
