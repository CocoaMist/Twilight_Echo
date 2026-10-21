import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { LibraryDatabase } from './libraryDatabase.ts'
import { LibraryDatabaseSelections, validateLibrarySelection } from './libraryDatabaseSelections.ts'
import {
  LibraryDatabaseServiceClient,
  type DatabaseUtilityProcess
} from './libraryDatabaseServiceClient.ts'
import type { LibraryDatabaseWorkerRequest } from './libraryDatabaseProtocol.ts'
import type { LibraryQuery, LibraryTrackRecord } from '../../shared/libraryDatabase.ts'
import type { LibrarySelectionRequest, LibrarySelectionRow } from '../../shared/librarySelection.ts'

const track = (index: number, extra: Record<string, unknown> = {}): LibraryTrackRecord => ({
  id: `t${index}`,
  filePath: `D:/selection/${index}.flac`,
  title: `Track ${String(index).padStart(5, '0')}`,
  artist: 'Artist',
  duration: 100,
  source: 'local',
  ...extra
})
function fixture(t: test.TestContext, count = 605) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 1,
    tracks: Array.from({ length: count }, (_, i) => track(i)),
    folders: [],
    exclusions: []
  })
  return db
}
function request(
  db: LibraryDatabase,
  ranges?: LibrarySelectionRequest['ranges'],
  query: LibraryQuery = {}
): LibrarySelectionRequest {
  const page = db.queryTracks({ ...query, limit: 1 })
  return {
    query: {
      ...query,
      contentRevision: page.revision,
      ...(query.sort === 'lastPlayed' ? { historyRevision: page.historyRevision } : {})
    },
    total: page.total,
    ranges: ranges ?? (page.total ? [[0, page.total]] : [])
  }
}
function readAll(db: LibraryDatabase, id: string, projection: 'tracks' | 'files' = 'tracks') {
  const rows: LibrarySelectionRow[] = []
  let cursor: number | null = 0
  do {
    const page = db.readTrackSelection(id, cursor, projection)
    assert.ok(page.rows.length <= 200)
    rows.push(...page.rows)
    assert.ok(page.nextCursor === null || page.nextCursor > cursor)
    cursor = page.nextCursor
  } while (cursor !== null)
  return rows
}
function cleanup(db: LibraryDatabase) {
  let turns = 0
  while (db.needsQueryMaintenance) {
    assert.ok(++turns < 1000)
    db.maintainQueryState()
  }
}

test('full selection freezes ordered records in at-most-200-row closed transactions without changing the library or queue', (t) => {
  const db = fixture(t, 1205),
    before = db.getMetadata(),
    calls: number[] = []
  const original = db.getTracksByIds.bind(db)
  db.getTracksByIds = (ids) => {
    assert.equal(db.sql.isTransaction, false)
    const page = original(ids)
    calls.push(page.tracks.length)
    return page
  }
  const snapshot = db.createTrackSelection(
    request(db, undefined, { sort: 'insertion', direction: 'desc' })
  )
  assert.equal(snapshot.selectedCount, 1205)
  assert.equal(snapshot.localTrackCount, 1205)
  assert.equal(snapshot.fileCount, 1205)
  assert.ok(calls.every((count) => count <= 200))
  assert.equal(calls.length, 7, 'seven bounded hydration turns')
  assert.equal(db.sql.isTransaction, false)
  assert.deepEqual(db.getMetadata(), before)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM queues').get()!.n, 0)
  const rows = readAll(db, snapshot.id)
  assert.deepEqual(
    rows.map((row) => row.track.id),
    Array.from({ length: 1205 }, (_, i) => `t${1204 - i}`)
  )
  assert.deepEqual(
    rows.map((row) => row.position),
    Array.from({ length: 1205 }, (_, i) => i)
  )
  assert.ok(
    rows.every(
      (row) =>
        row.definitionId === row.track.id &&
        row.version > 0 &&
        Number.isSafeInteger(row.instance) &&
        row.entryId === undefined
    )
  )
})

