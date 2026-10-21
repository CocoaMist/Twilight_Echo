import assert from 'node:assert/strict'
import test, { after, type TestContext } from 'node:test'
import { LibraryDatabase } from '../../../main/library/libraryDatabase.ts'
import type { LocalLibraryScanStatus } from '../../../shared/localLibraryScan.ts'
import { useMusicStore } from './useMusicStore.ts'
import { useSettingsStore } from './useSettingsStore.ts'

const track = {
  id: 'local:a',
  title: 'Moon',
  artist: 'Audrey',
  album: '',
  filePath: 'D:/Music/a.flac',
  fileName: 'a.flac',
  size: 1,
  duration: 180,
  cover: null,
  lyrics: null,
  source: 'local' as const
}
const status = (
  state: Exclude<LocalLibraryScanStatus['state'], 'idle'>,
  revision: number
): LocalLibraryScanStatus => ({
  jobId: 'scan',
  mode: 'startup',
  state,
  current: 1,
  total: 1,
  parsedFileCount: 1,
  skippedUnchanged: 0,
  error: '',
  databaseProgress: {
    jobId: 'scan',
    state,
    phase: 'idle',
    checkedFiles: 1,
    parsedFiles: 1,
    committedFiles: 1,
    failedFiles: 0,
    trackCount: 1,
    revision
  }
})
const database = new LibraryDatabase(':memory:')
after(() => database.close())

function fixture(t: TestContext) {
  const db = database
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [track] })
  const store = useMusicStore()
  store.clearTracks()
  const settings = useSettingsStore().settings
  settings.value.cachePolicy = {
    ...settings.value.cachePolicy,
    metadata: false,
    cover: false,
    lyrics: false
  }
  let reads = 0,
    metadataReads = 0,
    writes = 0,
    scans = 0,
    fail = false
  const api = {
    library: {
      getStorageMode: async () => 'sqlite',
      scanStartup: async () => {
        scans++
        throw new Error('must not rescan')
      },
      reset: async () => {
        db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [] })
        return {
          library: db.exportDocument(),
          removedTrackIds: [track.id],
          removedFilePaths: [track.filePath]
        }
      },
      database: {
        getMetadata: async () => {
          metadataReads++
          if (fail) throw new Error('database offline')
          return db.getMetadata()
        },
        getTracksByIds: async (ids: string[]) => db.getTracksByIds(ids),
        lookupTracksByPaths: async (paths: string[], revision?: number) =>
          db.lookupTracksByPaths(paths, revision),
        queryTracks: async (query?: Parameters<typeof db.queryTracks>[0]) =>
          db.queryTracks(query),
        patchTracks: async (patches: Parameters<typeof db.patchTracks>[0]) => {
          const saved = db.patchTracks(patches)
          void store.handleLibraryChange({ kind: 'database', revision: saved.revision })
          return saved
        }
      }
    },
    data: {
      loadMusicLibrary: async () => {
        reads++
        if (fail) throw new Error('database offline')
        return db.exportDocument()
      },
      saveMusicLibrary: async () => {
        writes++
        throw new Error('must not replace whole database')
      }
    },
    providers: { list: async () => [], call: async () => ({ items: [], total: 0 }) }
  }
  ;(globalThis as Record<string, unknown>).window = { api }
  t.after(() => {
    store.cancelLibraryMetadataEnrichment()
    store.clearTracks()
  })
  return {
    db,
    store,
    api,
    version: db.getTracksByIds([track.id]).versions[track.id],
    get counts() {
      return { reads, metadataReads, writes, scans }
    },
    setFail(value: boolean) {
      fail = value
    }
  }
}

test('application authority discovery fails explicitly, without loading or writing a stale snapshot', async (t) => {
  const f = fixture(t)
  f.api.library.getStorageMode = async () => {
    throw new Error('storage discovery failed')
  }
  await assert.rejects(f.store.loadApplicationLibrary(), /storage discovery failed/)
  assert.deepEqual(f.counts, { reads: 0, metadataReads: 0, writes: 0, scans: 0 })
})

