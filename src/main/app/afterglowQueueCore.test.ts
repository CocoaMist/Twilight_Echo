import assert from 'node:assert/strict'
import test from 'node:test'
import type { AudioEngineQueueItem, AudioEngineQueueState } from '../../shared/audioEngineTypes.ts'
import type { AfterglowQueueCoreEngine } from './afterglowQueueCore.ts'
import { AfterglowQueueCore, afterglowNativeQueueItem } from './afterglowQueueCore.ts'
import type { AfterglowSourceResolver, ResolvedAfterglowSource } from './afterglowSourceResolver.ts'
import { createAfterglowSourceResolver } from './afterglowSourceResolver.ts'

const track = (index: number): Record<string, unknown> => ({
  id: `ncm:${index}`,
  title: `Track ${index}`,
  artist: 'Artist',
  album: 'Album',
  duration: 180,
  filePath: `ncm:${index}`,
  source: 'ncm'
})

test('native Afterglow items retain codec, gain and CUE fields without carrying arbitrary SQL payloads', () => {
  const item = afterglowNativeQueueItem(
    {
      id: 'cue',
      queueEntryId: 'occurrence',
      format: 'FLAC',
      cueRange: { startSeconds: 90, endSeconds: 180 },
      replayGainTrackGainDb: -6,
      replayGainAlbumGainDb: -4,
      replayGainTrackPeak: 0.9,
      r128TrackGainDb: -2,
      measuredIntegratedLufs: -15,
      measuredTruePeakDb: -1,
      replayGainAlbumPeak: Number.NaN,
      lyrics: 'not a queue field'
    },
    'D:/Music/disc.flac',
    400
  )
  assert.equal(item.codec, 'FLAC')
  assert.equal(item.queueEntryId, 'occurrence')
  assert.equal(item.replayGainTrackGainDb, -6)
  assert.equal(item.replayGainAlbumGainDb, -4)
  assert.equal(item.replayGainTrackPeak, 0.9)
  assert.equal(item.r128TrackGainDb, -2)
  assert.equal(item.measuredIntegratedLufs, -15)
  assert.equal(item.measuredTruePeakDb, -1)
  assert.equal(item.replayGainAlbumPeak, undefined)
  assert.equal('lyrics' in item, false)
  assert.deepEqual(item.cueRange, { startSeconds: 90, endSeconds: 180 })
})

class FakeEngine implements AfterglowQueueCoreEngine {
  items: AudioEngineQueueItem[]
  currentIndex = 0
  revision = 1
  appendCalls: AudioEngineQueueItem[][] = []
  updates: Array<{ index: number; source: string }> = []
  appendError: Error | null = null

  constructor(initial: AudioEngineQueueItem[]) {
    this.items = initial.map((item) => ({ ...item }))
  }

  async getPlaybackInfo(): Promise<{
    queueIndex: number
    upcomingQueueIndex?: number
    state: string
  }> {
    return {
      queueIndex: this.currentIndex,
      upcomingQueueIndex: this.upcomingIndex(),
      state: 'playing'
    }
  }

  async getQueueState(): Promise<AudioEngineQueueState | null> {
    return {
      revision: this.revision,
      size: this.items.length,
      currentIndex: this.currentIndex,
      upcomingIndex: this.upcomingIndex(),
      playMode: 'sequential'
    }
  }

  async appendQueueItems(items: AudioEngineQueueItem[]): Promise<number> {
    if (this.appendError) throw this.appendError
    const firstIndex = this.items.length
    this.items.push(...items.map((item) => ({ ...item })))
    this.revision += 1
    this.appendCalls.push(items)
    return firstIndex
  }

  async updateQueueItemSource(index: number, source: string): Promise<boolean> {
    const item = this.items[index]
    if (!item || index === this.currentIndex) return false
    this.items[index] = { ...item, source }
    this.updates.push({ index, source })
    this.revision += 1
    return true
  }

  private upcomingIndex(): number {
    return this.currentIndex + 1 < this.items.length ? this.currentIndex + 1 : -1
  }
}

