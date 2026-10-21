import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { LibraryDatabase } from './libraryDatabase.ts'
import { LibraryDatabaseServiceClient } from './libraryDatabaseServiceClient.ts'
import { commitDatabaseLibraryRemoval } from './libraryDatabaseRemovalCoordinator.ts'
import {
  getLocalLibraryRemovalJournalPath,
  recoverLocalLibraryRemoval,
  recoverLocalLibraryRemovalFromDatabase
} from './removal.ts'
import type { LibraryDatabaseWorkerApi } from './libraryDatabaseProtocol.ts'
import type { LocalLibraryTrackSelection } from '../../shared/localLibrary.ts'
import type { LibraryScanCommit } from '../../shared/libraryDatabase.ts'

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-removal-')),
    path = join(root, 'music-library.sqlite')
  let database = new LibraryDatabase(path)
  t.after(() => {
    database.close()
    rmSync(root, { recursive: true, force: true })
  })
  const media = join(root, 'media')
  mkdirSync(media)
  const one = join(media, 'disc.flac'),
    two = join(media, 'two.flac')
  writeFileSync(one, 'disc fixture')
  writeFileSync(two, 'two fixture')
  database.replaceDocument({
    version: 2,
    revision: 0,
    folders: [media],
    exclusions: [],
    tracks: [
      {
        id: 'cue-1',
        filePath: one,
        title: 'CUE 1',
        addedAt: 42,
        cueRange: { startSeconds: 0, endSeconds: 30 }
      },
      {
        id: 'cue-2',
        filePath: one,
        title: 'CUE 2',
        custom: { retained: true },
        cueRange: { startSeconds: 30, endSeconds: 60 }
      },
      { id: 'two', filePath: two, title: 'Unrelated' }
    ]
  })
  const item: LocalLibraryTrackSelection = {
    id: 'cue-1',
    filePath: one,
    title: 'CUE 1',
    artist: 'Artist'
  }
  return {
    root,
    media,
    one,
    two,
    item,
    get db() {
      return database
    },
    reopen() {
      database.close()
      database = new LibraryDatabase(path)
      return database
    }
  }
}
function api(db: LibraryDatabase) {
  return {
    beginRemoval: async (...args: Parameters<LibraryDatabaseWorkerApi['beginRemoval']>) =>
      db.beginRemoval(...args),
    markRemovalAttempting: async (
      ...args: Parameters<LibraryDatabaseWorkerApi['markRemovalAttempting']>
    ) => db.markRemovalAttempting(...args),
    settleRemovalItem: async (...args: Parameters<LibraryDatabaseWorkerApi['settleRemovalItem']>) =>
      db.settleRemovalItem(...args),
    finishRemoval: async (...args: Parameters<LibraryDatabaseWorkerApi['finishRemoval']>) =>
      db.finishRemoval(...args)
  }
}
function claim(db: LibraryDatabase, filePath: string, root: string): LibraryScanCommit {
  const info = statSync(filePath),
    identity = { filePath, size: info.size, mtimeMs: info.mtimeMs }
  db.startScan({ id: 'scan', mode: 'full', roots: [root] })
  db.recordScanFiles('scan', [identity])
  db.claimScanFiles('scan')
  return {
    jobId: 'scan',
    sequence: 1,
    files: [
      {
        identity,
        tracks: [{ id: 'cue-1', filePath, title: 'Old scanner result' }],
        metadataRead: true
      }
    ]
  }
}

test('library-only removal commits all CUE siblings and exclusions without loading a document or touching the file', async (t) => {
  const f = fixture(t),
    before = f.db.getTracksByIds(['two'])
  let trashCalls = 0
  const result = await commitDatabaseLibraryRemoval({
    database: api(f.db),
    id: 'exclude',
    mode: 'library',
    items: [f.item, f.item],
    authorize: async () => {},
    trashItem: async () => {
      trashCalls++
    }
  })
  assert.deepEqual(result.removedTrackIds, ['cue-1', 'cue-2'])
  assert.deepEqual(result.removedFilePaths, [f.one])
  assert.equal(trashCalls, 0)
  assert.ok(existsSync(f.one))
  assert.equal(result.metadata.exclusions[0].filePath, f.one)
  assert.deepEqual(f.db.getTracksByIds(['two']).versions, before.versions)
  assert.equal(f.db.getPendingRemoval(), null)
  assert.equal(f.db.beginRemoval('exclude', 'library', [f.item]).items[0].state, 'succeeded')
  assert.equal(f.db.finishRemoval('exclude').metadata.revision, result.metadata.revision)
  const cleared = f.db.clearFileExclusions([f.one])
  assert.deepEqual(cleared.clearedFilePaths, [f.one])
  assert.equal(cleared.metadata.trackCount, 1)
  assert.equal(f.db.clearFileExclusions([f.one]).metadata.revision, cleared.metadata.revision)
})