test('SQLite legacy file events never fall back to renderer folder scans', async (t) => {
  const f = fixture(t)
  let legacyScanCalls = 0
  Object.assign(f.api, {
    fs: {
      scanMusicFiles: async () => {
        legacyScanCalls += 1
        throw new Error('legacy renderer scan must not run')
      }
    }
  })
  await f.store.loadApplicationLibrary()
  await assert.rejects(
    f.store.handleLibraryChange({ kind: 'add', path: track.filePath }),
    /must not rescan/
  )
  assert.equal(legacyScanCalls, 0)
  assert.equal(f.counts.scans, 1)
})

test('database commits during a scan do not start scans or full exports; cancel refreshes metadata', async (t) => {
  const f = fixture(t)
  await f.store.loadApplicationLibrary()
  f.store.applyLibraryScanStatus(status('running', f.db.getMetadata().revision))
  const saved = f.db.patchTracks([
    { id: track.id, expectedVersion: f.version, patch: { title: 'Committed while scanning' } }
  ])
  await Promise.all(
    Array.from({ length: 500 }, () =>
      f.store.handleLibraryChange({ kind: 'database', revision: saved.revision })
    )
  )
  f.store.flushSaveLibrary()
  await Promise.resolve()
  assert.deepEqual(f.counts, { reads: 0, metadataReads: 1, writes: 0, scans: 0 })
  assert.equal(f.store.tracks.value.length, 0)
  f.store.applyLibraryScanStatus(status('cancelled', saved.revision))
  await f.store.retryLibraryCompatibility()
  assert.equal(f.store.tracks.value.length, 0)
  assert.deepEqual(f.counts, { reads: 0, metadataReads: 2, writes: 0, scans: 0 })
})

test('metadata read failure preserves renderer state and retries the read, not the scanner', async (t) => {
  const f = fixture(t)
  await f.store.loadApplicationLibrary()
  const saved = f.db.patchTracks([
    { id: track.id, expectedVersion: f.version, patch: { title: 'Latest' } }
  ])
  f.setFail(true)
  await assert.rejects(
    f.store.handleLibraryChange({ kind: 'database', revision: saved.revision }),
    /database offline/
  )
  assert.equal(f.store.tracks.value.length, 0)
  assert.equal(f.store.libraryCompatibilityError.value, 'database offline')
  f.setFail(false)
  await f.store.retryLibraryCompatibility()
  assert.equal(f.store.tracks.value.length, 0)
  assert.equal(f.store.libraryCompatibilityError.value, '')
  assert.equal(f.counts.scans, 0)
})

test('an old in-flight metadata read cannot resurrect state after a database reset', async (t) => {
  const f = fixture(t)
  await f.store.loadApplicationLibrary()
  const saved = f.db.patchTracks([
    { id: track.id, expectedVersion: f.version, patch: { title: 'Before reset' } }
  ])
  let release!: () => void, started!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  f.api.library.database.getMetadata = async () => {
    started()
    await hold
    return f.db.getMetadata()
  }
  const pending = f.store.handleLibraryChange({ kind: 'database', revision: saved.revision })
  await ready
  await f.store.resetLibrary()
  assert.equal(f.store.tracks.value.length, 0)
  release()
  await pending
  assert.equal(f.store.tracks.value.length, 0)
  assert.equal(f.store.libraryCompatibilityError.value, '')
})

test('a delayed SQLite scan RPC cannot overwrite the newer job status or exclusions', async (t) => {
  const f = fixture(t)
  await f.store.loadApplicationLibrary()
  const revision = f.db.getMetadata().revision
  f.store.applyLibraryScanStatus({ ...status('running', revision), jobId: 'newer-job' })
  Object.assign(f.api.library, {
    scanStartup: async () => ({
      jobId: 'older-job',
      mode: 'startup',
      state: 'completed',
      libraryRevision: revision,
      exclusions: [{ filePath: track.filePath }],
      addedTracks: [],
      updatedTracks: [],
      removedFilePaths: [],
      parsedFileCount: 1,
      skippedUnchanged: 0,
      reloadRequired: true
    })
  })
  await f.store.startStartupLibraryScan()
  assert.equal(f.store.libraryScanStatus.value.jobId, 'newer-job')
  assert.equal(f.store.libraryScanStatus.value.state, 'running')
  assert.deepEqual(f.store.excludedTracks.value, [])
  f.store.applyLibraryScanStatus(status('completed', revision))
})

