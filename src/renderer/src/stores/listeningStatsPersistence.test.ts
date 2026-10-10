import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ListeningStatsPersistence,
  type ListeningStatsPersistenceStatus
} from './listeningStatsPersistence.ts'

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<() => void>>()

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
}

class FakeTimers {
  private nextId = 1
  private readonly callbacks = new Map<number, { callback: () => void; due: number }>()
  private now = 0

  setTimeout = (callback: () => void, delay = 0): ReturnType<typeof setTimeout> => {
    const id = this.nextId++
    this.callbacks.set(id, { callback, due: this.now + delay })
    return id as unknown as ReturnType<typeof setTimeout>
  }

  clearTimeout = (id: ReturnType<typeof setTimeout>): void => {
    this.callbacks.delete(id as unknown as number)
  }

  get pendingCount(): number {
    return this.callbacks.size
  }

  runNext(): void {
    const entry = [...this.callbacks.entries()].sort((a, b) => a[1].due - b[1].due)[0]
    if (!entry) throw new Error('No pending timer')
    this.callbacks.delete(entry[0])
    this.now = entry[1].due
    entry[1].callback()
  }

  advance(ms: number): void {
    const end = this.now + ms
    while ([...this.callbacks.values()].some((timer) => timer.due <= end)) this.runNext()
    this.now = end
  }
}

class FakeStorage {
  readonly values = new Map<string, string>()
  setItemCalls = 0
  failWrites = false

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.setItemCalls += 1
    if (this.failWrites) {
      const error = new Error('Quota exceeded')
      error.name = 'QuotaExceededError'
      throw error
    }
    this.values.set(key, value)
  }
}

function createPersistence(snapshot: { count: number }) {
  const timers = new FakeTimers()
  const storage = new FakeStorage()
  const page = new FakeEventTarget()
  const document = Object.assign(new FakeEventTarget(), { visibilityState: 'visible' })
  const statuses: ListeningStatsPersistenceStatus[] = []
  const persistence = new ListeningStatsPersistence({
    key: 'stats',
    storage,
    getSnapshot: () => snapshot,
    beforePersist: () => undefined,
    onStatus: (status) => statuses.push(status),
    flushDelayMs: 30_000,
    retryDelayMs: 60_000,
    setTimeout: timers.setTimeout as typeof globalThis.setTimeout,
    clearTimeout: timers.clearTimeout as typeof globalThis.clearTimeout,
    document,
    window: page
  })
  return { persistence, timers, storage, page, document, statuses }
}

test('listening stats persistence batches a burst into one trailing full-snapshot write', () => {
  const snapshot = { count: 0 }
  const { persistence, timers, storage } = createPersistence(snapshot)
  const updateCount = 1_000
  const startedAt = performance.now()

  for (let index = 0; index < updateCount; index++) {
    snapshot.count = index + 1
    persistence.markDirty()
  }

  const elapsedMs = performance.now() - startedAt
  assert.equal(storage.setItemCalls, 0)
  assert.equal(timers.pendingCount, 1)
  timers.runNext()
  assert.equal(storage.setItemCalls, 1)
  assert.equal(storage.getItem('stats'), JSON.stringify({ count: updateCount }))
  assert.equal(storage.setItemCalls / updateCount, 0.001)
  assert.ok(elapsedMs < 1_000, `batch scheduling took ${elapsedMs.toFixed(1)}ms`)
})

test('successful flush measures preparation, serialization and actual storage writes', () => {
  const { persistence, statuses } = createPersistence({ count: 5 })
  persistence.markDirty()
  assert.equal(persistence.flush(), true)
  const measurement = statuses.at(-1)?.lastFlush
  assert.ok(measurement)
  assert.equal(measurement.characters, JSON.stringify({ count: 5 }).length)
  assert.ok(
    measurement.preparationMs >= 0 &&
      measurement.serializationMs >= 0 &&
      measurement.storageWriteMs >= 0
  )
  assert.ok(
    Math.abs(
      measurement.totalMs -
        measurement.preparationMs -
        measurement.serializationMs -
        measurement.storageWriteMs
    ) < 0.001
  )
})

test('pagehide and hidden visibility flush pending listening history immediately', () => {
  const snapshot = { count: 1 }
  const { persistence, storage, page, document } = createPersistence(snapshot)

  persistence.markDirty()
  page.dispatch('pagehide')
  assert.equal(storage.getItem('stats'), JSON.stringify(snapshot))

  snapshot.count = 2
  persistence.markDirty()
  document.visibilityState = 'hidden'
  document.dispatch('visibilitychange')
  assert.equal(storage.getItem('stats'), JSON.stringify(snapshot))
})