test('sparse unloaded ranges read only their own pages and preserve absolute query positions', (t) => {
  const db = fixture(t, 2505),
    calls: string[][] = []
  const input = request(
    db,
    [
      [7, 9],
      [998, 1402],
      [2499, 2505]
    ],
    { sort: 'insertion' }
  )
  const hydrate = db.getTracksByIds.bind(db)
  db.getTracksByIds = (ids) => {
    calls.push(ids)
    return hydrate(ids)
  }
  const snapshot = db.createTrackSelection(input)
  assert.deepEqual(
    calls,
    [
      [7, 2],
      [998, 200],
      [1198, 200],
      [1398, 4],
      [2499, 6]
    ].map(([start, count]) => Array.from({ length: count }, (_, index) => `t${start + index}`))
  )
  assert.equal(snapshot.selectedCount, 412)
  const rows = readAll(db, snapshot.id)
  assert.deepEqual(
    rows.map((row) => row.position),
    [7, 8, ...Array.from({ length: 404 }, (_, i) => 998 + i), 2499, 2500, 2501, 2502, 2503, 2504]
  )
})

test('numeric full selection hydrates bounded ID windows without repeatedly scanning deep OFFSET pages', (t) => {
  const db = fixture(t, 1205),
    input = request(db, undefined, { sort: 'insertion', direction: 'desc' }),
    hydrate = db.getTracksByIds.bind(db),
    batches: number[] = []
  db.queryTracks = () => {
    throw new Error('Selection must not repeat the numeric OFFSET query for each batch')
  }
  db.getTracksByIds = (ids) => {
    batches.push(ids.length)
    return hydrate(ids)
  }
  const snapshot = db.createTrackSelection(input)
  assert.equal(snapshot.selectedCount, 1205)
  assert.deepEqual(batches, [200, 200, 200, 200, 200, 200, 5])
  assert.deepEqual(
    readAll(db, snapshot.id).map((row) => row.track.id),
    Array.from({ length: 1205 }, (_, i) => `t${1204 - i}`)
  )
})

test('selection ID windows keep displayed numeric ordering, ties, filters and repeated playlist IDs', (t) => {
  const db = fixture(t, 0)
  db.replaceDocument({
    version: 2,
    revision: 1,
    folders: [],
    exclusions: [],
    tracks: Array.from({ length: 605 }, (_, i) =>
      track(i, { duration: i % 7, addedAt: i % 11, sampleRate: i % 2 ? 48000 : 44100 })
    )
  })
  const queries: LibraryQuery[] = [
    { sort: 'duration', direction: 'desc', filters: { sampleRate: 48000 } },
    { sort: 'recentlyAdded', direction: 'asc' },
    { sort: 'lastPlayed', direction: 'desc' },
    { sort: 'playlist', ids: ['t401', 't1', 't401', 't0', 'missing', 't604'] }
  ]
  for (const query of queries) {
    const displayed = db.queryTracks({ ...query, limit: 1000 }),
      input = request(db, [[1, displayed.total]], query),
      snapshot = db.createTrackSelection(input)
    assert.deepEqual(
      readAll(db, snapshot.id).map((row) => row.track.id),
      displayed.tracks.slice(1).map((row) => row.id)
    )
    db.closeTrackSelection(snapshot.id)
    cleanup(db)
  }
})

test('frozen cursors survive deletion of earlier query rows and metadata edits without skipping or changing intent', (t) => {
  const db = fixture(t, 605),
    snapshot = db.createTrackSelection(request(db, undefined, { sort: 'title' }))
  const first = db.readTrackSelection(snapshot.id)
  assert.equal(first.nextCursor, 200)
  db.beginRemoval(
    'selection-removal',
    'library',
    first.rows.map(({ track }) => ({
      id: track.id,
      filePath: track.filePath,
      title: String(track.title),
      artist: String(track.artist)
    }))
  )
  for (const { track } of first.rows) {
    db.markRemovalAttempting('selection-removal', track.filePath)
    db.settleRemovalItem('selection-removal', track.filePath, true)
  }
  db.finishRemoval('selection-removal')
  const current = db.getTracksByIds(['t250'])
  db.patchTracks([
    { id: 't250', expectedVersion: current.versions.t250, patch: { title: 'Changed later' } }
  ])
  const second = db.readTrackSelection(snapshot.id, first.nextCursor!)
  assert.equal(second.rows[0].track.id, 't200')
  assert.equal(second.rows[50].track.title, 'Track 00250')
  assert.equal(second.rows[50].version, current.versions.t250)
  assert.equal(second.snapshot.revision, snapshot.revision)
  assert.equal(
    readAll(db, snapshot.id).length,
    605,
    'published intent is immutable, not a fresh live query'
  )
  assert.equal(db.getMetadata().trackCount, 405)
})

