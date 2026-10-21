import assert from 'node:assert/strict'
import test from 'node:test'
import { ListeningStatsDatabase } from '../listeningStatsDatabase.ts'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type { ListeningStats } from '../useListeningStatsStore.ts'
import type { LibraryHistorySyncRequest } from '../../../../shared/libraryDatabase.ts'
import type { Track } from '../../types/music'

test('projection and exit flush share a hydration retry without losing listening recorded after the first read failed', async (t) => {
  const sql = new LibraryDatabase(':memory:')
  const saved: ListeningStats = { days: { '2026-10-19': 10 }, tracks: {} }
  const globals = {
    window: globalThis.window,
    indexedDB: globalThis.indexedDB,
    localStorage: globalThis.localStorage
  }
  let loads = 0,
    release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  t.mock.method(ListeningStatsDatabase.prototype, 'load', async () => {
    if (++loads === 1) throw new Error('initial history read unavailable')
    await gate
    return structuredClone(saved)
  })
  const written: ListeningStats[] = []
  t.mock.method(ListeningStatsDatabase.prototype, 'save', async (value: ListeningStats) => {
    written.push(structuredClone(value))
  })
  Object.assign(globalThis, {
    // The database adapter is mocked; this test exercises the actual store and
    // SQL projection coordination, not an alternative IndexedDB implementation.
    indexedDB: { open: () => ({}) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    window: {
      addEventListener() {},
      removeEventListener() {},
      api: {
        library: {
          getStorageMode: async () => 'sqlite',
          database: {
            syncListeningHistory: async (request: LibraryHistorySyncRequest) =>
              sql.syncListeningHistory(request)
          }
        }
      }
    }
  })
  const store = await import('../useListeningStatsStore.ts')
  t.after(() => {
    release()
    store.libraryListeningProjection.dispose()
    store.resetListeningStatsForTest()
    Object.assign(globalThis, globals)
    sql.close()
  })
  const track: Track = {
    id: 'new',
    title: 'New song',
    artist: 'Singer',
    album: 'Album',
    filePath: 'D:/Music/new.flac',
    fileName: 'new.flac',
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null,
    source: 'local'
  }
  sql.replaceDocument({
    version: 2,
    revision: 0,
    tracks: [{ ...track }],
    folders: [],
    exclusions: []
  })
  store.recordListeningForTest(track, 5, Date.UTC(2026, 9, 19))
  const projection = store.libraryListeningProjection.ensure()
  const flush = store.flushListeningStatsForExit()
  await new Promise<void>((resolve) => setImmediate(resolve))
  const concurrentLoads = loads
  release()
  await Promise.all([projection, flush])
  assert.equal(concurrentLoads, 2, 'the initial failed read and a single shared retry')
  const stats = store.useListeningStatsStore().listeningStats.value
  assert.equal(stats.days['2026-10-19'], 15)
  assert.equal(Object.values(stats.tracks)[0]?.seconds, 5)
  assert.equal(written.at(-1)?.days['2026-10-19'], 15)
  assert.equal(store.libraryListeningProjection.state.value.ready, true)
  assert.equal(sql.queryTracks().historyRevision, 1)
})