test('pending trash blocks parsing and missing-file cleanup, while a claimed old result cannot resurrect removed CUE tracks', (t) => {
  const f = fixture(t),
    batch = claim(f.db, f.one, f.media)
  f.db.beginRemoval('trash', 'trash', [f.item])
  f.db.commitScanBatch(batch)
  assert.equal(f.db.getTracksByIds(['cue-1']).tracks[0].title, 'CUE 1')
  f.db.recordScanFiles('scan', [batch.files[0].identity])
  assert.equal(f.db.claimScanFiles('scan').identities.length, 0)
  // Model a complete directory check while the pending OS operation is active.
  // An unrelated file is seen; the pending target must not be cleaned as absent.
  const info = statSync(f.two)
  f.db.recordScanFiles('scan', [{ filePath: f.two, size: info.size, mtimeMs: info.mtimeMs }])
  f.db.claimScanFiles('scan')
  f.db.commitScanBatch({
    jobId: 'scan',
    sequence: 2,
    files: [
      {
        identity: { filePath: f.two, size: info.size, mtimeMs: info.mtimeMs },
        metadataRead: true,
        tracks: [{ id: 'two', filePath: f.two }]
      }
    ]
  })
  f.db.recordScanDirectory('scan', { path: f.media, children: [] })
  assert.equal(f.db.finishScan('scan').removedFileCount, 0)
  f.db.markRemovalAttempting('trash', f.one)
  unlinkSync(f.one)
  f.db.settleRemovalItem('trash', f.one, true)
  assert.deepEqual(f.db.finishRemoval('trash').removedTrackIds, ['cue-1', 'cue-2'])
})

test('clearing a removal exclusion does not authorize an old in-flight scan result', (t) => {
  const f = fixture(t),
    batch = claim(f.db, f.one, f.media)
  f.db.beginRemoval('exclude', 'library', [f.item])
  f.db.markRemovalAttempting('exclude', f.one)
  f.db.settleRemovalItem('exclude', f.one, true)
  f.db.finishRemoval('exclude')
  f.db.clearFileExclusions([f.one])
  f.db.commitScanBatch(batch)
  assert.equal(f.db.getMetadata().trackCount, 1)
  f.db.recordScanFiles('scan', [batch.files[0].identity])
  assert.equal(f.db.claimScanFiles('scan').identities.length, 1)
})

test('restart after the OS trash and before its database ACK recovers all siblings, not unattempted files', (t) => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'music-library.json'), 'retained migration source')
  f.db.beginRemoval('trash', 'trash', [
    f.item,
    { id: 'two', filePath: f.two, title: 'Two', artist: '' }
  ])
  f.db.markRemovalAttempting('trash', f.one)
  unlinkSync(f.one)
  const db = f.reopen(),
    recovered = db.recoverRemoval()!
  assert.deepEqual(recovered.removedTrackIds, ['cue-1', 'cue-2'])
  assert.equal(recovered.failures.length, 1)
  assert.equal(recovered.metadata.trackCount, 1)
  assert.deepEqual(recovered.metadata.exclusions, [])
  assert.equal(db.recoverRemoval(), null)
  assert.equal(
    readFileSync(join(f.root, 'music-library.json'), 'utf8'),
    'retained migration source'
  )
})