test('QuotaExceededError stays observable, retains in-memory history, and recovers on a later flush', () => {
  const snapshot = { count: 41 }
  const { persistence, storage, statuses } = createPersistence(snapshot)
  storage.failWrites = true

  persistence.markDirty()
  assert.equal(persistence.flush(), false)
  assert.equal(snapshot.count, 41)
  assert.equal(statuses.at(-1)?.state, 'error')
  assert.equal(statuses.at(-1)?.dirty, true)
  assert.equal(statuses.at(-1)?.failureCount, 1)
  assert.match(statuses.at(-1)?.lastError ?? '', /Quota exceeded/)

  storage.failWrites = false
  snapshot.count = 42
  assert.equal(persistence.flush(), true)
  assert.equal(storage.getItem('stats'), JSON.stringify({ count: 42 }))
  const { lastFlush, ...status } = statuses.at(-1)!
  assert.ok(lastFlush)
  assert.deepEqual(status, {
    state: 'idle',
    dirty: false,
    failureCount: 0,
    lastError: null
  })
})

test('continuous five-second ticks checkpoint every thirty seconds without idle writes', () => {
  const snapshot = { count: 0 }
  const { persistence, timers, storage } = createPersistence(snapshot)
  for (let tick = 0; tick < 60; ++tick) {
    ++snapshot.count
    persistence.markDirty()
    timers.advance(5_000)
  }
  assert.equal(storage.setItemCalls, 10)
  assert.equal(JSON.parse(storage.getItem('stats')!).count, 60)
  timers.advance(300_000)
  assert.equal(storage.setItemCalls, 10)
  persistence.dispose()
})

test('async flush retains mutations during an in-flight write and awaits the latest checkpoint', async () => {
  const timers = new FakeTimers(),
    snapshot = { count: 1 },
    writes: number[] = []
  let finish!: () => void
  const blocked = new Promise<void>((resolve) => {
    finish = resolve
  })
  const storage = new FakeStorage()
  const persistence = new ListeningStatsPersistence({
    key: 'stats',
    storage,
    getSnapshot: () => snapshot,
    beforePersist: () => {},
    onStatus: () => {},
    persistSnapshot: async (value) => {
      writes.push(value.count)
      if (writes.length === 1) await blocked
    },
    flushDelayMs: 30_000,
    retryDelayMs: 60_000,
    setTimeout: timers.setTimeout as typeof globalThis.setTimeout,
    clearTimeout: timers.clearTimeout as typeof globalThis.clearTimeout
  })
  persistence.markDirty()
  const checkpoint = persistence.flush()
  snapshot.count = 2
  persistence.markDirty()
  const exit = persistence.flush()
  finish()
  assert.equal(await checkpoint, true)
  assert.equal(await exit, true)
  assert.deepEqual(writes, [1, 2])
  assert.equal(storage.setItemCalls, 0)
  assert.equal(timers.pendingCount, 0)
  persistence.dispose()
})

test('async storage failures remain dirty and retry without losing the cleared snapshot', async () => {
  const timers = new FakeTimers(),
    snapshot = { count: 0 },
    statuses: ListeningStatsPersistenceStatus[] = []
  let fail = true,
    saved: number | null = null
  const persistence = new ListeningStatsPersistence({
    key: 'stats',
    storage: new FakeStorage(),
    getSnapshot: () => snapshot,
    beforePersist: () => {},
    onStatus: (status) => statuses.push(status),
    persistSnapshot: async (value) => {
      if (fail) throw new Error('Transaction aborted')
      saved = value.count
    },
    flushDelayMs: 30_000,
    retryDelayMs: 60_000,
    setTimeout: timers.setTimeout as typeof globalThis.setTimeout,
    clearTimeout: timers.clearTimeout as typeof globalThis.clearTimeout
  })
  persistence.markDirty()
  assert.equal(await persistence.flush(), false)
  assert.equal(statuses.at(-1)?.dirty, true)
  assert.equal(statuses.at(-1)?.state, 'error')
  fail = false
  persistence.markDirty()
  assert.equal(timers.pendingCount, 1)
  timers.advance(30_000)
  assert.equal(saved, null)
  assert.equal(await persistence.flush(), true)
  assert.equal(saved, 0)
  persistence.dispose()
})