class FakeResolver implements AfterglowSourceResolver {
  calls: number[] = []
  sources = new Map<number, ResolvedAfterglowSource>()
  failOn = new Set<number>()

  async resolve(trackValue: unknown): Promise<ResolvedAfterglowSource | null> {
    const index = Number(String((trackValue as { id?: string }).id ?? '').split(':')[1])
    this.calls.push(index)
    if (this.failOn.has(index)) return null
    const configured = this.sources.get(index)
    if (configured) return configured
    return { source: `https://cdn.test/${index}.flac`, expiresAt: Date.now() + 10 * 60_000 }
  }
}

const initialEngine = (): FakeEngine =>
  new FakeEngine([
    { id: 'ncm:0', source: 'https://cdn.test/0.flac' },
    { id: 'ncm:1', source: 'https://cdn.test/1.flac' }
  ])

test('lookahead appends resolved entries without reloading the native queue', async () => {
  const engine = initialEngine()
  const resolver = new FakeResolver()
  const mappings: number[][] = []
  const core = new AfterglowQueueCore({
    queue: [track(0), track(1), track(2), track(3)],
    currentLogicalIndex: 0,
    nativeQueueIndices: [0, 1],
    engine,
    resolver,
    lookahead: 2,
    onMappingChanged: (mapping) => mappings.push([...mapping])
  })

  await core.start()
  assert.deepEqual(core.getMapping(), [0, 1, 2])
  assert.equal(engine.appendCalls.length, 1)
  assert.deepEqual(
    engine.appendCalls[0].map((item) => item.id),
    ['ncm:2']
  )
  assert.equal(engine.items[2].source, 'https://cdn.test/2.flac')
  assert.deepEqual(mappings, [[0, 1, 2]])

  // The cursor advances: the window has room again, so the next entry appends.
  engine.currentIndex = 1
  await core.tick()
  assert.deepEqual(core.getMapping(), [0, 1, 2, 3])
  assert.deepEqual(
    engine.appendCalls[1].map((item) => item.id),
    ['ncm:3']
  )
  assert.equal(engine.items.length, 4)

  // Queue end: no further append, and the core stays healthy.
  engine.currentIndex = 3
  await core.tick()
  assert.deepEqual(core.getMapping(), [0, 1, 2, 3])
  assert.equal(core.getLastError(), null)
  assert.equal(core.isActive(), true)
  core.stop()
})

test('upcoming URL is refreshed before it expires and again when TTL runs out', async () => {
  let now = 1_000_000
  const engine = initialEngine()
  const resolver = new FakeResolver()
  resolver.sources.set(1, { source: 'https://cdn.test/1-fresh.flac', expiresAt: now + 10_000 })
  const core = new AfterglowQueueCore({
    queue: [track(0), track(1), track(2)],
    currentLogicalIndex: 0,
    nativeQueueIndices: [0, 1],
    engine,
    resolver,
    lookahead: 2,
    refreshMarginMs: 2_000,
    now: () => now
  })

  await core.start()
  assert.deepEqual(engine.updates, [{ index: 1, source: 'https://cdn.test/1-fresh.flac' }])

  // Still outside the refresh margin: no redundant update.
  now += 5_000
  await core.tick()
  assert.equal(engine.updates.length, 1)

  // Inside the margin: resolve again and hot-update the same native slot.
  resolver.sources.set(1, { source: 'https://cdn.test/1-renewed.flac', expiresAt: now + 20_000 })
  now += 4_000
  await core.tick()
  assert.deepEqual(engine.updates.at(-1), { index: 1, source: 'https://cdn.test/1-renewed.flac' })
  assert.equal(engine.items[1].source, 'https://cdn.test/1-renewed.flac')
  core.stop()
})

test('does not update the current item when repeat leaves upcoming on the cursor', async () => {
  const engine = initialEngine()
  engine.currentIndex = 0
  const resolver = new FakeResolver()
  const core = new AfterglowQueueCore({
    queue: [track(0)],
    currentLogicalIndex: 0,
    nativeQueueIndices: [0],
    engine,
    resolver
  })
  await core.start()
  assert.deepEqual(engine.updates, [])
  core.stop()
})

