import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import type { LibraryHistorySyncRequest } from '../../shared/libraryDatabase.ts'
import { createLibraryListeningProjection } from './libraryProjection.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
async function settled(projector: ReturnType<typeof createLibraryListeningProjection>) {
  for (let i = 0; i < 50; i++) {
    if (!projector.state.value.pending) {
      await tick()
      if (!projector.state.value.pending) return
    }
    await tick()
  }
  assert.fail('history projector did not settle')
}
function fixture(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:'),
    calls: LibraryHistorySyncRequest[] = []
  let snapshot = new Map<string, number>(),
    counter = 0
  const projector = createLibraryListeningProjection({
    getStorageMode: async () => 'sqlite',
    ready: async () => {},
    snapshot: () => snapshot,
    identity: () => `sync:${++counter}`,
    sync: async (request) => {
      calls.push(structuredClone(request))
      return db.syncListeningHistory(request)
    }
  })
  t.after(() => {
    projector.dispose()
    db.close()
  })
  return {
    db,
    projector,
    calls,
    setSnapshot(value: Map<string, number>) {
      snapshot = value
    }
  }
}

test('initial history is bounded to 1000 lightweight entries per acknowledged batch; later ticks send only deltas', async (t) => {
  const f = fixture(t),
    snapshot = new Map(Array.from({ length: 2501 }, (_, i) => [`id:${i}`, i + 1] as const))
  f.setSnapshot(snapshot)
  await f.projector.ensure()
  const batches = f.calls.filter((call) => call.kind === 'append')
  assert.deepEqual(
    batches.map((call) => call.entries.length),
    [1000, 1000, 501]
  )
  assert.ok(batches.every((call) => call.entries.every((entry) => Object.keys(entry).length === 2)))
  assert.equal(f.projector.state.value.ready, true)
  assert.equal(f.projector.state.value.revision, 1)
  f.calls.length = 0
  snapshot.set('id:5', 9000)
  f.projector.refresh()
  await settled(f.projector)
  assert.equal(f.calls[0].kind === 'begin' && f.calls[0].mode, 'patch')
  assert.deepEqual(f.calls.find((call) => call.kind === 'append')?.entries, [
    { id: 'id:5', lastPlayed: 9000 }
  ])
  f.calls.length = 0
  f.projector.refresh()
  await settled(f.projector)
  assert.equal(f.calls.length, 0, 'unchanged history must not write')
  snapshot.clear()
  f.projector.refresh()
  await settled(f.projector)
  assert.equal(f.db.sql.prepare('SELECT count(*) AS n FROM library_history').get()?.n, 0)
})

test('hydration failure never projects an empty/legacy snapshot; retry waits for authoritative history', async () => {
  let failed = true,
    snapshots = 0,
    calls = 0
  const projector = createLibraryListeningProjection({
    getStorageMode: async () => 'sqlite',
    ready: async () => {
      if (failed) throw new Error('IndexedDB unavailable')
    },
    snapshot: () => {
      snapshots++
      return new Map()
    },
    sync: async (request) => {
      calls++
      return {
        id: request.id,
        sequence: request.kind === 'begin' ? 0 : request.sequence,
        revision: 0,
        committed: request.kind === 'commit'
      }
    }
  })
  await projector.ensure()
  assert.equal(calls, 0)
  assert.equal(snapshots, 0)
  assert.equal(projector.state.value.ready, false)
  assert.match(projector.state.value.error, /IndexedDB/)
  failed = false
  await projector.retry()
  assert.equal(projector.state.value.ready, true)
  assert.equal(snapshots, 1)
  projector.dispose()
})

test('history mutations during an upload replace the pending demand and never commit its stale partial snapshot', async (t) => {
  const f = fixture(t)
  let snapshot = new Map<string, number>(
    Array.from({ length: 2001 }, (_, i) => [`id:${i}`, i + 1] as const)
  )
  let release!: () => void,
    first = true,
    active = 0,
    peak = 0,
    counter = 0
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const projector = createLibraryListeningProjection({
    getStorageMode: async () => 'sqlite',
    ready: async () => {},
    snapshot: () => snapshot,
    identity: () => `changes:${++counter}`,
    sync: async (request) => {
      peak = Math.max(peak, ++active)
      try {
        f.calls.push(structuredClone(request))
        const result = f.db.syncListeningHistory(request)
        if (first && request.kind === 'append') {
          first = false
          await gate
        }
        return result
      } finally {
        active--
      }
    }
  })
  t.after(() => projector.dispose())
  const pending = projector.ensure()
  await tick()
  for (let i = 0; i < 40; i++) {
    snapshot = new Map([['latest', i + 1]])
    projector.refresh()
  }
  assert.equal(f.calls.filter((call) => call.kind === 'begin').length, 1)
  release()
  await pending
  assert.equal(peak, 1)
  assert.equal(f.calls.filter((call) => call.kind === 'begin').length, 2)
  assert.equal(f.calls.filter((call) => call.kind === 'commit').length, 1)
  assert.equal(f.db.sql.prepare('SELECT id,last_played FROM library_history').get()?.id, 'latest')
  assert.equal(f.db.sql.prepare('SELECT last_played FROM library_history').get()?.last_played, 40)
})

test('a lost commit reply is not replayed; explicit retry reconciles with a new replacement', async (t) => {
  const f = fixture(t)
  let lost = true,
    counter = 0
  const projector = createLibraryListeningProjection({
    getStorageMode: async () => 'sqlite',
    ready: async () => {},
    snapshot: () => new Map([['one', 10]]),
    identity: () => `lost:${++counter}`,
    sync: async (request) => {
      f.calls.push(structuredClone(request))
      const result = f.db.syncListeningHistory(request)
      if (lost && request.kind === 'commit') {
        lost = false
        throw new Error('reply lost')
      }
      return result
    }
  })
  t.after(() => projector.dispose())
  await projector.ensure()
  assert.match(projector.state.value.error, /reply lost/)
  assert.equal(projector.state.value.ready, false)
  assert.equal(f.calls.filter((call) => call.kind === 'commit').length, 1)
  await tick()
  assert.equal(f.calls.filter((call) => call.kind === 'commit').length, 1)
  await projector.retry()
  assert.equal(projector.state.value.ready, true)
  assert.equal(projector.state.value.revision, 1)
  assert.equal(f.calls.filter((call) => call.kind === 'begin').length, 2)
  assert.ok(
    f.calls.filter((call) => call.kind === 'begin').every((call) => call.mode === 'replace')
  )
})

test('JSON mode never reads or projects history; invalid mode stays an error, not a JSON fallback', async () => {
  let mode = 'unknown'
  const unexpected = () => {
    throw new Error('history authority touched')
  }
  const projector = createLibraryListeningProjection({
    getStorageMode: async () => mode as 'json',
    ready: unexpected,
    snapshot: unexpected,
    sync: unexpected
  })
  await projector.ensure()
  assert.equal(projector.state.value.mode, null)
  assert.match(projector.state.value.error, /模式无效/)
  mode = 'json'
  await projector.retry()
  assert.equal(projector.state.value.mode, 'json')
  assert.equal(projector.state.value.ready, true)
  projector.dispose()
})