test('SQLite automatic enrichment commits per-track patches and keeps unrelated concurrent fields', async (t) => {
  const f = fixture(t)
  const settings = useSettingsStore().settings
  settings.value.cachePolicy = {
    ...settings.value.cachePolicy,
    metadata: true,
    cover: false,
    lyrics: false
  }
  let release!: (value: unknown) => void
  const search = new Promise((resolve) => {
    release = resolve
  })
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  Object.assign(f.api.providers, {
    list: async () => [
      {
        id: 'sqlite-enrichment',
        name: 'Enrichment',
        capabilities: ['search'],
        health: { available: true }
      }
    ],
    call: async () => {
      markStarted()
      return search
    }
  })
  await f.store.loadApplicationLibrary()
  // SQLite startup intentionally keeps the renderer bounded. Enrichment is
  // exercised with an explicitly hydrated row rather than a full startup
  // compatibility snapshot.
  await f.store.addTracks([track])
  await started
  f.db.patchTracks([
    { id: track.id, expectedVersion: f.version, patch: { custom: { preserve: true } } }
  ])
  release({
    items: [
      {
        ...track,
        id: 'sqlite-enrichment:1',
        album: 'Provider Album',
        genre: 'Jazz',
        source: 'sqlite-enrichment'
      }
    ],
    total: 1
  })
  await f.store.whenLibrarySettled()
  await f.store.retryLibraryCompatibility()
  const saved = f.db.getTracksByIds([track.id])
  assert.equal(saved.versions[track.id], f.version + 2)
  assert.equal(saved.tracks[0].album, 'Provider Album')
  assert.deepEqual(saved.tracks[0].custom, { preserve: true })
  assert.equal(f.store.tracks.value[0].album, 'Provider Album')
  assert.equal(f.counts.writes, 0)
  assert.equal(f.counts.scans, 0)
})

test('SQLite tag writes patch rows by path without hydrating or saving a renderer library array', async (t) => {
  const f = fixture(t)
  await f.store.loadApplicationLibrary()
  const changed = await f.store.applyLocalTagWriteAsync([track.filePath], {
    title: 'Edited title',
    artist: 'Edited artist',
    track: 3
  })
  assert.equal(changed, 1)
  const saved = f.db.getTracksByIds([track.id])
  assert.equal(saved.tracks[0].title, 'Edited title')
  assert.equal(saved.tracks[0].artist, 'Edited artist')
  assert.equal(saved.tracks[0].trackNumber, 3)
  assert.equal(f.store.tracks.value.length, 0)
  assert.equal(f.counts.writes, 0)
  t.after(() => f.store.clearTracks())
})

test('SQLite BPM analysis writes and cleanup stay paginated and out of the renderer array', async (t) => {
  const f = fixture(t)
  await f.store.loadApplicationLibrary()
  const analysis = {
    bpm: 120,
    confidence: 0.9,
    source: 'analyzed' as const,
    analyzedAt: '2026-10-20T00:00:00Z',
    algorithmVersion: 1
  }
  assert.equal(f.store.applyBpmAnalysis(track.id, track.filePath, analysis), true)
  for (let i = 0; i < 20 && !f.db.getTracksByIds([track.id]).tracks[0].bpmAnalysis; i++)
    await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(f.db.getTracksByIds([track.id]).tracks[0].bpmAnalysis, analysis)
  assert.equal(f.store.tracks.value.length, 0)
  assert.equal(f.store.clearBpmAnalysis(), true)
  for (let i = 0; i < 20 && f.db.getTracksByIds([track.id]).tracks[0].bpmAnalysis; i++)
    await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(f.db.getTracksByIds([track.id]).tracks[0].bpmAnalysis, null)
  assert.equal(f.store.tracks.value.length, 0)
  t.after(() => f.store.clearTracks())
})