test('a lost commit reply is recovered without retrashing a file or changing unrelated track versions', async (t) => {
  const f = fixture(t),
    database = api(f.db),
    settle = database.settleRemovalItem
  const before = f.db.getTracksByIds(['two'])
  database.settleRemovalItem = async (...args) => {
    await settle(...args)
    throw new Error('lost database reply')
  }
  let trashCalls = 0
  const request = {
    database,
    id: 'lost-reply',
    mode: 'trash' as const,
    items: [f.item],
    authorize: async () => {},
    trashItem: async (filePath: string) => {
      trashCalls++
      unlinkSync(filePath)
    }
  }
  await assert.rejects(commitDatabaseLibraryRemoval(request), /lost database reply/)
  assert.equal(f.db.getPendingRemoval()!.items[0].state, 'succeeded')
  f.db.recoverRemoval()
  database.settleRemovalItem = settle
  await commitDatabaseLibraryRemoval(request)
  assert.equal(trashCalls, 1)
  assert.deepEqual(f.db.getTracksByIds(['two']).versions, before.versions)
})

test('authorization and OS failures preserve playable records and leave no exclusion', async (t) => {
  const f = fixture(t),
    before = f.db.getTracksByIds(['cue-1', 'cue-2'])
  let trashCalls = 0
  const result = await commitDatabaseLibraryRemoval({
    database: api(f.db),
    id: 'denied',
    mode: 'trash',
    items: [f.item],
    authorize: async () => {
      throw new Error('unauthorized')
    },
    trashItem: async () => {
      trashCalls++
    }
  })
  assert.equal(result.failures[0].message, 'unauthorized')
  const failed = await commitDatabaseLibraryRemoval({
    database: api(f.db),
    id: 'os-failed',
    mode: 'trash',
    items: [f.item],
    authorize: async () => {},
    trashItem: async () => {
      throw new Error('access denied')
    }
  })
  assert.equal(failed.failures[0].message, 'access denied')
  assert.equal(trashCalls, 0)
  assert.deepEqual(f.db.getTracksByIds(['cue-1', 'cue-2']).tracks, before.tracks)
  assert.deepEqual(f.db.getTracksByIds(['cue-1', 'cue-2']).versions, before.versions)
  assert.deepEqual(f.db.getMetadata().exclusions, [])
})

test('a changed target is never sent to trash and pending recovery leaves its current file intact', (t) => {
  const f = fixture(t)
  f.db.beginRemoval('changed', 'trash', [f.item])
  writeFileSync(f.one, 'replacement content')
  assert.throws(() => f.db.markRemovalAttempting('changed', f.one), /已变化/)
  const recovered = f.db.recoverRemoval()!
  assert.equal(recovered.removedTrackIds.length, 0)
  assert.equal(recovered.metadata.trackCount, 3)
  assert.ok(existsSync(f.one))
})

test('frozen selection versions reject stale identity before starting any filesystem operation', async (t) => {
  const f = fixture(t)
  const selected = {
    ...f.item,
    expectedVersion: f.db.getTracksByIds([f.item.id]).versions[f.item.id]
  }
  f.db.patchTracks([
    { id: f.item.id, expectedVersion: selected.expectedVersion, patch: { title: 'Edited' } }
  ])
  const revision = f.db.getMetadata().revision
  let authorized = 0,
    trashed = 0
  const result = await commitDatabaseLibraryRemoval({
    database: api(f.db),
    id: 'stale-version',
    mode: 'trash',
    items: [selected],
    authorize: async () => {
      authorized++
    },
    trashItem: async () => {
      trashed++
    }
  })
  assert.match(result.failures[0].message, /选择后已变化/)
  assert.equal(authorized, 0)
  assert.equal(trashed, 0)
  assert.equal(f.db.getMetadata().revision, revision)
  assert.equal(f.db.getMetadata().trackCount, 3)
  assert.equal(existsSync(f.one), true)
  assert.throws(
    () => f.db.beginRemoval('stale-version', 'trash', [{ ...selected, expectedVersion: 2 }]),
    /不同的文件/
  )
  for (const expectedVersion of [0, -1, NaN, 1.5])
    assert.throws(
      () => f.db.beginRemoval('bad-version', 'trash', [{ ...selected, expectedVersion }]),
      /无效/
    )
})

test('an edit while authorizing a frozen batch persists a failed claim and is never sent to trash', async (t) => {
  const f = fixture(t)
  const selected = { ...f.item, expectedVersion: 1 }
  let trashed = 0
  const result = await commitDatabaseLibraryRemoval({
    database: api(f.db),
    id: 'changed-before-claim',
    mode: 'trash',
    items: [selected],
    authorize: async () => {
      f.db.patchTracks([
        { id: selected.id, expectedVersion: 1, patch: { title: 'Concurrent edit' } }
      ])
    },
    trashItem: async () => {
      trashed++
    }
  })
  assert.equal(trashed, 0)
  assert.match(result.failures[0].message, /授权前已变化/)
  assert.equal(f.db.getTracksByIds([selected.id]).tracks[0].title, 'Concurrent edit')
  assert.equal(f.db.getPendingRemoval(), null)
  assert.deepEqual(result.metadata.exclusions, [])
  assert.ok(existsSync(f.one))
})

