import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTick } from 'vue'
import { coreLibraryFixture } from './coreLibraryTestFixture.ts'
import { createCoreMusicStore } from './library/coreMusicStore.ts'
import { coreSnapshot } from './coreTestFixtures.ts'
import type { CoreScanStatus } from '../../../shared/coreScan.ts'

const track = {
  id: 'local:a',
  title: 'Moon',
  artist: 'Audrey',
  album: '',
  filePath: 'D:/Music/a.flac',
  duration: 180,
  source: 'local'
}
const tick = async () => {
  await nextTick()
  await new Promise<void>((resolve) => setImmediate(resolve))
}
const scan = (state: CoreScanStatus['state'], jobId = 'scan'): CoreScanStatus => ({
  jobId,
  state,
  phase: 'idle',
  checkedFiles: 1,
  parsedFiles: 1,
  committedFiles: 1,
  failedFiles: 0,
  trackCount: 1,
  revision: 1,
  error: ''
})
async function fixture(t: test.TestContext) {
  const f = await coreLibraryFixture(t, { tracks: [track] })
  const store = createCoreMusicStore(f.core)
  t.after(store.dispose)
  await store.loadApplicationLibrary()
  return { ...f, store }
}

test('application startup requires Core ready and never reads a legacy renderer document', async (t) => {
  const f = await coreLibraryFixture(t, { tracks: [track] })
  f.state.value = coreSnapshot({ phase: 'starting' })
  const store = createCoreMusicStore(f.core)
  t.after(store.dispose)
  await assert.rejects(store.loadApplicationLibrary(), /Core 正在初始化/)
  assert.equal(f.queries.length, 0)
  assert.equal('tracks' in store, false)
  assert.equal('albums' in store, false)
})

test('SQLite content refresh only reads bounded Core metadata and playlist descriptors, never starts a scan', async (t) => {
  const f = await fixture(t)
  f.queries.length = 0
  const saved = f.db.patchTracks([
    { id: track.id, expectedVersion: 1, patch: { title: 'Committed while scanning' } }
  ])
  for (let i = 0; i < 500; i++)
    f.publish({ libraryRevision: saved.revision, scan: scan('running') })
  await tick()
  assert.equal(f.store.isScanning.value, true)
  assert.equal(f.store.libraryTrackCount.value, 1)
  assert.equal(f.queries.filter((query) => query.name === 'library.metadata').length, 1)
  assert.equal(f.queries.filter((query) => query.name === 'playlists.catalog').length, 0)
  assert.equal(
    f.queries.some((query) => query.name === 'library.tracks'),
    false
  )
  assert.deepEqual(f.commands, [])
  f.publish({ scan: scan('cancelled') })
  await tick()
  assert.equal(f.store.libraryScanStatus.value.state, 'cancelled')
})

test('library-only refreshes preserve playlist descriptors and favorite presentation', async (t) => {
  const f = await fixture(t)
  const descriptors = f.store.playlists.value
  const favoriteTrack = { ...track, size: 0, source: 'local' as const }
  const query = f.core.query
  f.core.query = async (name, payload, signal) => name === 'playlists.favorites'
    ? { revision: f.state.value.playlistsRevision, contains: [true] } as never
    : query(name, payload, signal)
  await f.store.getFavoriteTrackStates([favoriteTrack])
  f.publish({ libraryRevision: f.state.value.libraryRevision! + 1 })
  await tick()
  assert.equal(f.store.playlists.value, descriptors)
  assert.equal(f.store.isFavoriteTrack(favoriteTrack), true)
})

test('superseded playlist catalog failures do not publish compatibility warnings', async (t) => {
  const f = await fixture(t)
  let reject!: (error: Error) => void
  const stale = new Promise<never>((_resolve, no) => { reject = no })
  let held = false
  const query = f.core.query
  f.core.query = async (name, payload, signal) => {
    if (name === 'playlists.catalog' && !held) {
      held = true
      return stale
    }
    return query(name, payload, signal)
  }
  // Force a new epoch to require a new catalog even with the same revision.
  f.publish({ epoch: 'new-core' })
  await tick()
  assert.equal(held, true)
  f.publish({ libraryRevision: f.state.value.libraryRevision! + 1 })
  await tick()
  reject(Object.assign(new Error('Playlists changed; read a fresh page'), { code: 'STALE_REVISION' }))
  await tick()
  assert.equal(f.store.libraryCompatibilityError.value, '')
})

test('metadata read failure preserves the last projection; retry reads Core rather than invoking a scanner', async (t) => {
  const f = await fixture(t)
  f.intercept(async (name) => {
    if (name === 'library.metadata') throw new Error('database offline')
  })
  f.publish({ libraryRevision: 5 })
  await tick()
  assert.equal(f.store.libraryCompatibilityError.value, 'database offline')
  assert.equal(f.store.libraryTrackCount.value, 1)
  f.intercept()
  await f.store.retryLibraryCompatibility()
  assert.equal(f.store.libraryCompatibilityError.value, '')
  assert.deepEqual(f.commands, [])
})

