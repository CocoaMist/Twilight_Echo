import { LEGACY_QUEUE_SCHEMA_SQL } from './legacyQueueSchema.fixture.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { LibraryDatabase } from './libraryDatabase.ts'
import { normalizeLibraryFilePath } from './libraryRepository.ts'
import {
  enumerateDatabaseDirectory,
  runDatabaseScan,
  type DatabaseScannerOptions,
  type DirectoryScanPage
} from './libraryDatabaseScanner.ts'
import {
  LIBRARY_SCAN_DATABASE_METHODS,
  type LibraryScanDatabaseApi,
  type LibraryScanProgressSnapshot
} from '../../shared/libraryDatabase.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(t: test.TestContext, count: number) {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-scanner-'))
  const db = new LibraryDatabase(join(root, 'library.sqlite'))
  db.updateConfiguration({ folders: [root], exclusions: [] })
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  const identities = Array.from({ length: count }, (_, i) => {
    const filePath = join(root, `${String(i).padStart(4, '0')}.flac`)
    writeFileSync(filePath, 'fixture')
    const info = statSync(filePath)
    return { filePath, size: info.size, mtimeMs: info.mtimeMs }
  })
  const database = Object.fromEntries(
    LIBRARY_SCAN_DATABASE_METHODS.map((name) => [
      name,
      async (...args: unknown[]) => (db[name] as (...args: unknown[]) => unknown).apply(db, args)
    ])
  ) as unknown as LibraryScanDatabaseApi
  db.startScan({ id: 'job', roots: [root], mode: 'full' })
  const statuses: LibraryScanProgressSnapshot[] = []
  const options: DatabaseScannerOptions = {
    jobId: 'job',
    database,
    enumerate: (directory) => enumerateDatabaseDirectory(directory, async () => undefined),
    parse: async (identity) => ({
      identity,
      metadataRead: true,
      tracks: [{ id: identity.filePath, filePath: identity.filePath, duration: 1 }]
    }),
    waitUntilRunnable: async () => {},
    cancelled: () => false,
    onProgress: (progress) => statuses.push(progress)
  }
  return { db, root, identities, options, statuses }
}