test('a frozen row incarnation rejects deletion/re-addition even when its ID, path and version are reused', async (t) => {
  const f = fixture(t)
  const snapshot = f.db.createTrackSelection({
    query: { contentRevision: f.db.getMetadata().revision, sort: 'insertion' },
    total: 3,
    ranges: [[0, 1]]
  })
  const row = f.db.readTrackSelection(snapshot.id).rows[0]
  const selected = { ...f.item, expectedVersion: row.version, expectedInstance: row.instance }
  await commitDatabaseLibraryRemoval({
    database: api(f.db),
    id: 'first-life',
    mode: 'library',
    items: [f.item],
    authorize: async () => {},
    trashItem: async () => {}
  })
  const current = f.db.exportDocument()
  f.db.replaceDocument({
    ...current,
    exclusions: [],
    tracks: [...current.tracks, { ...f.item, title: 'Re-added' }]
  })
  assert.equal(f.db.getTracksByIds([f.item.id]).versions[f.item.id], row.version)
  assert.notEqual(
    f.db.sql.prepare('SELECT seq FROM tracks WHERE id=?').get(f.item.id)!.seq,
    row.instance
  )
  let authorized = false
  const result = await commitDatabaseLibraryRemoval({
    database: api(f.db),
    id: 'old-life',
    mode: 'trash',
    items: [selected],
    authorize: async () => {
      authorized = true
    },
    trashItem: async () => {
      throw new Error('must never trash a re-added record')
    }
  })
  assert.equal(authorized, false)
  assert.match(result.failures[0].message, /选择后已变化/)
  assert.equal(f.db.getTracksByIds([f.item.id]).tracks[0].title, 'Re-added')
  assert.ok(existsSync(f.one))
  f.db.closeTrackSelection(snapshot.id)
})

test('frozen physical-file pages remove the complete query without offset skips or reauthorizing changed rows', async (t) => {
  const f = fixture(t)
  const tracks = Array.from({ length: 610 }, (_, i) => ({
    id: `stream-${i}`,
    filePath: join(f.media, `stream-${Math.floor(i / 2)}.flac`),
    title: `CUE ${i}`,
    artist: ''
  }))
  f.db.replaceDocument({
    version: 2,
    revision: f.db.getMetadata().revision,
    folders: [f.media],
    exclusions: [],
    tracks
  })
  const snapshot = f.db.createTrackSelection({
    query: { contentRevision: f.db.getMetadata().revision, sort: 'insertion' },
    total: tracks.length,
    ranges: [[0, tracks.length]]
  })
  assert.equal(snapshot.fileCount, 305)
  f.db.patchTracks([{ id: 'stream-500', expectedVersion: 1, patch: { title: 'Edited later' } }])
  let cursor: number | null = 0,
    removed = 0,
    files = 0,
    failed = 0,
    batch = 0
  do {
    const page = f.db.readTrackSelection(snapshot.id, cursor, 'files')
    const items = page.rows.map((row) => ({
      id: row.track.id,
      filePath: row.track.filePath,
      title: String(row.track.title),
      artist: '',
      expectedVersion: row.version,
      expectedInstance: row.instance
    }))
    assert.ok(items.every((item) => Number.isSafeInteger(item.expectedInstance)))
    assert.ok(items.length <= 200)
    const result = await commitDatabaseLibraryRemoval({
      database: api(f.db),
      id: `stream-${batch++}`,
      mode: 'library',
      items,
      authorize: async () => {},
      trashItem: async () => {
        throw new Error('library-only operation')
      }
    })
    removed += result.removedTrackIds.length
    files += result.removedFilePaths.length
    failed += result.failures.length
    cursor = page.nextCursor
  } while (cursor !== null)
  assert.equal(batch, 2)
  assert.equal(removed, 608)
  assert.equal(files, 304)
  assert.equal(failed, 1)
  assert.equal(f.db.getMetadata().trackCount, 2)
  assert.equal(f.db.getTracksByIds(['stream-500']).tracks[0].title, 'Edited later')
  f.db.closeTrackSelection(snapshot.id)
})