test('a playlist revision race rereads fresh state and never publishes a mixed catalog', async (t) => {
  const f = await fixture(t)
  const query = f.core.query
  let attempt = 0
  const offsets: number[] = []
  f.core.query = async (name, payload, signal) => {
    if (name === 'playlists.state') {
      attempt++
      return { ...await query('playlists.state', {}, signal), revision: 100 + attempt } as never
    }
    if (name === 'playlists.catalog') {
      const offset = (payload as { offset: number }).offset
      offsets.push(offset)
      if (attempt === 1 && offset === 0)
        return { revision: 101, offset, total: 201, items: Array.from({ length: 200 }, (_, i) => ({ id: `old-${i}`, name: 'Old' })) } as never
      if (attempt === 1)
        throw Object.assign(new Error('Playlists changed; read a fresh page'), { code: 'STALE_REVISION' })
      return { revision: 102, offset, total: 1, items: [{ id: 'fresh', name: 'Fresh' }] } as never
    }
    return query(name, payload, signal)
  }
  await f.store.loadPlaylists()
  assert.equal(attempt, 2)
  assert.deepEqual(offsets, [0, 200, 0])
  assert.deepEqual(f.store.playlists.value.map(p => p.id), ['fresh'])
  assert.equal(f.store.libraryCompatibilityError.value, '')
  assert.deepEqual(f.commands, [])
})

test('repeated playlist revision conflicts stay bounded and preserve the previous catalog', async (t) => {
  const f = await fixture(t)
  const before = f.store.playlists.value
  const query = f.core.query
  let attempts = 0
  f.core.query = async (name, payload, signal) => {
    if (name === 'playlists.catalog') {
      attempts++
      throw Object.assign(new Error('Playlists changed; read a fresh page'), { code: 'STALE_REVISION' })
    }
    return query(name, payload, signal)
  }
  f.publish({ epoch: 'conflict-core' })
  await tick()
  assert.equal(attempts, 2)
  assert.equal(f.store.playlists.value, before)
  assert.match(f.store.libraryCompatibilityError.value, /Playlists changed/)
  assert.deepEqual(f.commands, [])
})

test('an in-flight refresh cannot resurrect metadata after a Core reset publishes a newer generation', async (t) => {
  const f = await fixture(t)
  let release!: () => void, started!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let first = true
  const query = f.core.query
  f.core.query = async (name, payload, signal) => {
    if (name === 'library.metadata' && first) {
      first = false
      const old = await query(name, payload, signal)
      started()
      await held
      return old as never
    }
    return query(name, payload, signal)
  }
  const pending = f.store.handleLibraryChange()
  await ready
  await f.store.resetLibrary()
  await tick()
  assert.equal(f.store.libraryTrackCount.value, 0)
  release()
  await pending
  assert.equal(f.store.libraryTrackCount.value, 0)
})

test('a delayed scan response does not overwrite the newer authoritative job or exclusions', async (t) => {
  const f = await fixture(t)
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  f.intercept(async (name) => {
    if (name === 'scan.start') await held
  })
  const pending = f.store.startStartupLibraryScan()
  f.publish({ scan: scan('running', 'newer-job') })
  release()
  await pending
  assert.equal(f.store.libraryScanStatus.value.jobId, 'newer-job')
  assert.equal(f.store.libraryScanStatus.value.state, 'running')
  assert.deepEqual(f.store.excludedTracks.value, [])
  assert.deepEqual(f.commands, [{ name: 'scan.start', payload: { mode: 'startup' } }])
})

test('enrichment controls are Core commands and renderer disposal cannot cancel the background work', async (t) => {
  const f = await fixture(t)
  await f.store.cancelLibraryMetadataEnrichment()
  const count = f.commands.length
  f.store.dispose()
  assert.equal(f.commands.length, count)
  assert.deepEqual(f.commands, [{ name: 'metadata.cancel', payload: {} }])
  assert.equal('whenLibrarySettled' in f.store, false)
  assert.equal('applyLocalTagWriteAsync' in f.store, false)
})

test('tag editing submits the Core selection and patch without a renderer database write', async (t) => {
  const f = await fixture(t)
  const calls: unknown[] = []
  f.core.command = async (name, payload) => {
    calls.push({ name, payload })
    return { items: [] } as never
  }
  await f.store.writeTrackTags('frozen-selection', {
    title: 'Edited title',
    artist: 'Edited artist',
    track: 3
  })
  assert.deepEqual(calls, [
    {
      name: 'library.tags.write',
      payload: {
        selectionId: 'frozen-selection',
        patch: { title: 'Edited title', artist: 'Edited artist', track: 3 }
      }
    }
  ])
  assert.equal(f.db.getTracksByIds([track.id]).tracks[0].title, 'Moon')
})

test('BPM changes remain Core database state and only bounded display analysis crosses the renderer boundary', async (t) => {
  const f = await fixture(t)
  const analysis = {
    bpm: 120,
    confidence: 0.9,
    source: 'analyzed',
    analyzedAt: '2026-10-20T00:00:00Z',
    algorithmVersion: 1,
    tempoMap: [{ time: 0, bpm: 120 }]
  }
  f.db.patchTracks([
    { id: track.id, expectedVersion: 1, patch: { bpm: 120, bpmAnalysis: analysis } }
  ])
  const page = await f.store.queryTracks({ ids: [track.id], limit: 1 })
  assert.equal(page.tracks[0].bpmAnalysis?.bpm, 120)
  assert.equal('tempoMap' in page.tracks[0].bpmAnalysis!, false)
  assert.equal('filePath' in page.tracks[0], false)
  assert.equal('applyBpmAnalysis' in f.store, false)
  assert.equal('clearBpmAnalysis' in f.store, false)
})