test('enumeration stats four files at a time, preserves order and CUE signatures, and stops at a page boundary', async (t) => {
  const { root, identities } = fixture(t, 260)
  mkdirSync(join(root, 'child'))
  writeFileSync(join(root, 'ignored.txt'), 'unsupported')
  const original = fsPromises.stat
  let active = 0,
    peak = 0
  const started: string[] = []
  t.mock.method(fsPromises, 'stat', async (path: Parameters<typeof original>[0]) => {
    started.push(String(path))
    peak = Math.max(peak, ++active)
    try {
      await new Promise((resolve) => setImmediate(resolve))
      return await original(path)
    } finally {
      active--
    }
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const signatures = new Map(
    identities
      .slice(0, 259)
      .map((identity, index) => [normalizeLibraryFilePath(identity.filePath), `cue-${index}`])
  )
  const pages: DirectoryScanPage[] = []
  for await (const page of enumerateDatabaseDirectory(root, async () => signatures)) {
    assert.ok(page.identities.length + page.children.length <= 256)
    assert.equal(active, 0, 'a yielded page leaves no unobserved stat operations')
    pages.push(page)
  }
  assert.equal(peak, 4)
  assert.equal(pages.length, 2)
  assert.deepEqual(
    pages.flatMap((page) => page.children),
    [join(root, 'child')]
  )
  const actual = pages.flatMap((page) => page.identities)
  assert.deepEqual(
    actual.map((identity) => identity.filePath),
    started
  )
  assert.deepEqual(
    actual.slice().sort((a, b) => a.filePath.localeCompare(b.filePath)),
    identities.map((identity, index) => ({
      ...identity,
      ...(index < 259 ? { cueSignature: `cue-${index}` } : {})
    }))
  )
  started.length = 0
  const iterator = enumerateDatabaseDirectory(root, async () => 'shared-cue')
  const first = await iterator.next()
  assert.equal(first.done, false)
  assert.equal(first.value!.identities.length + first.value!.children.length, 256)
  assert.ok(first.value!.identities.every((identity) => identity.cueSignature === 'shared-cue'))
  const checked = started.length
  await iterator.return(undefined)
  assert.equal(started.length, checked, 'closing a page does not read ahead into the next page')
  assert.equal(active, 0)
})

test('a concurrent stat failure fails the directory and cannot authorize missing-file cleanup', async (t) => {
  const { db, root, identities, options } = fixture(t, 8)
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [root],
    exclusions: [],
    tracks: [{ id: 'retained', filePath: join(root, 'offline.flac') }]
  })
  const original = fsPromises.stat
  t.mock.method(fsPromises, 'stat', async (path: Parameters<typeof original>[0]) => {
    await new Promise((resolve) => setImmediate(resolve))
    if (normalizeLibraryFilePath(String(path)) === normalizeLibraryFilePath(identities[1].filePath))
      throw new Error('EACCES: stat denied')
    return original(path)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  await assert.rejects(runDatabaseScan(options), /EACCES: stat denied/)
  assert.equal(db.getMetadata().trackCount, 1)
  assert.equal(db.getScanProgress('job').checkedFiles, 0)
  assert.equal(db.sql.prepare('SELECT state FROM scan_directories').get()!.state, 'failed')
  assert.throws(() => db.finishScan('job'), /Incomplete/)
  await new Promise((resolve) => setImmediate(resolve))
})

test('unchanged checking coalesces SQL progress reads to 250ms while preserving exact final counters', async (t) => {
  const { db, root, identities, options } = fixture(t, 3)
  await runDatabaseScan(options)
  db.startScan({ id: 'warm', roots: [root], mode: 'startup' })
  let now = 0,
    reads = 0
  t.mock.method(performance, 'now', () => now)
  const read = options.database.getScanProgress
  options.database.getScanProgress = async (id) => {
    reads++
    return read(id)
  }
  const reported: number[] = []
  const result = await runDatabaseScan({
    ...options,
    jobId: 'warm',
    enumerate: async function* () {
      for (const [index, time] of [0, 100, 250].entries()) {
        now = time
        yield { identities: [identities[index]], children: [] }
      }
    },
    onProgress: (progress, phase) => {
      assert.equal(phase, 'checking')
      reported.push(progress.checkedFiles)
    }
  })
  assert.deepEqual(reported, [1, 3])
  assert.equal(reads, 3, 'two visible checking snapshots plus one exact terminal read')
  assert.equal(result.progress.checkedFiles, 3)
  assert.equal(result.progress.committedFiles, 3)
  assert.equal(result.progress.parsedFiles, 0)
  assert.equal(result.progress.state, 'completed')
})

test('phase transitions and durable commit notifications bypass the checking throttle', async (t) => {
  const { identities, options } = fixture(t, 2)
  t.mock.method(performance, 'now', () => 0)
  const phases: string[] = []
  const result = await runDatabaseScan({
    ...options,
    enumerate: async function* () {
      for (const identity of identities) yield { identities: [identity], children: [] }
    },
    onProgress: (_, phase) => phases.push(phase)
  })
  assert.deepEqual(phases, ['checking', 'parsing', 'checking', 'parsing', 'committing'])
  assert.equal(result.progress.parsedFiles, 2)
  assert.equal(result.progress.committedFiles, 2)
})

test('cancelling between coalesced snapshots returns all checked files, not the last reported snapshot', async (t) => {
  const { db, root, identities, options } = fixture(t, 2)
  await runDatabaseScan(options)
  db.startScan({ id: 'warm', roots: [root], mode: 'startup' })
  t.mock.method(performance, 'now', () => 0)
  let cancelled = false
  const reported: number[] = []
  const result = await runDatabaseScan({
    ...options,
    jobId: 'warm',
    cancelled: () => cancelled,
    enumerate: async function* () {
      for (const identity of identities) yield { identities: [identity], children: [] }
      cancelled = true
    },
    onProgress: (progress) => reported.push(progress.checkedFiles)
  })
  assert.deepEqual(reported, [1])
  assert.equal(result.cancelled, true)
  assert.equal(result.progress.checkedFiles, 2)
  assert.equal(result.progress.committedFiles, 2)
  assert.equal(result.progress.parsedFiles, 0)
  assert.equal(result.removedFileCount, 0)
})

test('directory and result pages stay bounded and slow commits apply backpressure before more parsing', async (t) => {
  const { db, options } = fixture(t, 600)
  const commit = options.database.commitScanBatch.bind(options.database)
  const entered = deferred(),
    release = deferred()
  let parsed = 0,
    maxBatch = 0,
    unconfirmed = 0,
    peak = 0,
    claims = 0,
    metadataPages = 0
  const claim = options.database.claimScanFiles
  options.database.claimScanFiles = async (id, limit) => {
    claims++
    return claim(id, limit)
  }
  const readMetadata = options.database.getScanAudioMetadata
  options.database.getScanAudioMetadata = async (id, identities) => {
    metadataPages++
    assert.ok(identities.length <= 256)
    return readMetadata(id, identities)
  }
  const parse = options.parse
  options.parse = async (identity) => {
    parsed++
    return parse(identity)
  }
  options.database.commitScanBatch = async (batch) => {
    maxBatch = Math.max(maxBatch, batch.files.length)
    peak = Math.max(peak, ++unconfirmed)
    entered.resolve()
    await release.promise
    try {
      return await commit(batch)
    } finally {
      unconfirmed--
    }
  }
  const pending = runDatabaseScan(options)
  await entered.promise
  assert.equal(db.getMetadata().trackCount, 0)
  assert.ok(parsed <= 260)
  assert.equal(db.getScanProgress('job').parsedFiles, 0)
  release.resolve()
  const result = await pending
  assert.equal(result.progress.checkedFiles, 600)
  assert.equal(result.progress.parsedFiles, 600)
  assert.equal(result.progress.trackCount, 600)
  assert.equal(maxBatch, 256)
  assert.equal(peak, 1)
  assert.ok(claims <= 16, 'claim transactions are paged, not issued for every four parsers')
  assert.equal(metadataPages, 3, 'cached audio metadata is read once per bounded work page')
})

test('a partial batch commits within one second while the next metadata group is still parsing', async (t) => {
  const { db, options } = fixture(t, 8)
  const blocked = deferred(),
    committed = deferred()
  const parse = options.parse
  let parsed = 0
  options.parse = async (identity) => {
    if (++parsed > 4) await blocked.promise
    return parse(identity)
  }
  options.onProgress = (progress, phase) => {
    if (phase === 'committing' && progress.trackCount === 4) committed.resolve()
  }
  const pending = runDatabaseScan(options)
  await committed.promise
  assert.equal(db.getMetadata().trackCount, 4)
  assert.equal(db.getScanProgress('job').parsedFiles, 4)
  blocked.resolve()
  assert.equal((await pending).progress.trackCount, 8)
})

test('incomplete enumeration retains missing tracks and already acknowledged batches', async (t) => {
  const { db, root, options } = fixture(t, 1)
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [root],
    exclusions: [],
    tracks: [{ id: 'offline', filePath: join(root, 'offline.flac') }]
  })
  const enumerate = options.enumerate
  options.enumerate = async function* (directory) {
    yield* enumerate(directory)
    await new Promise((resolve) => setTimeout(resolve, 30))
    throw new Error('EACCES: directory enumeration failed')
  }
  options.flushIntervalMs = 5
  await assert.rejects(runDatabaseScan(options), /EACCES/)
  assert.equal(db.getMetadata().trackCount, 2)
  assert.equal(db.getScanProgress('job').parsedFiles, 1)
  assert.throws(() => db.finishScan('job'), /Incomplete/)
})