test('acknowledged versioned claims protect every CUE sibling until failure or recovery releases the file', (t) => {
  const f = fixture(t)
  f.db.beginRemoval('guarded', 'library', [{ ...f.item, expectedVersion: 1 }])
  f.db.markRemovalAttempting('guarded', f.one)
  for (const id of ['cue-1', 'cue-2'])
    assert.throws(
      () => f.db.patchTracks([{ id, expectedVersion: 1, patch: { title: 'Too late' } }]),
      /正在移除/
    )
  f.db.patchTracks([{ id: 'two', expectedVersion: 1, patch: { title: 'Independent edit' } }])
  f.db.settleRemovalItem('guarded', f.one, false, 'Cancelled OS operation')
  f.db.finishRemoval('guarded')
  f.db.patchTracks([{ id: 'cue-2', expectedVersion: 1, patch: { title: 'Released' } }])
  f.db.beginRemoval('guarded-recovery', 'library', [{ ...f.item, expectedVersion: 1 }])
  f.db.markRemovalAttempting('guarded-recovery', f.one)
  assert.deepEqual(f.reopen().recoverRemoval()!.removedTrackIds, ['cue-1', 'cue-2'])
  assert.equal(f.db.getTracksByIds(['two']).tracks[0].title, 'Independent edit')
})

test('a malformed or unknown claim reply stops without trashing, replay or settlement', async (t) => {
  const f = fixture(t),
    database = api(f.db),
    original = database.markRemovalAttempting
  let trashed = 0
  database.markRemovalAttempting = async (...args) => {
    const claimed = await original(...args)
    return { ...claimed, id: 'wrong-operation' }
  }
  await assert.rejects(
    commitDatabaseLibraryRemoval({
      database,
      id: 'bad-claim',
      mode: 'trash',
      items: [{ ...f.item, expectedVersion: 1 }],
      authorize: async () => {},
      trashItem: async () => {
        trashed++
      }
    }),
    /检查点回复无效/
  )
  assert.equal(trashed, 0)
  assert.equal(f.db.getPendingRemoval()!.items[0].state, 'working')
  assert.equal(f.db.recoverRemoval()!.failures.length, 1)
  assert.ok(existsSync(f.one))
})

test('recovery never completes an unclaimed library-only deletion before main has authorized it', (t) => {
  const f = fixture(t)
  f.db.beginRemoval('unclaimed', 'library', [f.item])
  assert.throws(() => f.db.settleRemovalItem('unclaimed', f.one, true), /尚未授权/)
  assert.equal(f.db.recoverRemoval()!.metadata.trackCount, 3)
  assert.deepEqual(f.db.getMetadata().exclusions, [])
  f.db.beginRemoval('claimed', 'library', [f.item])
  f.db.markRemovalAttempting('claimed', f.one)
  assert.equal(f.db.recoverRemoval()!.metadata.trackCount, 1)
  assert.ok(existsSync(f.one))
})

test('a file observed while blocked is not cleaned up if the OS operation later fails', (t) => {
  const f = fixture(t)
  f.db.startScan({ id: 'check', mode: 'startup', roots: [f.media] })
  f.db.beginRemoval('blocked', 'trash', [f.item])
  const info = statSync(f.one)
  f.db.recordScanFiles('check', [{ filePath: f.one, size: info.size, mtimeMs: info.mtimeMs }])
  f.db.settleRemovalItem('blocked', f.one, false, 'OS failure')
  f.db.finishRemoval('blocked')
  f.db.recordScanDirectory('check', { path: f.media, children: [] })
  f.db.finishScan('check')
  assert.equal(f.db.getTracksByIds(['cue-1', 'cue-2']).tracks.length, 2)
})

test('an offline directory cannot be mistaken for a successful trash', (t) => {
  const f = fixture(t),
    offline = join(f.root, 'offline-media')
  f.db.beginRemoval('offline', 'trash', [f.item])
  f.db.markRemovalAttempting('offline', f.one)
  // Both resolved paths are direct children of this test's fresh workspace.
  renameSync(f.media, offline)
  assert.throws(() => f.db.recoverRemoval(), /ENOENT/)
  assert.equal(f.db.getPendingRemoval()!.items[0].state, 'working')
  assert.equal(f.db.getMetadata().trackCount, 3)
  renameSync(offline, f.media)
  assert.equal(f.db.recoverRemoval()!.failures.length, 1)
  assert.ok(existsSync(f.one))
})