test('physical-file projection deduplicates CUE occurrences across pages and keeps playback fields', (t) => {
  const db = fixture(t, 0)
  db.replaceDocument({
    version: 2,
    revision: 2,
    folders: [],
    exclusions: [],
    tracks: Array.from({ length: 605 }, (_, i) =>
      track(i, {
        filePath: `D:/selection/${i % 205}.flac`,
        cueRange: { startSeconds: i, endSeconds: i + 1 },
        cueSheetPath: 'D:/selection/disc.cue',
        subTrack: { kind: 'sacd', trackIndex: i },
        lyrics: 'large lyrics',
        custom: 'large extension',
        cover: 'data:image/png;base64,oversized',
        coverSmall: 'cover://kept'
      })
    )
  })
  const snapshot = db.createTrackSelection(request(db, undefined, { sort: 'insertion' }))
  assert.equal(snapshot.localTrackCount, 605)
  assert.equal(snapshot.fileCount, 205)
  const files = readAll(db, snapshot.id, 'files')
  assert.equal(files.length, 205)
  assert.deepEqual(
    files.map((row) => row.position),
    Array.from({ length: 205 }, (_, i) => i)
  )
  assert.deepEqual(files[201].track.cueRange, { startSeconds: 201, endSeconds: 202 })
  assert.deepEqual(files[201].track.subTrack, { kind: 'sacd', trackIndex: 201 })
  assert.equal(files[201].track.cueSheetPath, 'D:/selection/disc.cue')
  assert.equal(files[201].track.custom, undefined)
  assert.equal(files[201].track.lyrics, null)
  assert.equal(files[201].track.cover, undefined)
  assert.equal(files[201].track.coverSmall, 'cover://kept')
})

test('mixed playlist selection keeps repeated occurrences, original definition IDs and compact remote snapshots', (t) => {
  const db = fixture(t, 2)
  db.syncPlaylistView({ kind: 'begin', id: 'mixed', versions: [] })
  db.syncPlaylistView({
    kind: 'append',
    id: 'mixed',
    sequence: 1,
    entries: [
      { id: 'old-id', snapshot: track(0, { id: 'old-id' }) },
      { id: 't1' },
      { id: 't0' },
      {
        id: 'ncm:7',
        snapshot: track(7, {
          id: 'ncm:7',
          source: 'ncm',
          filePath: '',
          streamUrl: 'transient-url',
          lyrics: 'omit'
        })
      },
      { id: 't0' }
    ]
  })
  db.syncPlaylistView({ kind: 'commit', id: 'mixed', sequence: 2 })
  const snapshot = db.createTrackSelection(
    request(db, undefined, { playlistView: 'mixed', sort: 'playlist' })
  )
  const rows = readAll(db, snapshot.id)
  assert.deepEqual(
    rows.map((row) => row.entryId),
    ['0', '1', '2', '3', '4']
  )
  assert.deepEqual(
    rows.map((row) => row.definitionId),
    ['old-id', 't1', 't0', 'ncm:7', 't0']
  )
  assert.deepEqual(
    rows.map((row) => row.track.id),
    ['t0', 't1', 't0', 'ncm:7', 't0']
  )
  assert.equal(rows[3].version, 0)
  assert.equal(rows[3].instance, undefined)
  assert.equal(rows[3].track.streamUrl, undefined)
  assert.equal(snapshot.localTrackCount, 4)
  assert.equal(snapshot.fileCount, 2)
  db.syncPlaylistView({ kind: 'drop', id: 'mixed' })
  assert.deepEqual(
    readAll(db, snapshot.id),
    rows,
    'published selection no longer depends on the view lease'
  )
})

