import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { AfterglowQueueCore } from './afterglowQueueCore.ts'

const source = readFileSync(new URL('./AfterglowModeService.ts', import.meta.url), 'utf8')
const file = ts.createSourceFile('service.ts', source, ts.ScriptTarget.Latest, true)
const declaration = file.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'AfterglowModeService'
)!
assert.ok(declaration)
const implementation = ts.transpileModule(
  `${declaration.getText(file)}; globalThis.service = new AfterglowModeService()`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type Owner = {
  phase: string
  generation: number
  queueCore: AfterglowQueueCore | null
  queueCoreTick: (() => void) | null
  stopQueueCore(): Promise<void>
  startQueueCore(snapshot: unknown, mapping: number[], current: number): Promise<void>
  failWindowRestore(message: string): unknown
}

function ownerFixture() {
  const published: number[][] = []
  let capabilities = 0
  const context = vm.createContext({
    runtime: {
      audioEngineManager: {
        off: () => {},
        getQueueHotUpdateCapabilityAsync: async () => {
          capabilities++
          return null
        }
      }
    },
    setAfterglowEngineMapping: (mapping: number[]) => published.push([...mapping]),
    writeDiagnostic: () => {}
  })
  vm.runInContext(implementation, context)
  const owner = context.service as Owner
  owner.phase = 'active'
  owner.generation = 1
  return { owner, published, context, capabilities: () => capabilities }
}

test('the mode owner drains confirmed appends before publishing the final handoff map', async () => {
  const { owner, published } = ownerFixture()
  const started = deferred<void>()
  const reply = deferred<number>()
  const core = new AfterglowQueueCore({
    queue: [{ id: 'a' }, { id: 'b' }],
    nativeQueueIndices: [0],
    currentLogicalIndex: 0,
    resolver: { resolve: async () => ({ source: 'D:/Music/b.flac', expiresAt: null }) },
    engine: {
      getPlaybackInfo: async () => ({ queueIndex: 0, state: 'playing' }),
      getQueueState: async () => ({
        revision: 1,
        size: 1,
        currentIndex: 0,
        upcomingIndex: -1,
        playMode: 'sequential'
      }),
      appendQueueItems: async () => {
        started.resolve()
        return reply.promise
      },
      updateQueueItemSource: async () => true
    }
  })
  owner.queueCore = core
  const starting = core.start()
  await started.promise
  owner.phase = 'restoring'
  const stopping = owner.stopQueueCore()
  assert.equal(owner.stopQueueCore(), stopping, 'repeated stop shares the existing drain')
  assert.deepEqual(published, [])
  reply.resolve(1)
  await Promise.all([starting, stopping])
  assert.deepEqual(published, [[0, 1]])
})

test('failed/shut-down owners cannot republish a mapping after asynchronous cleanup', async () => {
  for (const phase of ['inactive', 'active']) {
    const { owner, published } = ownerFixture()
    const drain = deferred<void>()
    owner.queueCore = {
      stop: () => drain.promise,
      getMapping: () => [10, 11]
    } as unknown as AfterglowQueueCore
    const stopping = owner.stopQueueCore()
    owner.phase = phase
    if (phase === 'active') owner.generation++
    drain.resolve()
    await stopping
    assert.deepEqual(published, [])
  }
})

test('a stale start cannot obtain an engine capability after waiting for the old core', async () => {
  const { owner, capabilities } = ownerFixture()
  const drain = deferred<void>()
  owner.queueCore = {
    stop: () => drain.promise,
    getMapping: () => [0]
  } as unknown as AfterglowQueueCore
  const starting = owner.startQueueCore({ queue: [{ id: 'a' }] }, [0], 0)
  owner.generation++
  owner.phase = 'restoring'
  drain.resolve()
  await starting
  assert.equal(capabilities(), 0)
  assert.equal(owner.queueCore, null)
})

test('a failed renderer restore keeps the durable reference and resumes queue maintenance from the live cursor', () => {
  const { owner, context } = ownerFixture()
  Object.assign(context.runtime.audioEngineManager, { getQueueToken: () => 'confirmed-live-queue' })
  const started: unknown[][] = []
  const snapshot = { queue: [], libraryQueue: { id: 'sql', index: 400 } }
  Object.assign(context, {
    createAfterglowAnchorWindow: () => {},
    startAfterglowPresentation: () => {},
    getAfterglowEngineMapping: () => [399, 400, 401],
    playbackSessionService: { getCachedSession: () => ({ libraryQueue: { index: 400 } }) },
    process: { platform: 'test' },
    console: { warn: () => {} }
  })
  Object.assign(owner, {
    queueCoreResume: { snapshot, queueLength: 605, loadQueueItem: async () => null },
    afterglowLibraryQueueId: 'sql',
    registerRestoreShortcut: () => {},
    registerFallbackMediaKeys: () => {},
    bindWindowedAutoRestore: () => {},
    getStatus: () => ({}),
    startQueueCore: async (...args: unknown[]) => {
      started.push(args)
    }
  })
  owner.failWindowRestore('renderer_timeout')
  assert.equal(owner.phase, 'active')
  assert.equal(
    (owner as unknown as { afterglowLibraryQueueId: string }).afterglowLibraryQueueId,
    'sql'
  )
  assert.equal(started[0][0], snapshot)
  assert.deepEqual(started[0].slice(1, 4), [[399, 400, 401], 400, 605])
})

test('a pending core capability cannot restart maintenance after a newer transport stopped it', async () => {
  const { owner, context } = ownerFixture()
  const started = deferred<void>(),
    reply = deferred<unknown>()
  context.runtime.audioEngineManager.getQueueHotUpdateCapabilityAsync = async () => {
    started.resolve()
    return reply.promise
  }
  const starting = owner.startQueueCore({ queue: [{ id: 'a' }] }, [0], 0)
  await started.promise
  await owner.stopQueueCore()
  reply.resolve({ append: true, updateSource: true })
  await starting
  assert.equal(owner.queueCore, null)
})