test('transaction failure rolls back songs and the checkpoint together; recovery retries the database write only', (t) => {
  const f = fixture(t)
  f.db.beginRemoval('full-disk', 'trash', [f.item])
  f.db.markRemovalAttempting('full-disk', f.one)
  unlinkSync(f.one)
  const before = f.db.getMetadata()
  f.db.sql.exec(
    `CREATE TRIGGER fail_removal BEFORE INSERT ON meta WHEN new.key='pending_file_removal' AND instr(new.value,'succeeded')>0 BEGIN SELECT RAISE(ABORT,'SQLITE_FULL'); END;`
  )
  assert.throws(() => f.db.settleRemovalItem('full-disk', f.one, true), /SQLITE_FULL/)
  assert.deepEqual(f.db.getMetadata(), before)
  assert.equal(f.db.getPendingRemoval()!.items[0].state, 'working')
  f.db.sql.exec('DROP TRIGGER fail_removal')
  assert.equal(f.db.recoverRemoval()!.metadata.trackCount, 1)
})

test('bounded operations reject conflicting identities and whole-library replacement cannot erase a live removal', async (t) => {
  const f = fixture(t)
  assert.throws(
    () =>
      f.db.beginRemoval(
        'too-many',
        'trash',
        Array.from({ length: 257 }, () => f.item)
      ),
    /256/
  )
  assert.equal(f.db.getPendingRemoval(), null)
  f.db.beginRemoval('active', 'trash', [f.item])
  assert.throws(() => f.db.beginRemoval('other', 'trash', [f.item]), /未完成/)
  assert.throws(() => f.db.beginRemoval('active', 'library', [f.item]), /不同的文件/)
  assert.throws(
    () =>
      f.db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [] }),
    /未完成/
  )
  await assert.rejects(
    f.db.restorePersonalLibrary(
      { version: 2, revision: 0, folders: [], exclusions: [], tracks: [] },
      'use-backup',
      'restore',
      f.db.getMetadata().revision
    ),
    /未完成/
  )
  assert.equal(f.db.recoverRemoval()!.metadata.trackCount, 3)
})

test(
  'actual database worker recovers a killed process between trashing and committing without reading retained JSON',
  { timeout: 30_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'sqlite-removal-worker-')),
      children: ChildProcess[] = [],
      clients: LibraryDatabaseServiceClient[] = []
    t.after(async () => {
      clients.forEach((client) => client.destroy())
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
      rmSync(root, { recursive: true, force: true })
    })
    const open = () => {
      const client = new LibraryDatabaseServiceClient({
        serviceEntry: fileURLToPath(new URL('./libraryDatabaseService.ts', import.meta.url)),
        libraryFilePath: join(root, 'music-library.json'),
        fork(entry) {
          const child = fork(entry, [], {
            execArgv: ['--experimental-strip-types'],
            stdio: ['ignore', 'ignore', 'pipe', 'ipc']
          })
          children.push(child)
          return {
            postMessage: (message) => {
              child.send(message)
            },
            kill: () => {
              child.kill()
            },
            on: child.on.bind(child)
          }
        }
      })
      clients.push(client)
      return client
    }
    const filePath = join(root, 'one.flac'),
      item = { id: 'one', filePath, title: 'One', artist: '' }
    writeFileSync(filePath, 'fixture')
    const first = open()
    await first.replaceDocument({
      version: 2,
      revision: 0,
      folders: [root],
      exclusions: [],
      tracks: [item]
    })
    writeFileSync(join(root, 'music-library.json'), 'invalid old JSON must not be loaded')
    await first.beginRemoval('worker-trash', 'trash', [item])
    await first.markRemovalAttempting('worker-trash', filePath)
    unlinkSync(filePath)
    first.destroy()
    if (children[0].exitCode === null && children[0].signalCode === null)
      await once(children[0], 'exit')
    const next = open()
    assert.equal((await next.getPendingRemoval())!.items[0].state, 'working')
    assert.deepEqual((await next.recoverRemoval())!.removedTrackIds, ['one'])
    assert.equal((await next.getMetadata()).trackCount, 0)
    assert.equal(await next.getPendingRemoval(), null)
    assert.equal(
      readFileSync(join(root, 'music-library.json'), 'utf8'),
      'invalid old JSON must not be loaded'
    )
  }
)