test('library/content/count and history fences reject stale selections, including empty ones', (t) => {
  const db = fixture(t, 5),
    input = request(db)
  const current = db.getTracksByIds(['t0'])
  db.patchTracks([{ id: 't0', expectedVersion: current.versions.t0, patch: { title: 'New' } }])
  assert.throws(() => db.createTrackSelection(input), /发生变化/)
  assert.throws(() => db.createTrackSelection({ ...request(db), total: 7 }), /changed/)
  assert.throws(() => db.createTrackSelection({ ...input, ranges: [] }), /发生变化/)
  const recent = request(db, [], { sort: 'lastPlayed' })
  db.syncListeningHistory({ kind: 'begin', id: 'history', mode: 'replace' })
  db.syncListeningHistory({
    kind: 'append',
    id: 'history',
    sequence: 1,
    entries: [{ id: 't0', lastPlayed: 50 }]
  })
  db.syncListeningHistory({ kind: 'commit', id: 'history', sequence: 2 })
  assert.throws(() => db.createTrackSelection(recent), /history changed/)
  cleanup(db)
  const empty = db.createTrackSelection(request(db, []))
  assert.equal(empty.selectedCount, 0)
  assert.deepEqual(db.readTrackSelection(empty.id).rows, [])
})

test('cooperative construction checks the content and playlist token before each batch', (t) => {
  const db = fixture(t),
    input = request(db),
    build = db.beginTrackSelectionBuild(input)
  assert.deepEqual(db.advanceTrackSelectionBuild(build), { ready: false })
  assert.throws(() => db.readTrackSelection(build.build.id), /not ready/)
  const row = db.getTracksByIds(['t1'])
  db.patchTracks([{ id: 't1', expectedVersion: row.versions.t1, patch: { title: 'Changed' } }])
  assert.throws(() => db.advanceTrackSelectionBuild(build), /发生变化/)
  db.abandonTrackSelectionBuild(build)
  cleanup(db)
  db.syncPlaylistView({ kind: 'begin', id: 'same-id', versions: [] })
  for (let offset = 0, sequence = 1; offset < 405; offset += 200, sequence++)
    db.syncPlaylistView({
      kind: 'append',
      id: 'same-id',
      sequence,
      entries: Array.from({ length: Math.min(200, 405 - offset) }, () => ({ id: 't0' }))
    })
  db.syncPlaylistView({ kind: 'commit', id: 'same-id', sequence: 4 })
  const playlist = db.beginTrackSelectionBuild(
    request(db, undefined, { playlistView: 'same-id', sort: 'playlist' })
  )
  assert.deepEqual(db.advanceTrackSelectionBuild(playlist), { ready: false })
  db.syncPlaylistView({ kind: 'drop', id: 'same-id' })
  cleanup(db)
  db.syncPlaylistView({ kind: 'begin', id: 'same-id', versions: [] })
  db.syncPlaylistView({ kind: 'commit', id: 'same-id', sequence: 1 })
  assert.throws(() => db.advanceTrackSelectionBuild(playlist), /changed|expired/)
  db.abandonTrackSelectionBuild(playlist)
  cleanup(db)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM selection_rows').get()!.n, 0)
})

test('failed construction transaction does not advance its cursor, counts or physical-file index', (t) => {
  const db = fixture(t),
    build = db.beginTrackSelectionBuild(request(db))
  db.sql.exec(`CREATE TEMP TRIGGER fail_selection BEFORE INSERT ON selection_rows WHEN new.seq=10
    BEGIN SELECT RAISE(ABORT,'injected selection failure'); END;`)
  assert.throws(() => db.advanceTrackSelectionBuild(build), /injected selection failure/)
  assert.equal(build.build.offset, 0)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM selection_rows').get()!.n, 0)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM selection_files').get()!.n, 0)
  assert.equal(db.sql.isTransaction, false)
  db.sql.exec('DROP TRIGGER fail_selection')
  let result = db.advanceTrackSelectionBuild(build)
  while (!result.ready) result = db.advanceTrackSelectionBuild(build)
  assert.equal(result.snapshot.localTrackCount, 605)
  assert.equal(result.snapshot.fileCount, 605)
  assert.equal(readAll(db, result.snapshot.id).length, 605)
})