test('a timed-out file is recorded as failed without stalling or replacing playable records', async (t) => {
  const { db, root, identities, options } = fixture(t, 2)
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [root],
    exclusions: [],
    tracks: [{ id: 'old', filePath: identities[0].filePath, title: 'Playable' }]
  })
  const parse = options.parse
  options.parse = async (identity) => {
    if (
      normalizeLibraryFilePath(identity.filePath) ===
      normalizeLibraryFilePath(identities[0].filePath)
    )
      throw new Error('Metadata timed out')
    return parse(identity)
  }
  const result = await runDatabaseScan(options)
  assert.equal(result.progress.failedFiles, 1)
  assert.equal(result.progress.parsedFiles, 2)
  assert.equal(result.progress.trackCount, 2)
  assert.equal(db.getTracksByIds(['old']).tracks[0].title, 'Playable')
  assert.match(
    String(db.sql.prepare("SELECT last_error FROM files WHERE status='failed'").get()?.last_error),
    /timed out/
  )
})

test('a rejected commit cannot acknowledge tracks or durable scan counters', async (t) => {
  const { db, options, statuses } = fixture(t, 8)
  options.database.commitScanBatch = async () => {
    throw new Error('SQLITE_FULL')
  }
  await assert.rejects(runDatabaseScan(options), /SQLITE_FULL/)
  assert.equal(db.getMetadata().trackCount, 0)
  assert.equal(db.getScanProgress('job').parsedFiles, 0)
  assert.ok(statuses.every((progress) => progress.committedFiles === 0))
})

test('a commit conflict during enumeration rechecks only its directory and reparses only the changed file', async (t) => {
  const { db, options } = fixture(t, 260)
  const parse = options.parse
  let changed = false
  options.parse = async (identity) => {
    const result = await parse(identity)
    if (!changed) {
      changed = true
      writeFileSync(identity.filePath, 'changed during parse')
    }
    return result
  }
  const result = await runDatabaseScan(options)
  assert.equal(result.progress.trackCount, 260)
  assert.equal(result.progress.parsedFiles, 261)
  assert.equal(db.getScanProgress('job').checkedFiles, 260)
})

