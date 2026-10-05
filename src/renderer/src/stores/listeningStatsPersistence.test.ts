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
  private readonly callbacks = new Map<number, () => void>()

  setTimeout = (callback: () => void): ReturnType<typeof setTimeout> => {
    const id = this.nextId++
    this.callbacks.set(id, callback)
    return id as unknown as ReturnType<typeof setTimeout>
  }

  clearTimeout = (id: ReturnType<typeof setTimeout>): void => {
    this.callbacks.delete(id as unknown as number)
  }

  get pendingCount(): number {
    return this.callbacks.size
  }

  runNext(): void {
    const entry = this.callbacks.entries().next().value as [number, () => void] | undefined
    if (!entry) throw new Error('No pending timer')
    this.callbacks.delete(entry[0])
    entry[1]()
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