test('append failures stop maintenance instead of leaving a half-applied mapping', async () => {
  const engine = initialEngine()
  engine.appendError = new Error('append rejected')
  const resolver = new FakeResolver()
  const errors: string[] = []
  const core = new AfterglowQueueCore({
    queue: [track(0), track(1), track(2)],
    currentLogicalIndex: 0,
    nativeQueueIndices: [0, 1],
    engine,
    resolver,
    onError: (message) => errors.push(message)
  })
  await core.start()
  assert.equal(core.isActive(), false)
  assert.equal(core.getMapping().length, 2)
  assert.match(errors[0] ?? '', /append rejected/)
})

test('mapping drift is treated as a fatal engine-state mismatch', async () => {
  const engine = initialEngine()
  const resolver = new FakeResolver()
  const core = new AfterglowQueueCore({
    queue: [track(0), track(1)],
    currentLogicalIndex: 0,
    nativeQueueIndices: [0, 1],
    engine,
    resolver
  })
  engine.items.push({ id: 'external', source: 'external.flac' })
  await core.start()
  assert.equal(core.isActive(), false)
  assert.match(core.getLastError() ?? '', /mapping_mismatch/)
})

test('stop during an in-flight resolve prevents append and source update', async () => {
  const engine = initialEngine()
  const gate: {
    release: ((value: ResolvedAfterglowSource | null) => void) | null
    started: (() => void) | null
  } = { release: null, started: null }
  const resolver: AfterglowSourceResolver = {
    resolve: () =>
      new Promise<ResolvedAfterglowSource | null>((resolve) => {
        gate.release = resolve
        gate.started?.()
      })
  }
  const core = new AfterglowQueueCore({
    queue: [track(0), track(1), track(2)],
    currentLogicalIndex: 0,
    nativeQueueIndices: [0, 1],
    engine,
    resolver
  })
  const waiting = new Promise<void>((resolve) => {
    gate.started = resolve
  })
  const starting = core.start()
  await waiting
  core.stop()
  gate.release?.({ source: 'https://cdn.test/late.flac', expiresAt: Date.now() + 60_000 })
  await starting
  assert.equal(engine.appendCalls.length, 0)
  assert.deepEqual(engine.updates, [])
  assert.deepEqual(core.getMapping(), [0, 1])
})