test('a file deleted during parsing is not re-added and cannot strand a stale retry forever', async (t) => {
  const { db, root, identities, options } = fixture(t, 2)
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [root],
    exclusions: [],
    tracks: [{ id: 'deleted', filePath: identities[0].filePath }]
  })
  const parse = options.parse
  options.parse = async (identity) => {
    const result = await parse(identity)
    if (
      normalizeLibraryFilePath(identity.filePath) ===
      normalizeLibraryFilePath(identities[0].filePath)
    )
      rmSync(identity.filePath)
    return result
  }
  const result = await runDatabaseScan(options)
  assert.equal(result.progress.state, 'completed')
  assert.equal(result.progress.trackCount, 1)
  assert.equal(db.getTracksByIds(['deleted']).total, 0)
})

test('a pause racing with task claims or finalization never looks like an exhausted scan', async (t) => {
  for (const boundary of ['files', 'directories', 'finish']) {
    await t.test(boundary, async (t) => {
      const { db, options } = fixture(t, 2)
      let raced = false
      const duringPause = <T>(operation: () => T): T => {
        raced = true
        db.setScanState('job', 'paused')
        const value = operation()
        // Resume before delivering the response, as different process ports
        // can overtake each other's pause/resume notifications.
        db.resumeScan('job')
        return value
      }
      if (boundary === 'files') {
        const claim = options.database.claimScanFiles
        options.database.claimScanFiles = async (id, limit) => {
          if (!raced && db.getScanProgress(id).checkedFiles)
            return duringPause(() => db.claimScanFiles(id, limit))
          return claim(id, limit)
        }
      } else if (boundary === 'directories') {
        const claim = options.database.claimScanDirectories
        options.database.claimScanDirectories = async (id, limit) =>
          !raced ? duringPause(() => db.claimScanDirectories(id, limit)) : claim(id, limit)
      } else {
        const finish = options.database.finishScan
        options.database.finishScan = async (id) =>
          !raced ? duringPause(() => db.finishScan(id)) : finish(id)
      }
      const result = await runDatabaseScan(options)
      assert.equal(raced, true)
      assert.equal(result.progress.state, 'completed')
      assert.equal(result.progress.parsedFiles, 2)
      assert.equal(result.progress.trackCount, 2)
    })
  }
})

test('schema v1 upgrades only after a consistent snapshot including committed WAL records', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-upgrade-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'library.sqlite')
  const original = new LibraryDatabase(path)
  original.replaceDocument({
    version: 2,
    revision: 9,
    folders: [root],
    exclusions: [],
    tracks: [{ id: 'wal', filePath: join(root, 'one.flac') }]
  })
  original.sql.exec(
    LEGACY_QUEUE_SCHEMA_SQL +
      `DROP TABLE queue_snapshots; DROP INDEX queues_state; ALTER TABLE queues DROP COLUMN state; ALTER TABLE queues DROP COLUMN play_mode; DROP INDEX tracks_recording; DROP INDEX tracks_playlist_path; DROP INDEX tracks_playlist_suffix;
    ALTER TABLE tracks DROP COLUMN playlist_path; ALTER TABLE tracks DROP COLUMN playlist_path_reverse;
    ALTER TABLE scan_jobs DROP COLUMN parsed_files; ALTER TABLE files DROP COLUMN audio_metadata;
    DROP INDEX queue_entries_original; ALTER TABLE queue_entries DROP COLUMN original_position;
    ALTER TABLE queues DROP COLUMN selected_entry; ALTER TABLE queues DROP COLUMN ordering;
    ALTER TABLE queues DROP COLUMN total_count; DROP INDEX scan_checkpoint_cleanup; ALTER TABLE scan_jobs DROP COLUMN checked_files; ALTER TABLE scan_jobs DROP COLUMN checkpoints_reclaimed; PRAGMA user_version=1;`
  )
  // Leave this writer open so the upgrade must read committed WAL pages.
  const upgraded = new LibraryDatabase(path)
  try {
    assert.equal(upgraded.sql.prepare('PRAGMA user_version').get()?.user_version, 29)
    assert.equal(upgraded.getTracksByIds(['wal']).tracks[0].id, 'wal')
    const names = readdirSync(root).filter((name) => name.includes('.v1-backup-'))
    assert.equal(names.length, 1)
    const snapshot = new DatabaseSync(join(root, names[0]), { readOnly: true })
    try {
      assert.equal(snapshot.prepare('PRAGMA user_version').get()?.user_version, 1)
      assert.equal(snapshot.prepare('SELECT id FROM tracks').get()?.id, 'wal')
      assert.equal(snapshot.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok')
    } finally {
      snapshot.close()
    }
  } finally {
    upgraded.close()
    original.close()
  }
})