test('close immediately fences reads/builds and cooperative cleanup reserves bounded slots until rows are gone', (t) => {
  const db = fixture(t),
    input = request(db),
    snapshots = Array.from({ length: 4 }, () => db.createTrackSelection(input))
  assert.throws(() => db.createTrackSelection(input), /Too many/)
  const id = snapshots[0].id
  db.closeTrackSelection(id)
  db.closeTrackSelection(id)
  assert.throws(() => db.readTrackSelection(id), /expired/)
  assert.throws(() => db.createTrackSelection(input), /Too many/)
  const before = Number(db.sql.prepare('SELECT count(*) AS n FROM selection_rows').get()!.n)
  db.maintainQueryState()
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM selection_rows').get()!.n, before - 200)
  assert.equal(db.sql.isTransaction, false)
  cleanup(db)
  db.createTrackSelection(input)
  for (const snapshot of snapshots) db.closeTrackSelection(snapshot.id)
  cleanup(db)
})

test('idle expiry fences late reads and build continuations, then releases both TEMP indexes in bounded turns', (t) => {
  const db = fixture(t),
    input = request(db),
    snapshot = db.createTrackSelection(input),
    build = db.beginTrackSelectionBuild(input)
  db.advanceTrackSelectionBuild(build)
  const now = Date.now()
  t.mock.method(Date, 'now', () => now + 120_001)
  assert.throws(() => db.readTrackSelection(snapshot.id), /expired/)
  assert.throws(() => db.advanceTrackSelectionBuild(build), /expired/)
  cleanup(db)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM selection_rows').get()!.n, 0)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM selection_files').get()!.n, 0)
})

test('selection scope and cursor validation reject oversized, ambiguous, unfenced and invalid inputs', (t) => {
  const db = fixture(t, 5),
    input = request(db)
  for (const value of [
    null,
    {},
    { ...input, query: {} },
    { ...input, total: -1 },
    { ...input, ranges: [[0, 0]] },
    { ...input, ranges: [[0, 6]] },
    {
      ...input,
      ranges: [
        [0, 2],
        [2, 4]
      ]
    },
    {
      ...input,
      ranges: [
        [2, 4],
        [0, 1]
      ]
    },
    { ...input, ranges: [[0.5, 1]] },
    { ...input, ranges: Array(4097).fill([0, 1]) },
    ...['offset', 'limit', 'anchorId', 'playlistEntryId', 'aggregate'].map((key) => ({
      ...input,
      query: { ...input.query, [key]: key === 'limit' ? 1 : 0 }
    })),
    { ...input, query: { ...input.query, sort: 'lastPlayed' } }
  ])
    assert.throws(() => validateLibrarySelection(value))
  const snapshot = db.createTrackSelection(input)
  for (const cursor of [-1, 0.5, NaN, 6])
    assert.throws(() => db.readTrackSelection(snapshot.id, cursor), /Invalid/)
  assert.throws(() => db.readTrackSelection(snapshot.id, 0, 'unknown' as 'tracks'), /Invalid/)
  assert.throws(() => db.readTrackSelection(''), /Invalid/)
  assert.throws(() => db.closeTrackSelection('x'.repeat(129)), /Invalid/)
})

test('count mismatch and incomplete source pages never publish a silently narrowed selection', (t) => {
  const db = fixture(t, 0),
    sql = db.sql
  const selections = new LibraryDatabaseSelections({
    sql,
    transaction: (action) => {
      sql.exec('BEGIN')
      try {
        const result = action()
        sql.exec('COMMIT')
        return result
      } catch (error) {
        sql.exec('ROLLBACK')
        throw error
      }
    },
    query: () => ({ tracks: [track(0)], versions: { t0: 1 }, total: 2, offset: 0, revision: 1 })
  })
  const build = selections.begin({ query: { contentRevision: 1 }, total: 2, ranges: [[0, 2]] })
  assert.throws(() => selections.advance(build), /incomplete/)
  assert.throws(() => selections.read(build.id), /not ready/)
  selections.close(build.id)
  selections.maintenance()
  assert.equal(selections.needsMaintenance, false)
})