test('stop cancels further provider work and queue mutation', async () => {
  const engine = initialEngine()
  const resolver = new FakeResolver()
  const core = new AfterglowQueueCore({
    queue: [track(0), track(1), track(2)],
    currentLogicalIndex: 0,
    nativeQueueIndices: [0, 1],
    engine,
    resolver
  })
  await core.start()
  const appended = engine.appendCalls.length
  const resolved = resolver.calls.length
  core.stop()
  await core.tick()
  assert.equal(engine.appendCalls.length, appended)
  assert.equal(resolver.calls.length, resolved)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('a late SQL detail read cannot start provider work after stop', async () => {
  const engine = initialEngine()
  const resolver = new FakeResolver()
  const started = deferred<void>()
  const detail = deferred<unknown>()
  const core = new AfterglowQueueCore({
    queue: [],
    queueLength: 300_000,
    loadQueueItem: async () => {
      started.resolve()
      return detail.promise
    },
    currentLogicalIndex: 200_000,
    nativeQueueIndices: [200_000, 200_001],
    engine,
    resolver
  })
  const starting = core.start()
  await started.promise
  const stopping = core.stop()
  await stopping // Unfinished SQL reads do not hold the renderer restore hostage.
  detail.resolve(track(200_001))
  await Promise.all([starting, stopping])
  assert.deepEqual(resolver.calls, [])
  assert.deepEqual(engine.updates, [])
  assert.deepEqual(engine.appendCalls, [])
})

test('a SQL occurrence is loaded once for resolution and append', async () => {
  const engine = initialEngine()
  const reads: number[] = []
  const core = new AfterglowQueueCore({
    queue: [],
    queueLength: 300_000,
    loadQueueItem: async (index) => {
      reads.push(index)
      assert.equal(reads.filter((value) => value === index).length, 1)
      return {
        ...track(index),
        queueEntryId: `entry:${index}`,
        cueRange: { startSeconds: 90, endSeconds: 180 }
      }
    },
    currentLogicalIndex: 200_000,
    nativeQueueIndices: [200_000, 200_001],
    engine,
    resolver: new FakeResolver()
  })
  await core.start()
  assert.equal(core.getLastError(), null)
  assert.deepEqual(reads, [200_001, 200_002])
  assert.deepEqual(core.getMapping(), [200_000, 200_001, 200_002])
  assert.equal(engine.items[2]?.id, 'ncm:200002')
  assert.equal(engine.items[2]?.queueEntryId, 'entry:200002')
  assert.deepEqual(engine.items[2]?.cueRange, { startSeconds: 90, endSeconds: 180 })
  await core.stop()
})

test('stop/start fences the old provider generation even when the core is active again', async () => {
  const engine = initialEngine()
  const started = deferred<void>()
  const old = deferred<ResolvedAfterglowSource | null>()
  let calls = 0
  const core = new AfterglowQueueCore({
    queue: [track(0), track(1)],
    currentLogicalIndex: 0,
    nativeQueueIndices: [0, 1],
    engine,
    resolver: {
      resolve: async () => {
        calls++
        if (calls === 1) {
          started.resolve()
          return old.promise
        }
        return { source: 'https://cdn.test/new-generation.flac', expiresAt: null }
      }
    }
  })
  const starting = core.start()
  await started.promise
  const stopping = core.stop()
  const restarting = core.start()
  old.resolve({ source: 'https://cdn.test/stale-generation.flac', expiresAt: null })
  await Promise.all([starting, stopping, restarting])
  assert.deepEqual(engine.updates, [{ index: 1, source: 'https://cdn.test/new-generation.flac' }])
  await core.stop()
})

test('stop drains an already dispatched append and retains its committed mapping for handoff', async () => {
  const engine = initialEngine()
  const dispatch = engine.appendQueueItems.bind(engine)
  const started = deferred<void>()
  const reply = deferred<number>()
  engine.appendQueueItems = async (items) => {
    const firstIndex = await dispatch(items)
    started.resolve()
    await reply.promise
    return firstIndex
  }
  const changes: number[][] = []
  const core = new AfterglowQueueCore({
    queue: [track(0), track(1), track(2)],
    currentLogicalIndex: 0,
    nativeQueueIndices: [0, 1],
    engine,
    resolver: new FakeResolver(),
    onMappingChanged: (mapping) => changes.push([...mapping])
  })
  const starting = core.start()
  await started.promise
  let drained = false
  const stopping = Promise.resolve(core.stop()).then(() => {
    drained = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(drained, false)
  reply.resolve(2)
  await Promise.all([starting, stopping])
  assert.deepEqual(core.getMapping(), [0, 1, 2])
  assert.equal(engine.items.length, 3)
  assert.deepEqual(changes, [], 'a stopped owner cannot publish a late mapping callback')
})

test('legacy array core also cancels pending provider RPCs while preserving its synchronous mapping contract', async () => {
  const engine = initialEngine()
  const started = deferred<void>()
  let signal: AbortSignal | undefined
  const core = new AfterglowQueueCore({
    queue: [track(0), track(1)],
    currentLogicalIndex: 0,
    nativeQueueIndices: [0, 1],
    engine,
    resolver: createAfterglowSourceResolver({
      quality: 'auto',
      callProvider: async (_id, _method, _args, options) => {
        signal = options.signal
        started.resolve()
        return new Promise(() => {})
      }
    })
  })
  const pending = core.start()
  await started.promise
  await core.stop()
  await pending
  assert.equal(signal?.aborted, true)
  assert.deepEqual(core.getMapping(), [0, 1])
  assert.deepEqual(engine.updates, [])
  assert.deepEqual(engine.appendCalls, [])
})