test('legacy removal logs recover in 256-file batches and a lost reply never removes a subsequently restored song', async (t) => {
  const f = fixture(t),
    libraryFile = join(f.root, 'music-library.json')
  const items = Array.from({ length: 300 }, (_, index) => ({
    id: `legacy-${index}`,
    filePath: join(f.media, `legacy-${index}.flac`),
    title: `Legacy ${index}`,
    artist: ''
  }))
  f.db.replaceDocument({
    ...f.db.exportDocument(),
    tracks: [...f.db.exportDocument().tracks, ...items]
  })
  writeFileSync(libraryFile, 'retained JSON must not be loaded')
  const log = getLocalLibraryRemovalJournalPath(libraryFile)
  writeFileSync(
    log,
    JSON.stringify({
      version: 1,
      expectedRevision: 1,
      targetRevision: 2,
      createdAt: new Date().toISOString(),
      items: [...items, f.item],
      succeededFilePaths: [...items.map((item) => item.filePath), f.one],
      inFlightFilePath: null
    })
  )
  const calls: number[] = []
  let loseReply = true
  const database = {
    getMetadata: async () => f.db.getMetadata(),
    recoverRemovalJournal: async (id: string, batch: LocalLibraryTrackSelection[]) => {
      calls.push(batch.length)
      const result = f.db.recoverRemovalJournal(id, batch)
      if (loseReply) {
        loseReply = false
        throw new Error('lost legacy recovery reply')
      }
      return result
    }
  }
  await assert.rejects(
    recoverLocalLibraryRemovalFromDatabase(libraryFile, database),
    /lost legacy recovery reply/
  )
  assert.throws(() => recoverLocalLibraryRemoval(libraryFile), /SQLite/)
  // Simulate a later, deliberate re-add while the old ACK is still missing.
  writeFileSync(items[0].filePath, 'new file at the same path')
  f.db.replaceDocument({
    ...f.db.exportDocument(),
    tracks: [...f.db.exportDocument().tracks, items[0]]
  })
  const result = (await recoverLocalLibraryRemovalFromDatabase(libraryFile, database))!
  assert.deepEqual(calls, [256, 256, 45])
  assert.equal(result.removedTrackIds.length, 300)
  assert.equal(result.failures.length, 1) // The old success path now exists; keep both CUE records.
  assert.equal(result.metadata.trackCount, 4)
  assert.equal(f.db.getTracksByIds([items[0].id]).tracks.length, 1)
  assert.equal(f.db.getTracksByIds(['cue-1', 'cue-2']).tracks.length, 2)
  assert.equal(existsSync(log), false)
  assert.equal(existsSync(log + '.bak'), false)
  assert.equal(readFileSync(libraryFile, 'utf8'), 'retained JSON must not be loaded')
})

test('a fully acknowledged legacy cursor needs only cleanup, not another deletion request', async (t) => {
  const f = fixture(t),
    libraryFile = join(f.root, 'music-library.json'),
    log = getLocalLibraryRemovalJournalPath(libraryFile)
  writeFileSync(
    log,
    JSON.stringify({
      version: 1,
      expectedRevision: 1,
      targetRevision: 2,
      createdAt: new Date().toISOString(),
      items: [f.item],
      succeededFilePaths: [f.one],
      inFlightFilePath: null,
      databaseRecovery: {
        id: 'completed-cursor',
        items: [f.item],
        cursor: 1,
        removedTrackIds: ['old-id'],
        removedFilePaths: [f.one],
        failures: []
      }
    })
  )
  const result = (await recoverLocalLibraryRemovalFromDatabase(libraryFile, {
    getMetadata: async () => f.db.getMetadata(),
    recoverRemovalJournal: async () => {
      throw new Error('must not replay a completed cursor')
    }
  }))!
  assert.deepEqual(result.removedTrackIds, ['old-id'])
  assert.equal(result.metadata.trackCount, 3)
  assert.ok(existsSync(f.one))
  assert.equal(existsSync(log), false)
})