async function workerFixture(t: test.TestContext, count = 1205) {
  const root = mkdtempSync(join(tmpdir(), 'library-selection-worker-')),
    json = join(root, 'music-library.json'),
    children: ChildProcess[] = []
  writeFileSync(json, JSON.stringify(Array.from({ length: count }, (_, i) => track(i))))
  const client = new LibraryDatabaseServiceClient({
    serviceEntry: fileURLToPath(new URL('./libraryDatabaseService.ts', import.meta.url)),
    libraryFilePath: json,
    fork: (entry) => {
      const child = fork(entry, [], {
        execArgv: ['--experimental-strip-types'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      })
      children.push(child)
      Object.assign(child, {
        postMessage: (message: LibraryDatabaseWorkerRequest) => child.send(message)
      })
      return child as unknown as DatabaseUtilityProcess
    }
  })
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await once(child, 'exit')
      }
    client.destroy()
    rmSync(root, { recursive: true, force: true })
  })
  const metadata = await client.getMetadata()
  return { client, children, metadata }
}

test('real worker selection construction yields to ordinary reads and keeps records out of its reply', async (t) => {
  const { client, metadata } = await workerFixture(t, 12_005),
    completions: string[] = []
  const freeze = client
    .createTrackSelection({
      query: { contentRevision: metadata.revision, sort: 'title' },
      total: 12_005,
      ranges: [[0, 12_005]]
    })
    .then((snapshot) => {
      completions.push('selection')
      return snapshot
    })
  const row = client.getTracksByIds(['t600']).then((page) => {
    completions.push('read')
    return page
  })
  await row
  const snapshot = await freeze
  assert.deepEqual(completions, ['read', 'selection'])
  assert.equal(snapshot.selectedCount, 12_005)
  assert.equal('tracks' in snapshot, false)
  assert.equal((await client.readTrackSelection(snapshot.id)).rows.length, 200)
  await client.closeTrackSelection(snapshot.id)
  await assert.rejects(client.readTrackSelection(snapshot.id), /expired/)
  assert.equal((await client.getMetadata()).revision, metadata.revision)
})

test('real worker abandons rather than replaying a partial snapshot after an interleaved mutation', async (t) => {
  const { client, metadata } = await workerFixture(t, 12_005),
    current = await client.getTracksByIds(['t1'])
  const freeze = client.createTrackSelection({
    query: { contentRevision: metadata.revision, sort: 'title' },
    total: 12_005,
    ranges: [[0, 12_005]]
  })
  const failed = assert.rejects(freeze, /发生变化/)
  await client.patchTracks([
    { id: 't1', expectedVersion: current.versions.t1, patch: { title: 'Changed' } }
  ])
  await failed
  const latest = await client.getMetadata()
  const snapshot = await client.createTrackSelection({
    query: { contentRevision: latest.revision, sort: 'title' },
    total: 12_005,
    ranges: [[0, 12_005]]
  })
  assert.equal(snapshot.selectedCount, 12_005)
  await client.closeTrackSelection(snapshot.id)
})

test('selection TEMP leases disappear on real worker restart while committed tracks remain unchanged', async (t) => {
  const { client, metadata, children } = await workerFixture(t)
  const snapshot = await client.createTrackSelection({
    query: { contentRevision: metadata.revision },
    total: 1205,
    ranges: [[0, 1205]]
  })
  const exit = once(children[0], 'exit')
  children[0].kill()
  await exit
  await assert.rejects(client.readTrackSelection(snapshot.id), /expired/)
  assert.equal((await client.getMetadata()).trackCount, 1205)
  assert.equal((await client.getMetadata()).revision, metadata.revision)
})
