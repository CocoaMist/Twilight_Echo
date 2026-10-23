import { LEGACY_QUEUE_SCHEMA_SQL } from './legacyQueueSchema.fixture.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { LibraryDatabase, LibraryDatabaseDurabilityError } from './libraryDatabase.ts'
import type {
  LibraryQueueEdit,
  LibraryQueueSnapshot,
  LibraryPlaylistViewSync
} from '../../shared/libraryDatabase.ts'
import {
  LIBRARY_QUEUE_BUILD_IDLE_MS,
  type LibraryQueueBuildCommand
} from '../../shared/libraryQueueBuild.ts'

function beginStream(db: LibraryDatabase, id: string, order: 'original' | 'shuffle' = 'original') {
  return db.buildLibraryQueue({
    kind: 'begin',
    id,
    order,
    contentRevision: db.getMetadata().revision
  })
}

test('private heart base restoration preserves frozen order, duplicates, snapshots and holes in one SQL transaction', (t) => {
  const f = fixture(t)
  f.edit({ kind: 'mode', mode: 'shuffle' })
  f.edit({
    kind: 'insert',
    items: [
      {
        id: 'ncm:9',
        snapshot: { id: 'ncm:9', source: 'ncm', ncmSongId: 9, filePath: 'https://audio.test/9' }
      }
    ]
  })
  f.db.sql.prepare('DELETE FROM tracks WHERE id=?').run('1')
  const before = f.page(),
    base = {
      id: f.queue.id,
      revision: f.queue.revision,
      index: f.queue.index,
      entryId: f.queue.selectedEntryId!
    }
  const restored = f.db.restoreHeartBaseQueue(base, '0')
  assert.equal(restored.matched, true)
  assert.equal(restored.queue.order, 'original')
  assert.equal(restored.queue.playMode, 'sequential')
  assert.deepEqual(f.db.readLibraryQueue(restored.queue.id).items, before.items)
  assert.deepEqual(f.db.getLibraryQueue(f.queue.id), f.queue)
  assert.throws(
    () => f.db.restoreHeartBaseQueue({ ...base, revision: base.revision - 1 }, '0'),
    /revision|changed/i
  )
  const count = f.db.sql.prepare('SELECT count(*) AS n FROM queues').get()!.n
  f.db.sql.exec(
    "CREATE TRIGGER fail_heart_copy BEFORE INSERT ON queue_snapshots BEGIN SELECT RAISE(ABORT,'heart copy failure'); END"
  )
  assert.throws(() => f.db.restoreHeartBaseQueue(base, 'outside'), /heart copy failure/)
  assert.equal(f.db.sql.prepare('SELECT count(*) AS n FROM queues').get()!.n, count)
})

test('seed-only local snapshots preserve temporary CUE/SACD/network occurrences without importing tracks or retaining transient URLs', (t) => {
  const { db } = fixture(t)
  const metadata = db.getMetadata()
  const snapshots = [
    {
      id: 'temporary',
      source: 'local',
      filePath: 'D:/Temporary/disc.flac',
      cueRange: { startSeconds: 90, endSeconds: 180, virtualPregapSeconds: 1 },
      cueSheetPath: 'D:/Temporary/disc.cue',
      cueEncoding: 'gb18030'
    },
    { id: 'sacd', source: 'local', filePath: 'D:/Temporary/disc.iso', subTrack: 'sacd://disc/2' },
    {
      id: 'network',
      source: 'local',
      filePath: '//server/Music/song.flac',
      networkSource: { id: 'share', path: '/song.flac' }
    }
  ]
  beginStream(db, 'temporary-seed')
  db.buildLibraryQueue({
    kind: 'append',
    id: 'temporary-seed',
    sequence: 1,
    items: snapshots.map((snapshot) => ({
      id: snapshot.id,
      localSnapshot: {
        ...snapshot,
        streamUrl: 'twilight-media://audio/transient',
        cover: null,
        coverSource: null,
        coverSmall: 'data:image/png;base64,omit',
        lyrics: 'omit',
        arbitrary: { large: true }
      }
    }))
  })
  const ready = db.buildLibraryQueue({
    kind: 'commit',
    id: 'temporary-seed',
    sequence: 2,
    selectedIndex: 1
  })
  assert.equal(ready.kind, 'ready')
  const rows = db.readLibraryQueue('temporary-seed').items
  for (let index = 0; index < rows.length; index++) {
    const record = rows[index].track!
    for (const [key, value] of Object.entries(snapshots[index]))
      assert.deepEqual(record[key], value)
    assert.equal(record.streamUrl, undefined)
    assert.equal(record.lyrics, null)
    assert.equal(record.arbitrary, undefined)
    assert.equal(record.coverSmall, undefined)
  }
  assert.deepEqual(db.getMetadata(), metadata)
  assert.equal(
    db.sql
      .prepare('SELECT count(*) AS n FROM tracks WHERE id IN (?,?,?)')
      .get('temporary', 'sacd', 'network')?.n,
    0
  )
  const queue = db.getLibraryQueue('temporary-seed')
  assert.throws(
    () =>
      db.editLibraryQueue(queue.id, queue.revision, {
        kind: 'insert',
        items: [{ id: snapshots[0].id, snapshot: snapshots[0] }]
      }),
    /snapshot/
  )
})

test('local seed validation rejects remote masquerades, conflicting snapshots, wrong identities and oversized payloads', (t) => {
  const { db } = fixture(t)
  const invalid = [
    { id: 'x', localSnapshot: { id: 'x', filePath: 'x', source: 'ncm' } },
    { id: 'x', localSnapshot: { id: 'x', filePath: 'x', source: 'playlist-import' } },
    { id: 'x', localSnapshot: { id: 'other', filePath: 'D:/x.flac', source: 'local' } },
    { id: 'x', localSnapshot: { id: 'x', filePath: 'D:/x\0.flac', source: 'local' } },
    {
      id: 'x',
      snapshot: { id: 'x', filePath: 'x', source: 'ncm' },
      localSnapshot: { id: 'x', filePath: 'D:/x.flac', source: 'local' }
    },
    {
      id: 'x',
      localSnapshot: {
        id: 'x',
        filePath: 'D:/x.flac',
        source: 'local',
        arbitrary: 'x'.repeat(512 * 1024)
      }
    }
  ]
  invalid.forEach((item, index) => {
    const id = `bad-local-${index}`
    beginStream(db, id)
    assert.throws(() => db.buildLibraryQueue({ kind: 'append', id, sequence: 1, items: [item] }))
    assert.throws(() => db.getLibraryQueue(id), /does not exist/)
    db.maintainQueryState()
  })
})

test('streamed hidden queues preserve independent occurrence orders, CUE and compact mixed snapshots atomically', (t) => {
  const { db } = fixture(t)
  db.patchTracks([
    {
      id: '0',
      expectedVersion: 1,
      patch: {
        cueRange: { startSeconds: 90, endSeconds: 180 },
        cueEncoding: 'gb18030',
        cueSheetPath: 'C:/Music/disc.cue'
      }
    }
  ])
  const metadata = db.getMetadata()
  assert.deepEqual(beginStream(db, 'stream-mixed', 'shuffle'), {
    kind: 'building',
    id: 'stream-mixed',
    sequence: 0,
    total: 0
  })
  const original = Array.from({ length: 605 }, (_, index) =>
    index % 7 === 0
      ? {
          id: 'ncm:7',
          snapshot: {
            id: 'ncm:7',
            filePath: 'ncm:7',
            source: 'ncm',
            title: 'Remote',
            artist: 'Artist',
            lyrics: 'large lyrics',
            analysis: { large: true },
            arbitrary: 'omit',
            streamUrl: 'https://expired.invalid/audio',
            cover: 'data:image/png;base64,not-persisted',
            coverSmall: 'blob:not-persisted'
          }
        }
      : { id: String(index % 5) }
  )
  const displayed = original.map((_, index) => {
    const originalPosition = (index + 200) % original.length
    return { ...original[originalPosition], originalPosition }
  })
  let sequence = 0
  for (let offset = 0; offset < displayed.length; offset += 200) {
    assert.deepEqual(
      db.buildLibraryQueue({
        kind: 'append',
        id: 'stream-mixed',
        sequence: ++sequence,
        items: displayed.slice(offset, offset + 200)
      }),
      {
        kind: 'building',
        id: 'stream-mixed',
        sequence,
        total: Math.min(offset + 200, displayed.length)
      }
    )
    assert.throws(() => db.getLibraryQueue('stream-mixed'), /does not exist/)
    assert.throws(() => db.readLibraryQueue('stream-mixed'), /does not exist/)
  }
  const ready = db.buildLibraryQueue({
    kind: 'commit',
    id: 'stream-mixed',
    sequence: ++sequence,
    selectedIndex: 0
  })
  assert.equal(ready.kind, 'ready')
  if (ready.kind !== 'ready') throw new Error('Expected published queue')
  assert.equal(ready.queue.total, 605)
  assert.equal(ready.queue.order, 'shuffle')
  assert.equal(ready.queue.index, 0)
  invariant(db, ready.queue)
  const rows = Array.from(
    { length: 4 },
    (_, index) => db.readLibraryQueue('stream-mixed', index * 200).items
  ).flat()
  assert.deepEqual(
    rows.map((row) => row.track?.id),
    displayed.map((item) => item.id)
  )
  assert.equal(new Set(rows.map((row) => row.queueEntryId)).size, 605)
  assert.deepEqual(rows[0].track?.cueRange, { startSeconds: 90, endSeconds: 180 })
  assert.equal(rows[0].track?.cueEncoding, 'gb18030')
  const remote = rows.find((row) => row.track?.source === 'ncm')!.track!
  assert.equal(remote.title, 'Remote')
  assert.equal(remote.streamUrl, undefined)
  assert.equal(remote.analysis, undefined)
  assert.equal(remote.arbitrary, undefined)
  assert.equal(remote.lyrics, null)
  assert.equal(remote.cover, undefined)
  assert.equal(remote.coverSmall, undefined)
  const restored = db.editLibraryQueue('stream-mixed', ready.queue.revision, {
    kind: 'order',
    order: 'original'
  }).queue
  assert.equal(restored.selectedEntryId, ready.queue.selectedEntryId)
  assert.equal(
    restored.index,
    200,
    'the selected duplicate occurrence follows its own original position'
  )
  assert.deepEqual(
    Array.from({ length: 4 }, (_, index) => db.readLibraryQueue('stream-mixed', index * 200).items)
      .flat()
      .map((row) => row.track?.id),
    original.map((item) => item.id)
  )
  assert.deepEqual(
    db.getMetadata(),
    metadata,
    'derived queue construction never edits library metadata'
  )
  assert.deepEqual(db.buildLibraryQueue({ kind: 'abort', id: 'stream-mixed' }), {
    kind: 'aborted',
    id: 'stream-mixed'
  })
  assert.deepEqual(
    db.getLibraryQueue('stream-mixed'),
    restored,
    'late abort cannot delete a published queue'
  )
})

test('empty streamed queues publish no phantom selection and a suffix needs no full order array', (t) => {
  const { db } = fixture(t)
  beginStream(db, 'empty-stream')
  const empty = db.buildLibraryQueue({
    kind: 'commit',
    id: 'empty-stream',
    sequence: 1,
    selectedIndex: -1
  })
  assert.equal(empty.kind, 'ready')
  if (empty.kind !== 'ready') throw new Error('Expected published queue')
  assert.equal(empty.queue.total, 0)
  assert.equal(empty.queue.index, -1)
  assert.equal(empty.queue.selectedEntryId, null)
  beginStream(db, 'suffix-stream')
  db.buildLibraryQueue({
    kind: 'append',
    id: 'suffix-stream',
    sequence: 1,
    items: [{ id: '1' }, { id: '1' }]
  })
  const ready = db.buildLibraryQueue({
    kind: 'commit',
    id: 'suffix-stream',
    sequence: 2,
    selectedIndex: 1
  })
  if (ready.kind !== 'ready') throw new Error('Expected published queue')
  invariant(db, ready.queue)
  assert.equal(ready.queue.index, 1)
})

test('invalid batches, missing local tracks and sequence replays abandon the entire unpublished stream', (t) => {
  const { db } = fixture(t)
  const invalid = [
    { kind: 'append', sequence: 1, items: Array(201).fill({ id: '1' }) },
    { kind: 'append', sequence: 1, items: [{ id: 'missing' }] },
    { kind: 'append', sequence: 1, items: [{ id: '1', originalPosition: -1 }] },
    { kind: 'append', sequence: 1, items: [{ id: '1', originalPosition: 0.5 }] },
    { kind: 'append', sequence: 1, items: [{ id: '1', originalPosition: 1_000_000 }] },
    {
      kind: 'append',
      sequence: 1,
      items: [
        { id: 'x', snapshot: { id: 'x', filePath: 'playlist-import:x', source: 'playlist-import' } }
      ]
    },
    { kind: 'append', sequence: 2, items: [{ id: '1' }] },
    { kind: 'commit', sequence: 1, selectedIndex: 0 },
    { kind: 'commit', sequence: 1, selectedIndex: 0.5 }
  ]
  invalid.forEach((request, index) => {
    const id = `invalid-stream-${index}`
    beginStream(db, id)
    assert.throws(() => db.buildLibraryQueue({ ...request, id } as LibraryQueueBuildCommand))
    assert.equal(db.sql.prepare('SELECT state FROM queues WHERE id=?').get(id)?.state, 'abandoned')
    assert.throws(() => db.getLibraryQueue(id), /does not exist/)
    assert.throws(
      () => db.buildLibraryQueue({ kind: 'append', id, sequence: 1, items: [{ id: '1' }] }),
      /expired/
    )
    db.maintainQueryState()
  })
  beginStream(db, 'no-replay')
  const first = { kind: 'append' as const, id: 'no-replay', sequence: 1, items: [{ id: '1' }] }
  db.buildLibraryQueue(first)
  assert.throws(() => db.buildLibraryQueue(first), /do not replay/)
  assert.equal(
    db.sql.prepare('SELECT count(*) AS n FROM queue_entries WHERE queue_id=?').get('no-replay')?.n,
    1
  )
  assert.throws(
    () => db.buildLibraryQueue({ kind: 'commit', id: 'no-replay', sequence: 2, selectedIndex: 0 }),
    /expired/
  )
})

test('duplicate begin preserves the live stream; incomplete or incompatible original orders never publish', (t) => {
  const { db } = fixture(t)
  const cases = [
    { id: 'duplicate-original', order: 'shuffle' as const, positions: [0, 0] },
    { id: 'gap-original', order: 'shuffle' as const, positions: [0, 2] },
    { id: 'not-original', order: 'original' as const, positions: [1, 0] }
  ]
  for (const { id, order, positions } of cases) {
    beginStream(db, id, order)
    assert.throws(() => beginStream(db, id, order), /already exists/)
    db.buildLibraryQueue({
      kind: 'append',
      id,
      sequence: 1,
      items: positions.map((originalPosition) => ({ id: '1', originalPosition }))
    })
    assert.throws(
      () => db.buildLibraryQueue({ kind: 'commit', id, sequence: 2, selectedIndex: 0 }),
      /Original queue order/
    )
    assert.throws(() => db.getLibraryQueue(id), /does not exist/)
    db.maintainQueryState()
  }
})

test('SQL faults roll back a whole streamed page and cleanup remains bounded at 200 occurrences', (t) => {
  const { db } = fixture(t)
  beginStream(db, 'fault-stream')
  db.buildLibraryQueue({
    kind: 'append',
    id: 'fault-stream',
    sequence: 1,
    items: Array(200).fill({ id: '1' })
  })
  db.sql.exec(`CREATE TEMP TRIGGER fail_stream_snapshot BEFORE INSERT ON queue_snapshots
    BEGIN SELECT RAISE(ABORT,'snapshot page fault'); END`)
  assert.throws(
    () =>
      db.buildLibraryQueue({
        kind: 'append',
        id: 'fault-stream',
        sequence: 2,
        items: [
          { id: '1' },
          { id: 'ncm:7', snapshot: { id: 'ncm:7', filePath: 'ncm:7', source: 'ncm' } }
        ]
      }),
    /snapshot page fault/
  )
  assert.equal(
    db.sql.prepare('SELECT count(*) AS n FROM queue_entries WHERE queue_id=?').get('fault-stream')
      ?.n,
    200
  )
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM queue_snapshots').get()?.n, 0)
  db.maintainQueryState()
  assert.equal(db.sql.prepare('SELECT 1 FROM queues WHERE id=?').get('fault-stream'), undefined)
})

test('a streamed publication fault rolls back readiness and keeps the previous live queue and cursor intact', (t) => {
  const { db, queue } = fixture(t)
  const previous = db.readLibraryQueue(queue.id)
  beginStream(db, 'failed-publication', 'shuffle')
  db.buildLibraryQueue({
    kind: 'append',
    id: 'failed-publication',
    sequence: 1,
    items: [
      { id: '1', originalPosition: 1 },
      { id: '0', originalPosition: 0 }
    ]
  })
  db.sql.exec(`CREATE TEMP TRIGGER fail_stream_publish BEFORE UPDATE OF state ON queues
    WHEN new.id='failed-publication' AND new.state='ready'
    BEGIN SELECT RAISE(ABORT,'stream publication fault'); END`)
  assert.throws(
    () =>
      db.buildLibraryQueue({
        kind: 'commit',
        id: 'failed-publication',
        sequence: 2,
        selectedIndex: 1
      }),
    /stream publication fault/
  )
  assert.equal(
    db.sql.prepare('SELECT state,ordering FROM queues WHERE id=?').get('failed-publication')?.state,
    'abandoned'
  )
  assert.equal(
    db.sql.prepare('SELECT ordering FROM queues WHERE id=?').get('failed-publication')?.ordering,
    'original',
    'the preceding ordering update rolled back too'
  )
  assert.throws(() => db.getLibraryQueue('failed-publication'), /does not exist/)
  assert.deepEqual(db.getLibraryQueue(queue.id), queue)
  assert.deepEqual(db.readLibraryQueue(queue.id), previous)
  db.maintainQueryState()
  assert.equal(
    db.sql.prepare('SELECT 1 FROM queues WHERE id=?').get('failed-publication'),
    undefined
  )
})

test('streaming and query builders share four slots including bounded retirement, and stale library versions reject publication', (t) => {
  const { db } = fixture(t)
  const queryBuild = db.beginLibraryQueueBuild({ ids: ['1'] })
  for (const id of ['stream-a', 'stream-b', 'stream-c']) beginStream(db, id)
  assert.throws(() => beginStream(db, 'stream-d'), /Too many queue builds/)
  db.buildLibraryQueue({
    kind: 'append',
    id: 'stream-a',
    sequence: 1,
    items: Array(200).fill({ id: '1' })
  })
  db.buildLibraryQueue({
    kind: 'append',
    id: 'stream-a',
    sequence: 2,
    items: Array(200).fill({ id: '1' })
  })
  db.buildLibraryQueue({ kind: 'abort', id: 'stream-a' })
  assert.throws(() => beginStream(db, 'stream-d'), /Too many queue builds/)
  db.maintainQueryState()
  assert.equal(
    db.sql.prepare('SELECT count(*) AS n FROM queue_entries WHERE queue_id=?').get('stream-a')?.n,
    200
  )
  assert.throws(() => beginStream(db, 'stream-d'), /Too many queue builds/)
  db.maintainQueryState()
  beginStream(db, 'stream-d')
  db.patchTracks([{ id: '1', expectedVersion: 1, patch: { title: 'Changed' } }])
  assert.throws(
    () =>
      db.buildLibraryQueue({ kind: 'append', id: 'stream-b', sequence: 1, items: [{ id: '1' }] }),
    /Library changed/
  )
  assert.throws(
    () => db.buildLibraryQueue({ kind: 'commit', id: 'stream-c', sequence: 1, selectedIndex: -1 }),
    /Library changed/
  )
  db.abandonLibraryQueueBuild(queryBuild)
})

test('stream inactivity expires at its deadline, refreshes only on successful pages, and never exposes a stale continuation', (t) => {
  const { db } = fixture(t)
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  beginStream(db, 'idle-stream')
  assert.equal(db.nextQueueBuildExpiry, now + LIBRARY_QUEUE_BUILD_IDLE_MS)
  now += 100
  db.buildLibraryQueue({ kind: 'append', id: 'idle-stream', sequence: 1, items: [{ id: '1' }] })
  const expiry = now + LIBRARY_QUEUE_BUILD_IDLE_MS
  assert.equal(db.nextQueueBuildExpiry, expiry)
  now = expiry
  assert.equal(db.needsQueryMaintenance, true)
  assert.throws(
    () =>
      db.buildLibraryQueue({ kind: 'commit', id: 'idle-stream', sequence: 2, selectedIndex: 0 }),
    /expired/
  )
  assert.equal(db.nextQueueBuildExpiry, undefined)
  db.maintainQueryState()
  assert.equal(db.sql.prepare('SELECT 1 FROM queues WHERE id=?').get('idle-stream'), undefined)
  assert.deepEqual(db.buildLibraryQueue({ kind: 'abort', id: 'idle-stream' }), {
    kind: 'aborted',
    id: 'idle-stream'
  })
})

function fixture(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: Array.from({ length: 5 }, (_, index) => ({
      id: String(index),
      filePath: `C:/Music/${index}.flac`,
      title: `Title ${index}`,
      extra: 'not-an-order-key'
    }))
  })
  let queue = db.createLibraryQueue({ ids: ['0', '1', '0', '2', '3'], sort: 'playlist' })
  return {
    db,
    get queue() {
      return queue
    },
    edit(edit: LibraryQueueEdit) {
      const result = db.editLibraryQueue(queue.id, queue.revision, edit)
      queue = result.queue
      return result
    },
    page: () => db.readLibraryQueue(queue.id),
    entry: (position: number) => db.readLibraryQueue(queue.id, position, 1).items[0].queueEntryId,
    ids: () => db.readLibraryQueue(queue.id).items.map((item) => item.track?.id)
  }
}
test('main-only navigation preview seeks across long holes, wraps exact duplicate occurrences and never moves the cursor', (t) => {
  const { db } = fixture(t)
  let queue = db.createLibraryQueue({
    ids: ['0', ...Array<string>(999).fill('1')],
    sort: 'playlist'
  })
  queue = db.editLibraryQueue(queue.id, queue.revision, {
    kind: 'insert',
    trackIds: Array<string>(1_000).fill('1')
  }).queue
  queue = db.editLibraryQueue(queue.id, queue.revision, {
    kind: 'insert',
    trackIds: ['1', '1', '1', '1', '0']
  }).queue
  db.sql.prepare('DELETE FROM tracks WHERE id=?').run('1')
  const first = { ...db.readLibraryQueue(queue.id, 0, 1).items[0], logicalQueueEnd: false }
  const last = { ...db.readLibraryQueue(queue.id, 2_004, 1).items[0], logicalQueueEnd: true }
  assert.deepEqual(db.readLibraryQueueNeighbor(queue.id, queue.revision, 0, 1, false), last)
  assert.deepEqual(db.readLibraryQueueNeighbor(queue.id, queue.revision, 2_004, -1, false), first)
  assert.deepEqual(db.readLibraryQueueNeighbor(queue.id, queue.revision, 2_004, 1, true), first)
  assert.deepEqual(db.readLibraryQueueNeighbor(queue.id, queue.revision, 0, -1, true), last)
  assert.equal(db.readLibraryQueueNeighbor(queue.id, queue.revision, 2_004, 1, false), null)
  assert.notEqual(first.queueEntryId, last.queueEntryId)
  assert.deepEqual(db.getLibraryQueue(queue.id), queue)
  const selected = db.editLibraryQueue(queue.id, queue.revision, {
    kind: 'select',
    entryId: last.queueEntryId
  }).queue
  assert.throws(
    () => db.readLibraryQueueNeighbor(queue.id, queue.revision, 0, 1, true),
    /变化|revision|changed/i
  )
  for (const index of [-1, 0.5, 2_005, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () => db.readLibraryQueueNeighbor(queue.id, selected.revision, index, 1, true),
      /Invalid/
    )
  assert.throws(
    () => db.readLibraryQueueNeighbor(queue.id, selected.revision, 0, 2 as 1, true),
    /Invalid/
  )
  assert.deepEqual(db.getLibraryQueue(queue.id), selected)
})

test('navigation preview uses persisted shuffled order and mixed snapshot availability', (t) => {
  const f = fixture(t)
  f.edit({
    kind: 'insert',
    items: [
      { id: 'ncm:7', snapshot: { id: 'ncm:7', source: 'ncm', filePath: 'ncm:7', title: 'Remote' } }
    ]
  })
  f.edit({ kind: 'order', order: 'shuffle' })
  const rows = f.page().items
  for (let index = 0; index < rows.length; index++) {
    assert.deepEqual(f.db.readLibraryQueueNeighbor(f.queue.id, f.queue.revision, index, 1, true), {
      ...rows[(index + 1) % rows.length],
      logicalQueueEnd: (index + 1) % rows.length === rows.length - 1
    })
    assert.deepEqual(f.db.readLibraryQueueNeighbor(f.queue.id, f.queue.revision, index, -1, true), {
      ...rows[(index + rows.length - 1) % rows.length],
      logicalQueueEnd: (index + rows.length - 1) % rows.length === rows.length - 1
    })
  }
  assert.deepEqual(f.db.getLibraryQueue(f.queue.id), f.queue)
})

function invariant(db: LibraryDatabase, queue: LibraryQueueSnapshot) {
  const rows = db.sql
    .prepare(
      'SELECT position,original_position FROM queue_entries WHERE queue_id=? ORDER BY position'
    )
    .all(queue.id)
  assert.equal(rows.length, queue.total)
  assert.deepEqual(
    rows.map((row) => row.position),
    rows.map((_, index) => index)
  )
  assert.deepEqual(
    rows.map((row) => Number(row.original_position)).sort((a, b) => a - b),
    rows.map((_, index) => index)
  )
  if (!queue.total) assert.equal(queue.index, -1)
  else
    assert.equal(
      db.readLibraryQueue(queue.id, queue.index, 1).items[0].queueEntryId,
      queue.selectedEntryId
    )
}

function mixedView(db: LibraryDatabase, count = 605, id = 'mixed') {
  db.syncPlaylistView({ kind: 'begin', id, versions: [], preserveSources: true })
  let sequence = 0
  for (let offset = 0; offset < count; offset += 200) {
    const entries: Extract<LibraryPlaylistViewSync, { kind: 'append' }>['entries'] = Array.from(
      { length: Math.min(200, count - offset) },
      (_, i) =>
        (offset + i) % 3 === 0
          ? {
              id: 'ncm:7',
              snapshot: {
                id: 'ncm:7',
                filePath: '',
                title: 'Remote',
                artist: 'Artist',
                source: 'ncm',
                streamUrl: 'https://expired'
              }
            }
          : { id: String((offset + i) % 5) }
    )
    db.syncPlaylistView({ kind: 'append', id, sequence: ++sequence, entries })
  }
  db.syncPlaylistView({ kind: 'commit', id, sequence: ++sequence })
  const query = { playlistView: id, sort: 'playlist' as const }
  assert.equal(db.queryTracks(query).total, count)
  return query
}

test('portable playback export preserves duplicates, holes and CUE data within the original capacity', (t) => {
  const f = fixture(t)
  f.db.patchTracks([
    {
      id: '0',
      expectedVersion: 1,
      patch: {
        cueRange: { startSeconds: 1, endSeconds: 60 },
        lyrics: 'not-in-queue',
        cookie: 'never-export',
        streamUrl: 'https://private/',
        cover: 'data:image/png;base64,AAAA'
      }
    }
  ])
  f.edit({ kind: 'select', entryId: f.entry(2) })
  const reference = { id: f.queue.id, revision: f.queue.revision, entryId: f.entry(2), index: 2 }
  f.db.sql.prepare('DELETE FROM tracks WHERE id=?').run('1')
  const exported = f.db.exportPlaybackQueue(reference, 32 * 1024 * 1024 - 1024)
  assert.equal(exported.queue.length, 5)
  assert.equal(exported.queueIndex, 2)
  assert.notEqual(exported.queue[0].queueEntryId, exported.queue[2].queueEntryId)
  assert.deepEqual(exported.queue[2].cueRange, { startSeconds: 1, endSeconds: 60 })
  assert.equal(exported.queue[2].lyrics, undefined)
  assert.equal(exported.queue[2].cookie, undefined)
  assert.equal(exported.queue[2].streamUrl, undefined)
  assert.equal(exported.queue[2].cover, null)
  assert.equal(exported.queue[1].id, '1')
  assert.equal(exported.queue[1].filePath, '')
  const bytes = Buffer.byteLength(JSON.stringify(exported.queue))
  assert.equal(f.db.exportPlaybackQueue(reference, bytes).queue.length, 5)
  assert.throws(() => f.db.exportPlaybackQueue(reference, bytes - 1), /未截断/)
  assert.deepEqual(f.db.getLibraryQueue(f.queue.id), f.queue)
  f.edit({ kind: 'move', entryId: f.entry(2), beforeEntryId: f.entry(0) })
  assert.throws(() => f.db.exportPlaybackQueue(reference, bytes), /播放队列已变化/)
})

test('duplicate occurrences retain distinct identities through select, insert, move and remove', (t) => {
  const f = fixture(t),
    first = f.entry(0),
    duplicate = f.entry(2)
  assert.notEqual(first, duplicate)
  f.edit({ kind: 'select', entryId: duplicate })
  f.edit({ kind: 'insert', afterEntryId: duplicate, trackIds: ['4', '4'] })
  assert.deepEqual(f.ids(), ['0', '1', '0', '4', '4', '2', '3'])
  assert.equal(f.queue.selectedEntryId, duplicate)
  f.edit({ kind: 'move', entryId: duplicate, beforeEntryId: first })
  assert.equal(f.entry(0), duplicate)
  assert.equal(f.queue.index, 0)
  f.edit({ kind: 'remove', entryIds: [first] })
  assert.equal(f.queue.selectedEntryId, duplicate)
  assert.deepEqual(f.ids(), ['0', '1', '4', '4', '2', '3'])
  invariant(f.db, f.queue)
})

test('SQLite queue history reverses insert, remove, move, order and clear with a revision fence', (t) => {
  const run = (apply: (f: ReturnType<typeof fixture>) => LibraryQueueEdit) => {
    const f = fixture(t)
    const before = f.ids()
    f.edit(apply(f))
    const changed = f.queue
    const undone = f.db.editLibraryQueue(changed.id, changed.revision, { kind: 'undo' })
    assert.deepEqual(
      f.db.readLibraryQueue(undone.queue.id).items.map((item) => item.track?.id),
      before
    )
    invariant(f.db, undone.queue)
  }
  run((f) => ({ kind: 'insert', afterEntryId: f.entry(1), trackIds: ['4'] }))
  run((f) => ({ kind: 'remove', entryIds: [f.entry(1)] }))
  run((f) => ({ kind: 'move', entryId: f.entry(1), beforeEntryId: f.entry(4) }))
  run(() => ({ kind: 'order', order: 'shuffle' }))
  run(() => ({ kind: 'clear' }))
  const f = fixture(t)
  const first = f.queue
  f.edit({ kind: 'insert', trackIds: ['4'] })
  assert.throws(
    () => f.db.editLibraryQueue(f.queue.id, first.revision, { kind: 'undo' }),
    /concurrently/
  )
})

test('repeated queue undo rebases only adjacent history and never revives pre-navigation operations', (t) => {
  const f = fixture(t)
  f.edit({ kind: 'insert', trackIds: ['4'] })
  f.edit({ kind: 'insert', trackIds: ['3'] })
  f.edit({ kind: 'insert', trackIds: ['2'] })
  for (const total of [7, 6, 5]) {
    f.edit({ kind: 'undo' })
    assert.equal(f.queue.total, total)
    invariant(f.db, f.queue)
  }
  assert.throws(() => f.edit({ kind: 'undo' }), /没有可撤销/)
  f.edit({ kind: 'insert', trackIds: ['4'] })
  f.edit({ kind: 'step', direction: 1, wrap: false })
  f.edit({ kind: 'insert', trackIds: ['3'] })
  f.edit({ kind: 'undo' })
  assert.throws(() => f.edit({ kind: 'undo' }), /没有可撤销/)
  assert.equal(f.queue.total, 6)
})

test('undo restores multiple separated removals in both orders without colliding with survivors', (t) => {
  const f = fixture(t)
  for (const shuffled of [false, true]) {
    if (shuffled) f.edit({ kind: 'order', order: 'shuffle' })
    const before = f.db.sql
      .prepare('SELECT * FROM queue_entries WHERE queue_id=? ORDER BY position')
      .all(f.queue.id)
    const selected = f.queue.selectedEntryId
    f.edit({ kind: 'remove', entryIds: [f.entry(1), f.entry(3)] })
    f.edit({ kind: 'undo' })
    assert.deepEqual(
      f.db.sql
        .prepare('SELECT * FROM queue_entries WHERE queue_id=? ORDER BY position')
        .all(f.queue.id),
      before
    )
    assert.equal(f.queue.selectedEntryId, selected)
    invariant(f.db, f.queue)
  }
})

test('adjacent move and undo update only the two affected occurrences in each order', (t) => {
  const f = fixture(t),
    source = f.entry(3),
    target = f.entry(2),
    before = f.page().items
  f.db.sql.exec(`CREATE TEMP TABLE edited_occurrences(entry_id TEXT);
    CREATE TEMP TRIGGER track_queue_edits AFTER UPDATE OF position,original_position ON queue_entries
    BEGIN INSERT INTO edited_occurrences VALUES(new.entry_id); END;`)
  for (const change of [
    { kind: 'move', entryId: source, beforeEntryId: target },
    { kind: 'undo' }
  ] as const) {
    f.db.sql.exec('DELETE FROM edited_occurrences')
    f.edit(change)
    assert.deepEqual(
      new Set(
        f.db.sql
          .prepare('SELECT entry_id FROM edited_occurrences')
          .all()
          .map((r) => r.entry_id)
      ),
      new Set([source, target])
    )
    invariant(f.db, f.queue)
  }
  assert.deepEqual(f.page().items, before)
})

test('tail removal and undo do not rewrite the untouched queue prefix', (t) => {
  const f = fixture(t),
    last = f.entry(4),
    before = f.page().items
  f.db.sql.exec(`CREATE TEMP TRIGGER protect_unchanged_prefix
    BEFORE UPDATE OF position,original_position ON queue_entries
    WHEN old.position>=0 AND old.position<4
    BEGIN SELECT RAISE(ABORT,'unchanged queue prefix was rewritten'); END;`)
  f.edit({ kind: 'remove', entryIds: [last] })
  f.edit({ kind: 'undo' })
  assert.deepEqual(f.page().items, before)
  invariant(f.db, f.queue)
})

test('removal undo handles consecutive gaps, the entire queue and repeated remote snapshots', (t) => {
  for (const shuffled of [false, true]) {
    for (const positions of [
      [0, 1],
      [1, 2, 3],
      [0, 2, 4, 6],
      [4, 5, 6],
      [0, 1, 2, 3, 4, 5, 6]
    ]) {
      const f = fixture(t)
      f.edit({
        kind: 'insert',
        items: Array.from({ length: 2 }, (_, i) => ({
          id: 'ncm:7',
          snapshot: { id: 'ncm:7', filePath: 'ncm:7', source: 'ncm', title: `Snapshot ${i}` }
        }))
      })
      if (shuffled) f.edit({ kind: 'order', order: 'shuffle' })
      const before = f.page().items,
        original = f.db.sql
          .prepare('SELECT * FROM queue_entries WHERE queue_id=? ORDER BY original_position')
          .all(f.queue.id)
      f.edit({
        kind: 'remove',
        entryIds: positions.map((position) => before[position].queueEntryId)
      })
      invariant(f.db, f.queue)
      f.edit({ kind: 'undo' })
      assert.deepEqual(f.page().items, before)
      assert.deepEqual(
        f.db.sql
          .prepare('SELECT * FROM queue_entries WHERE queue_id=? ORDER BY original_position')
          .all(f.queue.id),
        original
      )
      invariant(f.db, f.queue)
    }
  }
})

test('local moves apply the same occurrence anchor to independent shuffled and original orders', (t) => {
  for (const [from, before] of [
    [0, 3],
    [3, 0],
    [1, 4],
    [4, 1],
    [1, null]
  ] as const) {
    const f = fixture(t)
    f.edit({ kind: 'order', order: 'shuffle' })
    const rows = () =>
      f.db.sql
        .prepare('SELECT * FROM queue_entries WHERE queue_id=? ORDER BY position')
        .all(f.queue.id)
    const previous = rows(),
      source = String(previous[from].entry_id),
      anchor = before === null ? null : String(previous[before].entry_id),
      selected = f.queue.selectedEntryId
    f.edit({ kind: 'move', entryId: source, beforeEntryId: anchor })
    for (const column of ['position', 'original_position'] as const) {
      const expected = previous
        .slice()
        .sort((a, b) => Number(a[column]) - Number(b[column]))
        .map((r) => r.entry_id)
      expected.splice(expected.indexOf(source), 1)
      expected.splice(anchor === null ? expected.length : expected.indexOf(anchor), 0, source)
      assert.deepEqual(
        rows()
          .sort((a, b) => Number(a[column]) - Number(b[column]))
          .map((r) => r.entry_id),
        expected
      )
    }
    assert.equal(f.queue.selectedEntryId, selected)
    invariant(f.db, f.queue)
    f.edit({ kind: 'undo' })
    assert.deepEqual(rows(), previous)
    invariant(f.db, f.queue)
  }
})

test('a failed second-order local move rolls back positions, cursor and history together', (t) => {
  const f = fixture(t),
    before = f.page(),
    snapshot = f.queue,
    source = f.entry(3),
    target = f.entry(2)
  f.db.sql.exec(`CREATE TEMP TRIGGER reject_original_move
    BEFORE UPDATE OF original_position ON queue_entries
    BEGIN SELECT RAISE(ABORT,'injected original-order failure'); END;`)
  assert.throws(() => f.edit({ kind: 'move', entryId: source, beforeEntryId: target }), /injected/)
  assert.deepEqual(f.db.getLibraryQueue(snapshot.id), snapshot)
  assert.deepEqual(f.page(), before)
  assert.equal(f.db.sql.prepare('SELECT count(*) AS n FROM queue_history').get()!.n, 0)
  assert.equal(f.db.sql.isTransaction, false)
  f.db.sql.exec('DROP TRIGGER reject_original_move')
  f.edit({ kind: 'move', entryId: source, beforeEntryId: target })
  invariant(f.db, f.queue)
})

test('durable removal undo works as the first edit after opening a database backup', async (t) => {
  const f = fixture(t),
    before = f.page().items,
    root = mkdtempSync(join(tmpdir(), 'queue-undo-reopen-')),
    file = join(root, 'library.sqlite')
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(root.includes('queue-undo-reopen-'))
    rmSync(root, { recursive: true, force: true })
  })
  f.edit({ kind: 'remove', entryIds: [f.entry(1), f.entry(3)] })
  await f.db.backupTo(file)
  const reopened = new LibraryDatabase(file)
  try {
    const result = reopened.editLibraryQueue(f.queue.id, f.queue.revision, { kind: 'undo' })
    assert.deepEqual(reopened.readLibraryQueue(f.queue.id).items, before)
    invariant(reopened, result.queue)
  } finally {
    reopened.close()
  }
})

test('mixed queue insertion keeps remote snapshots per occurrence and edits them normally', (t) => {
  const f = fixture(t)
  const remote = {
    id: 'ncm:77',
    filePath: 'ncm:77',
    fileName: 'Remote 77',
    title: 'Remote 77',
    artist: 'Remote Artist',
    album: 'Remote Album',
    duration: 187,
    cover: null,
    coverSource: null,
    streamUrl: null,
    source: 'ncm'
  }
  f.edit({
    kind: 'insert',
    items: [{ id: 'ncm:77', snapshot: remote }, { id: '0' }, { id: 'ncm:77', snapshot: remote }],
    afterEntryId: f.entry(1)
  })
  const page = f.page()
  assert.deepEqual(
    page.items.map((item) => item.track?.id),
    ['0', '1', 'ncm:77', '0', 'ncm:77', '0', '2', '3']
  )
  const remoteRows = page.items.filter((item) => item.track?.id === 'ncm:77')
  assert.equal(remoteRows.length, 2)
  assert.notEqual(remoteRows[0].queueEntryId, remoteRows[1].queueEntryId)
  assert.deepEqual(
    remoteRows.map((item) => item.track?.title),
    ['Remote 77', 'Remote 77']
  )
  f.edit({ kind: 'remove', entryIds: [remoteRows[0].queueEntryId] })
  assert.deepEqual(
    f.page().items.map((item) => item.track?.id),
    ['0', '1', '0', 'ncm:77', '0', '2', '3']
  )
  invariant(f.db, f.queue)
})

test('mixed queue insertion rejects local snapshots, mismatched identities and oversized payloads', (t) => {
  const f = fixture(t)
  assert.throws(
    () =>
      f.edit({
        kind: 'insert',
        items: [
          {
            id: '0',
            snapshot: { id: '0', filePath: 'C:/Music/0.flac', source: 'local' }
          }
        ]
      }),
    /Invalid remote library queue snapshot/
  )
  assert.throws(
    () =>
      f.edit({
        kind: 'insert',
        items: [
          {
            id: 'ncm:9',
            snapshot: { id: 'ncm:8', filePath: 'ncm:8', source: 'ncm' }
          }
        ]
      }),
    /Invalid remote library queue snapshot/
  )
  assert.throws(
    () =>
      f.edit({
        kind: 'insert',
        items: [
          {
            id: 'ncm:9',
            snapshot: {
              id: 'ncm:9',
              filePath: 'ncm:9',
              source: 'ncm',
              title: 'x'.repeat(600_000)
            }
          }
        ]
      }),
    /Invalid remote library queue snapshot|too large/
  )
})

test('shuffle preserves every occurrence, pins selection, and restores the edited original order', (t) => {
  const f = fixture(t),
    selected = f.entry(2)
  const originalEntries = f.page().items.map((item) => item.queueEntryId)
  f.edit({ kind: 'select', entryId: selected })
  f.edit({ kind: 'order', order: 'shuffle' })
  assert.equal(f.queue.index, 0)
  assert.equal(f.entry(0), selected)
  assert.deepEqual(
    new Set(f.page().items.map((item) => item.queueEntryId)),
    new Set(originalEntries)
  )
  f.edit({ kind: 'insert', afterEntryId: selected, trackIds: ['4'] })
  const addition = f.entry(1)
  f.edit({ kind: 'remove', entryIds: [originalEntries[1]] })
  f.edit({ kind: 'order', order: 'original' })
  assert.deepEqual(
    f.page().items.map((item) => item.queueEntryId),
    [originalEntries[0], selected, addition, originalEntries[3], originalEntries[4]]
  )
  invariant(f.db, f.queue)
})

test('all move directions use stable anchors without primary key collisions', (t) => {
  const f = fixture(t)
  const first = f.entry(0),
    last = f.entry(4)
  f.edit({ kind: 'move', entryId: first, beforeEntryId: null })
  assert.deepEqual(f.ids(), ['1', '0', '2', '3', '0'])
  f.edit({ kind: 'move', entryId: last, beforeEntryId: f.entry(0) })
  assert.deepEqual(f.ids(), ['3', '1', '0', '2', '0'])
  const revision = f.queue.revision
  f.edit({ kind: 'move', entryId: last, beforeEntryId: last })
  f.edit({ kind: 'move', entryId: last, beforeEntryId: f.entry(1) })
  assert.equal(f.queue.revision, revision)
  invariant(f.db, f.queue)
})

test('removing the selection chooses the next occurrence, then the preceding tail, then empty', (t) => {
  const f = fixture(t)
  f.edit({ kind: 'select', entryId: f.entry(2) })
  const next = f.entry(3)
  f.edit({ kind: 'remove', entryIds: [f.entry(2)] })
  assert.equal(f.queue.selectedEntryId, next)
  f.edit({ kind: 'select', entryId: f.entry(3) })
  f.edit({ kind: 'remove', entryIds: [f.entry(3)] })
  assert.equal(f.queue.selectedEntryId, next)
  f.edit({ kind: 'clear' })
  assert.equal(f.queue.selectedEntryId, null)
  invariant(f.db, f.queue)
  f.edit({ kind: 'insert', trackIds: ['4'] })
  assert.equal(f.queue.index, 0)
  invariant(f.db, f.queue)
})

test('navigation skips missing tracks without deleting frozen occurrences, and only wraps on request', (t) => {
  const f = fixture(t),
    before = f.page()
  f.db.sql.prepare("DELETE FROM tracks WHERE id='1'").run()
  f.edit({ kind: 'step', direction: 1, wrap: false })
  assert.equal(f.queue.selectedEntryId, before.items[2].queueEntryId)
  assert.equal(f.queue.index, 2)
  f.edit({ kind: 'select', entryId: f.entry(4) })
  const revision = f.queue.revision
  assert.equal(f.edit({ kind: 'step', direction: 1, wrap: false }).reachedEnd, true)
  assert.equal(f.queue.revision, revision)
  f.edit({ kind: 'step', direction: 1, wrap: true })
  assert.equal(f.queue.index, 0)
  f.edit({ kind: 'step', direction: -1, wrap: true })
  assert.equal(f.queue.index, 4)
  assert.equal(f.page().items[1].track, null)
  assert.equal(f.page().total, 5)
  f.db.sql.exec('DELETE FROM tracks')
  assert.equal(f.edit({ kind: 'step', direction: 1, wrap: true }).reachedEnd, true)
})

test('stale edits and foreign occurrence IDs cannot mutate a queue or dispose another queue', (t) => {
  const f = fixture(t),
    revision = f.queue.revision
  f.edit({ kind: 'select', entryId: f.entry(1) })
  assert.throws(
    () => f.db.editLibraryQueue(f.queue.id, revision, { kind: 'clear' }),
    { code: 'STALE_REVISION', message: 'Library queue changed concurrently' }
  )
  assert.throws(
    () => f.db.readLibraryQueue(f.queue.id, 0, 1, { expectedRevision: revision }),
    { code: 'STALE_REVISION', message: 'Library queue changed concurrently' }
  )
  assert.throws(() => f.db.deleteLibraryQueue(f.queue.id, revision), { code: 'STALE_REVISION' })
  const other = f.db.createLibraryQueue({ ids: ['4'] }),
    foreign = f.db.readLibraryQueue(other.id).items[0].queueEntryId
  const before = f.page()
  for (const edit of [
    { kind: 'select', entryId: foreign },
    { kind: 'move', entryId: f.entry(0), beforeEntryId: foreign },
    { kind: 'insert', afterEntryId: foreign, trackIds: ['4'] },
    { kind: 'remove', entryIds: [f.entry(0), foreign] }
  ] as LibraryQueueEdit[])
    assert.throws(() => f.edit(edit), /does not exist/)
  assert.deepEqual(f.page(), before)
  f.db.deleteLibraryQueue(other.id, other.revision)
  assert.throws(() => f.db.getLibraryQueue(other.id), /does not exist/)
  assert.equal(
    f.db.sql.prepare('SELECT count(*) AS n FROM queue_entries WHERE queue_id=?').get(other.id)?.n,
    0
  )
})

test('malformed edits and missing additions roll back without changing positions or versions', (t) => {
  const f = fixture(t),
    before = f.page()
  for (const value of [
    null,
    { kind: 'nope' },
    { kind: 'step', direction: 0, wrap: true },
    { kind: 'step', direction: 1, wrap: 'yes' },
    { kind: 'insert', trackIds: ['missing'] },
    { kind: 'insert', trackIds: Array(1001).fill('0') },
    { kind: 'remove', entryIds: [null] },
    { kind: 'order', order: 'random' }
  ]) {
    assert.throws(() => f.edit(value as LibraryQueueEdit))
    assert.deepEqual(f.page(), before)
  }
  // A failure after SQL has staged disjoint positions must roll everything back.
  f.db.sql.exec(
    "CREATE TRIGGER force_queue_failure BEFORE INSERT ON queue_entries BEGIN SELECT RAISE(ABORT,'queue disk fault'); END"
  )
  assert.throws(
    () => f.edit({ kind: 'insert', trackIds: ['4'], beforeEntryId: f.entry(1) }),
    /queue disk fault/
  )
  assert.deepEqual(f.page(), before)
  invariant(f.db, f.queue)
})

test('deep queue windows seek by indexed position and never hydrate the entire queue', (t) => {
  const f = fixture(t)
  f.db.sql.exec('BEGIN; DELETE FROM queue_entries;')
  f.db.sql
    .prepare(
      `WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<299999)
    INSERT INTO queue_entries(queue_id,position,entry_id,track_id,original_position) SELECT ?,x,'entry-'||x,'0',x FROM n`
    )
    .run(f.queue.id)
  f.db.sql
    .prepare('UPDATE queues SET total_count=300000,selected_entry=? WHERE id=?')
    .run('entry-299800', f.queue.id)
  f.db.sql.exec('COMMIT')
  const page = f.db.readLibraryQueue(f.queue.id, 299_800)
  assert.equal(page.items.length, 200)
  assert.equal(page.items[0].position, 299_800)
  assert.equal(f.db.getLibraryQueue(f.queue.id).index, 299_800)
  const plan = f.db.sql
    .prepare(
      'EXPLAIN QUERY PLAN SELECT entry_id FROM queue_entries WHERE queue_id=? AND position>=? ORDER BY position LIMIT 200'
    )
    .all(f.queue.id, 299800)
  assert.match(plan.map((row) => row.detail).join(' '), /SEARCH.*position>/)
  assert.throws(() => f.db.readLibraryQueue(f.queue.id, 0, 1001), /Invalid library page/)
})

const legacyQueueSchema = `DROP TABLE queue_snapshots; DROP INDEX queues_state; ALTER TABLE queues DROP COLUMN state; ALTER TABLE queues DROP COLUMN play_mode; DROP INDEX queue_entries_original; ALTER TABLE queue_entries DROP COLUMN original_position;
  DROP INDEX tracks_recording; DROP INDEX tracks_playlist_path; DROP INDEX tracks_playlist_suffix;
  ALTER TABLE tracks DROP COLUMN playlist_path; ALTER TABLE tracks DROP COLUMN playlist_path_reverse;
  ALTER TABLE queues DROP COLUMN selected_entry; ALTER TABLE queues DROP COLUMN ordering;
  ALTER TABLE queues DROP COLUMN total_count; DROP INDEX scan_checkpoint_cleanup; ALTER TABLE scan_jobs DROP COLUMN checked_files; ALTER TABLE scan_jobs DROP COLUMN checkpoints_reclaimed; PRAGMA user_version=2;`

test('logical modes atomically bind order and occurrence, with CAS for mode-only changes and legacy order compatibility', () => {
  const db = new LibraryDatabase(':memory:')
  try {
    db.replaceDocument({
      version: 2,
      revision: 0,
      folders: [],
      exclusions: [],
      tracks: [{ id: 'same', filePath: 'D:/Music/same.flac' }]
    })
    let queue = db.createLibraryQueue({ ids: ['same', 'same', 'same'], sort: 'playlist' })
    const original = db.readLibraryQueue(queue.id).items
    queue = db.editLibraryQueue(queue.id, queue.revision, {
      kind: 'select',
      entryId: original[2].queueEntryId
    }).queue
    for (const mode of ['listLoop', 'repeat', 'shuffle', 'sequential'] as const) {
      const before = queue
      queue = db.editLibraryQueue(queue.id, queue.revision, { kind: 'mode', mode }).queue
      assert.equal(queue.playMode, mode)
      assert.equal(queue.order, mode === 'shuffle' ? 'shuffle' : 'original')
      assert.equal(queue.index, mode === 'shuffle' ? 0 : 2)
      assert.equal(queue.selectedEntryId, original[2].queueEntryId)
      assert.equal(queue.revision, before.revision + 1)
      assert.deepEqual(
        db.editLibraryQueue(queue.id, queue.revision, { kind: 'mode', mode }).queue,
        queue
      )
      assert.throws(
        () => db.editLibraryQueue(queue.id, before.revision, { kind: 'mode', mode }),
        /concurrently/
      )
    }
    assert.deepEqual(db.readLibraryQueue(queue.id).items, original)
    queue = db.editLibraryQueue(queue.id, queue.revision, { kind: 'order', order: 'shuffle' }).queue
    assert.equal(queue.playMode, 'shuffle')
    queue = db.editLibraryQueue(queue.id, queue.revision, { kind: 'undo' }).queue
    assert.equal(queue.playMode, 'sequential')
    assert.deepEqual(db.readLibraryQueue(queue.id).items, original)
    queue = db.editLibraryQueue(queue.id, queue.revision, { kind: 'order', order: 'shuffle' }).queue
    queue = db.editLibraryQueue(queue.id, queue.revision, {
      kind: 'order',
      order: 'original'
    }).queue
    assert.equal(queue.playMode, 'sequential')
  } finally {
    db.close()
  }
})

test('failed mode/order commits roll back metadata, both orders, cursor, history and revision together', () => {
  const db = new LibraryDatabase(':memory:')
  try {
    db.replaceDocument({
      version: 2,
      revision: 0,
      folders: [],
      exclusions: [],
      tracks: [{ id: 'same', filePath: 'D:/Music/same.flac' }]
    })
    let queue = db.createLibraryQueue({ ids: Array(605).fill('same'), sort: 'playlist' })
    queue = db.editLibraryQueue(queue.id, queue.revision, { kind: 'mode', mode: 'repeat' }).queue
    const rows = db.readLibraryQueue(queue.id, 0, 1000)
    db.sql.exec(
      "CREATE TEMP TRIGGER reject_mode_order BEFORE UPDATE OF ordering ON queues BEGIN SELECT RAISE(ABORT,'mode order disk fault'); END;"
    )
    assert.throws(
      () => db.editLibraryQueue(queue.id, queue.revision, { kind: 'mode', mode: 'shuffle' }),
      /disk fault/
    )
    assert.deepEqual(db.getLibraryQueue(queue.id), queue)
    assert.deepEqual(db.readLibraryQueue(queue.id, 0, 1000), rows)
    assert.equal(db.sql.prepare('SELECT count(*) AS n FROM queue_history').get()?.n, 0)
    assert.equal(db.sql.isTransaction, false)
    assert.equal(db.sql.prepare('PRAGMA synchronous').get()?.synchronous, 2)
    for (const edit of [
      { kind: 'mode', mode: 'heart' },
      { kind: 'mode', mode: 'invalid' },
      { kind: 'mode', mode: 'repeat', order: 'shuffle' }
    ])
      assert.throws(
        () => db.editLibraryQueue(queue.id, queue.revision, edit as never),
        /Invalid.*mode/
      )
  } finally {
    db.close()
  }
})

test('v8 mode migration snapshots WAL and leaves legacy order unbound; backup/DDL failure cannot publish v11', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'queue-mode-upgrade-')),
    path = join(root, 'library.sqlite')
  const old = new LibraryDatabase(path)
  t.after(() => {
    old.close()
    rmSync(root, { recursive: true, force: true })
  })
  old.replaceDocument({
    version: 2,
    revision: 17,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'cue',
        filePath: join(root, 'disc.flac'),
        cueRange: { startSeconds: 90, endSeconds: 180 }
      }
    ]
  })
  let queue = old.createLibraryQueue({ ids: ['cue', 'cue', 'cue'], sort: 'playlist' })
  const selected = old.readLibraryQueue(queue.id).items[2].queueEntryId
  queue = old.editLibraryQueue(queue.id, queue.revision, {
    kind: 'select',
    entryId: selected
  }).queue
  queue = old.editLibraryQueue(queue.id, queue.revision, { kind: 'order', order: 'shuffle' }).queue
  old.syncLibraryQueueReferences('session', [queue.id])
  const page = old.readLibraryQueue(queue.id)
  old.sql.exec(
    LEGACY_QUEUE_SCHEMA_SQL +
      'ALTER TABLE queues DROP COLUMN play_mode; DROP INDEX scan_checkpoint_cleanup; ALTER TABLE scan_jobs DROP COLUMN checked_files; ALTER TABLE scan_jobs DROP COLUMN checkpoints_reclaimed; PRAGMA user_version=8;'
  )
  const prepare = DatabaseSync.prototype.prepare
  const backupFailure = t.mock.method(
    DatabaseSync.prototype,
    'prepare',
    function (this: DatabaseSync, sql: string) {
      if (sql === 'VACUUM INTO ?') throw new Error('mode backup full')
      return prepare.call(this, sql)
    }
  )
  assert.throws(() => new LibraryDatabase(path), /backup full/)
  assert.equal(old.sql.prepare('PRAGMA user_version').get()?.user_version, 8)
  backupFailure.mock.restore()
  const exec = DatabaseSync.prototype.exec
  const ddlFailure = t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('ALTER TABLE queues ADD COLUMN play_mode')) {
        exec.call(this, 'ALTER TABLE queues ADD COLUMN play_mode TEXT')
        throw new Error('mode DDL fault')
      }
      return exec.call(this, sql)
    }
  )
  assert.throws(() => new LibraryDatabase(path), /DDL fault/)
  assert.equal(old.sql.prepare('PRAGMA user_version').get()?.user_version, 8)
  assert.ok(
    !old.sql
      .prepare('PRAGMA table_info(queues)')
      .all()
      .some((row) => row.name === 'play_mode')
  )
  ddlFailure.mock.restore()
  const upgraded = new LibraryDatabase(path)
  try {
    assert.equal(upgraded.sql.prepare('PRAGMA user_version').get()?.user_version, 12)
    assert.deepEqual(upgraded.getLibraryQueue(queue.id), queue)
    assert.deepEqual(upgraded.readLibraryQueue(queue.id), page)
    assert.equal(
      upgraded.sql.prepare('SELECT owner FROM queue_references WHERE queue_id=?').get(queue.id)
        ?.owner,
      'session'
    )
    const backup = new DatabaseSync(
      join(root, readdirSync(root).find((name) => name.includes('.v8-backup-'))!),
      { readOnly: true }
    )
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 8)
      assert.equal(
        backup.prepare('SELECT selected_entry FROM queues WHERE id=?').get(queue.id)
          ?.selected_entry,
        selected
      )
      assert.ok(
        !backup
          .prepare('PRAGMA table_info(queues)')
          .all()
          .some((row) => row.name === 'play_mode')
      )
    } finally {
      backup.close()
    }
  } finally {
    upgraded.close()
  }
})

test('v2 queue upgrade snapshots WAL first and preserves frozen membership and duplicate occurrence IDs', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'queue-schema-upgrade-'))
  const path = join(root, 'library.sqlite'),
    old = new LibraryDatabase(path)
  t.after(() => {
    old.close()
    rmSync(root, { recursive: true, force: true })
  })
  old.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [{ id: 'one', filePath: join(root, 'one.flac') }]
  })
  const queue = old.createLibraryQueue({ ids: ['one', 'one'], sort: 'playlist' })
  const entries = old.readLibraryQueue(queue.id).items.map((item) => item.queueEntryId)
  old.sql.exec(LEGACY_QUEUE_SCHEMA_SQL + legacyQueueSchema)
  const upgraded = new LibraryDatabase(path)
  try {
    assert.equal(upgraded.sql.prepare('PRAGMA user_version').get()?.user_version, 12)
    assert.deepEqual(
      upgraded.readLibraryQueue(queue.id).items.map((item) => item.queueEntryId),
      entries
    )
    assert.equal(upgraded.getLibraryQueue(queue.id).selectedEntryId, entries[0])
    const backup = readdirSync(root).find((name) => name.includes('.v2-backup-'))!
    const snapshot = new DatabaseSync(join(root, backup), { readOnly: true })
    try {
      assert.equal(snapshot.prepare('PRAGMA user_version').get()?.user_version, 2)
      assert.equal(snapshot.prepare('SELECT count(*) AS n FROM queue_entries').get()?.n, 2)
    } finally {
      snapshot.close()
    }
  } finally {
    upgraded.close()
  }
})

test('a failed queue schema upgrade rolls back DDL and leaves the old version and its snapshot usable', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'queue-upgrade-rollback-')),
    path = join(root, 'library.sqlite'),
    old = new LibraryDatabase(path)
  t.after(() => {
    old.close()
    rmSync(root, { recursive: true, force: true })
  })
  old.createLibraryQueue({})
  old.sql.exec(LEGACY_QUEUE_SCHEMA_SQL + legacyQueueSchema)
  old.sql.exec(
    "CREATE TRIGGER fail_upgrade BEFORE UPDATE ON queues BEGIN SELECT RAISE(ABORT,'upgrade fault'); END"
  )
  assert.throws(() => new LibraryDatabase(path), /upgrade fault/)
  assert.equal(old.sql.prepare('PRAGMA user_version').get()?.user_version, 2)
  assert.ok(
    !old.sql
      .prepare('PRAGMA table_info(queues)')
      .all()
      .some((row) => row.name === 'selected_entry')
  )
  assert.equal(old.sql.prepare('SELECT count(*) AS n FROM queues').get()?.n, 1)
  assert.equal(readdirSync(root).filter((name) => name.includes('.v2-backup-')).length, 1)
})

test('a failed pre-upgrade snapshot cannot alter schema, version or queue membership', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'queue-upgrade-snapshot-')),
    path = join(root, 'library.sqlite'),
    old = new LibraryDatabase(path)
  t.after(() => {
    old.close()
    rmSync(root, { recursive: true, force: true })
  })
  const queue = old.createLibraryQueue({})
  old.sql.exec(LEGACY_QUEUE_SCHEMA_SQL + legacyQueueSchema)
  const prepare = DatabaseSync.prototype.prepare
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql === 'VACUUM INTO ?') throw new Error('SQLITE_FULL: database or disk is full')
    return prepare.call(this, sql)
  })
  assert.throws(() => new LibraryDatabase(path), /SQLITE_FULL/)
  assert.equal(old.sql.prepare('PRAGMA user_version').get()?.user_version, 2)
  assert.equal(old.sql.prepare('SELECT id FROM queues').get()?.id, queue.id)
  assert.equal(
    old.sql
      .prepare('PRAGMA table_info(queues)')
      .all()
      .some((row) => row.name === 'selected_entry'),
    false
  )
  assert.equal(readdirSync(root).filter((name) => name.includes('.v2-backup-')).length, 0)
})

test('queue ordering and selected duplicate survive closing and reopening the connection', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'queue-resume-')),
    path = join(root, 'library.sqlite')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let db = new LibraryDatabase(path)
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [
      { id: 'one', filePath: join(root, 'one.flac') },
      { id: 'two', filePath: join(root, 'two.flac') }
    ]
  })
  let queue = db.createLibraryQueue({ ids: ['one', 'two', 'one'], sort: 'playlist' })
  const duplicate = db.readLibraryQueue(queue.id).items[2].queueEntryId
  queue = db.editLibraryQueue(queue.id, queue.revision, {
    kind: 'select',
    entryId: duplicate
  }).queue
  queue = db.editLibraryQueue(queue.id, queue.revision, { kind: 'order', order: 'shuffle' }).queue
  const page = db.readLibraryQueue(queue.id)
  db.close()
  db = new LibraryDatabase(path)
  try {
    assert.deepEqual(db.getLibraryQueue(queue.id), queue)
    assert.deepEqual(db.readLibraryQueue(queue.id), page)
  } finally {
    db.close()
  }
})

test('cooperative mixed queues publish all occurrences and the selected duplicate only after bounded batches finish', (t) => {
  const { db, queue: previous } = fixture(t),
    query = mixedView(db)
  const revision = db.getMetadata().revision
  const build = db.beginLibraryQueueBuild({ ...query, playlistEntryId: '600' }, 'ncm:7')
  const id = build.build.id
  db.sql.exec(`CREATE TEMP TABLE build_writes(kind TEXT);
    CREATE TEMP TRIGGER build_ai AFTER INSERT ON queue_entries BEGIN INSERT INTO build_writes VALUES('entry'); END;
    CREATE TEMP TRIGGER build_si AFTER INSERT ON queue_snapshots BEGIN INSERT INTO build_writes VALUES('snapshot'); END;`)
  const hidden = () => {
    assert.throws(() => db.getLibraryQueue(id), /does not exist/)
    assert.throws(() => db.readLibraryQueue(id), /does not exist/)
    assert.throws(() => db.editLibraryQueue(id, 0, { kind: 'clear' }), /does not exist/)
    assert.throws(() => db.deleteLibraryQueue(id, 0), /does not exist/)
    assert.throws(
      () => db.exportPlaybackQueue({ id, revision: 0, entryId: 'unknown', index: 0 }, 1000),
      /does not exist/
    )
    assert.deepEqual(db.getLibraryQueue(previous.id), previous)
  }
  hidden()
  for (let batch = 0; batch < 4; batch++) {
    db.sql.exec('DELETE FROM build_writes')
    const result = db.advanceLibraryQueueBuild(build)
    assert.equal(db.sql.isTransaction, false)
    for (const row of db.sql
      .prepare('SELECT kind,count(*) AS n FROM build_writes GROUP BY kind')
      .all())
      assert.ok(Number(row.n) <= 200)
    assert.equal(build.build.offset, Math.min((batch + 1) * 200, 605))
    if (!result.ready) {
      hidden()
      continue
    }
    assert.equal(batch, 3)
    assert.equal(result.queue.total, 605)
    assert.equal(result.queue.index, 600)
    invariant(db, result.queue)
    const items = db.readLibraryQueue(id, 595, 10).items
    assert.equal(items[5].track?.source, 'ncm')
    assert.equal(items[5].track?.streamUrl, undefined)
    assert.equal(items[5].queueEntryId, result.queue.selectedEntryId)
    assert.notEqual(
      db.readLibraryQueue(id, 0, 1).items[0].queueEntryId,
      result.queue.selectedEntryId
    )
  }
  assert.equal(db.getMetadata().revision, revision)
})

test('ordinary local queues also use bounded construction and empty queries publish an empty queue', (t) => {
  const { db } = fixture(t)
  const ids = Array.from({ length: 605 }, (_, i) => String(i % 5))
  const build = db.beginLibraryQueueBuild({ ids, sort: 'playlist' }, '3')
  let result = db.advanceLibraryQueueBuild(build)
  assert.equal(result.ready, false)
  assert.equal(
    db.sql.prepare('SELECT count(*) AS n FROM queue_entries WHERE queue_id=?').get(build.build.id)
      ?.n,
    200
  )
  while (!result.ready) result = db.advanceLibraryQueueBuild(build)
  assert.equal(result.queue.total, 605)
  assert.equal(result.queue.index, 3)
  assert.deepEqual(
    db.readLibraryQueue(result.queue.id, 600).items.map((entry) => entry.track?.id),
    ids.slice(600)
  )
  const empty = db.advanceLibraryQueueBuild(
    db.beginLibraryQueueBuild({ ids: [], sort: 'playlist' })
  )
  assert.equal(empty.ready, true)
  if (empty.ready) {
    assert.equal(empty.queue.total, 0)
    assert.equal(empty.queue.index, -1)
  }
})

test('frozen identities are unique across batches and queues and survive subsequent edits', (t) => {
  const { db } = fixture(t),
    local = {
      ids: Array.from({ length: 605 }, (_, i) => String(i % 5)),
      sort: 'playlist' as const
    },
    mixed = mixedView(db)
  const allIdentities = new Set<string>()
  for (const query of [local, mixed]) {
    // Exercise both the compatibility entry point and cooperative worker build.
    const sync = db.createLibraryQueue(query)
    const build = db.beginLibraryQueueBuild(query)
    let result = db.advanceLibraryQueueBuild(build)
    while (!result.ready) result = db.advanceLibraryQueueBuild(build)
    for (let queue of [sync, result.queue]) {
      const items = Array.from(
        { length: 4 },
        (_, i) => db.readLibraryQueue(queue.id, i * 200).items
      ).flat()
      const identities = items.map((item) => item.queueEntryId)
      assert.equal(identities.length, 605)
      assert.deepEqual([...identities].sort(), identities, 'frozen identity index is sequential')
      for (const id of identities) {
        assert.ok(id.length <= 128)
        assert.equal(allIdentities.has(id), false, 'even duplicate tracks have a unique occurrence')
        allIdentities.add(id)
      }
      const selected = identities[200]
      const edit = (change: LibraryQueueEdit) => {
        queue = db.editLibraryQueue(queue.id, queue.revision, change).queue
      }
      edit({ kind: 'select', entryId: selected })
      edit({ kind: 'insert', afterEntryId: selected, trackIds: ['4', '4'] })
      const additions = db.readLibraryQueue(queue.id, 201, 2).items.map((item) => item.queueEntryId)
      assert.equal(new Set([...identities, ...additions]).size, 607)
      edit({ kind: 'move', entryId: selected, beforeEntryId: identities[0] })
      assert.equal(queue.index, 0)
      edit({ kind: 'order', order: 'shuffle' })
      assert.equal(queue.selectedEntryId, selected)
      edit({ kind: 'remove', entryIds: [identities[199]] })
      edit({ kind: 'order', order: 'original' })
      const after = Array.from(
        { length: 4 },
        (_, i) => db.readLibraryQueue(queue.id, i * 200).items
      ).flat()
      assert.deepEqual(
        new Set(after.map((item) => item.queueEntryId)),
        new Set([...identities.filter((id) => id !== identities[199]), ...additions])
      )
      const retained = after.find((item) => item.queueEntryId === selected)!
      assert.equal(retained.track?.id, items[200].track?.id)
      assert.equal(queue.selectedEntryId, selected)
      invariant(db, queue)
    }
  }
})

test('legacy random and ordered identities coexist through consistent backup and reopening', async (t) => {
  const { db, queue } = fixture(t),
    root = mkdtempSync(join(tmpdir(), 'queue-identity-backup-')),
    backupPath = join(root, 'restored.sqlite')
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    rmSync(root, { recursive: true, force: true })
  })
  // Existing profiles used independent 32-hex identities. Do not rewrite them
  // when newer, longer identities are added to the same schema.
  db.sql
    .prepare("UPDATE queue_entries SET entry_id=printf('%032x',position+1) WHERE queue_id=?")
    .run(queue.id)
  db.sql
    .prepare('UPDATE queues SET selected_entry=? WHERE id=?')
    .run('00000000000000000000000000000003', queue.id)
  const newQueue = db.createLibraryQueue(mixedView(db))
  const expected = [queue.id, newQueue.id].map((id) => ({
    snapshot: db.getLibraryQueue(id),
    page: db.readLibraryQueue(id, 0, 605)
  }))
  await db.backupTo(backupPath)
  for (let reopen = 0; reopen < 2; reopen++) {
    const restored = new LibraryDatabase(backupPath)
    try {
      for (const { snapshot, page } of expected) {
        assert.ok(snapshot.selectedEntryId)
        assert.deepEqual(restored.getLibraryQueue(snapshot.id), snapshot)
        assert.deepEqual(restored.readLibraryQueue(snapshot.id, 0, 605), page)
        const portable = restored.exportPlaybackQueue(
          {
            id: snapshot.id,
            revision: snapshot.revision,
            index: snapshot.index,
            entryId: snapshot.selectedEntryId
          },
          32 * 1024 * 1024
        )
        assert.deepEqual(
          portable.queue.map((item) => item.queueEntryId),
          page.items.map((item) => item.queueEntryId)
        )
      }
      assert.equal(restored.sql.prepare('PRAGMA foreign_key_check').all().length, 0)
    } finally {
      restored.close()
    }
  }
})

test('only unpublished batches and retired cleanup use NORMAL; publication and ordinary writes commit with FULL', (t) => {
  const { db } = fixture(t),
    query = mixedView(db),
    build = db.beginLibraryQueueBuild(query)
  const commits: number[] = [],
    exec = db.sql.exec
  t.mock.method(db.sql, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql === 'COMMIT')
      commits.push(Number(this.prepare('PRAGMA synchronous').get()?.synchronous))
    return exec.call(this, sql)
  })
  const full = () => assert.equal(db.sql.prepare('PRAGMA synchronous').get()?.synchronous, 2)
  assert.equal(db.advanceLibraryQueueBuild(build).ready, false)
  assert.deepEqual(commits, [1])
  full()
  db.sql.exec(`CREATE TEMP TRIGGER stage_fault BEFORE INSERT ON queue_entries
    WHEN new.position=250 BEGIN SELECT RAISE(ABORT,'stage fault'); END;`)
  assert.throws(() => db.advanceLibraryQueueBuild(build), /stage fault/)
  full()
  db.sql.exec('DROP TRIGGER stage_fault')
  for (let i = 0; i < 3; i++) db.advanceLibraryQueueBuild(build)
  assert.deepEqual(commits, [1, 1, 1, 2], 'publishing FULL also syncs prior staging WAL frames')
  full()
  db.patchTracks([{ id: '0', expectedVersion: 1, patch: { title: 'Durable' } }])
  assert.equal(commits.at(-1), 2)
  db.deleteLibraryQueue(build.build.id, 0)
  assert.equal(commits.at(-1), 2, 'logical retirement is durable before physical cleanup')
  db.maintainQueryState()
  assert.equal(commits.at(-1), 1)
  full()
})

test('failed restoration of FULL closes the connection before any later library write can inherit weaker durability', (t) => {
  const { db } = fixture(t),
    query = mixedView(db),
    build = db.beginLibraryQueueBuild(query)
  const exec = db.sql.exec
  t.mock.method(db.sql, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql === 'PRAGMA synchronous=FULL') throw new Error('restore sync fault')
    return exec.call(this, sql)
  })
  assert.throws(() => db.advanceLibraryQueueBuild(build), LibraryDatabaseDurabilityError)
  assert.equal(db.sql.isOpen, false)
  assert.throws(
    () => db.patchTracks([{ id: '0', expectedVersion: 1, patch: { title: 'Unsafe' } }]),
    /not open|finalized/
  )
})

test('abandonment and cleanup remain bounded and failed marking or deletion retains the resource slot', (t) => {
  const { db, queue: previous } = fixture(t),
    query = mixedView(db)
  const build = db.beginLibraryQueueBuild(query)
  db.advanceLibraryQueueBuild(build)
  db.advanceLibraryQueueBuild(build)
  const count = () =>
    Number(
      db.sql.prepare('SELECT count(*) AS n FROM queue_entries WHERE queue_id=?').get(build.build.id)
        ?.n
    )
  assert.equal(count(), 400)
  db.sql
    .exec(`CREATE TEMP TRIGGER fail_mark BEFORE UPDATE OF state ON queues WHEN new.state='abandoned'
    BEGIN SELECT RAISE(ABORT,'abandon disk fault'); END;`)
  assert.throws(() => db.abandonLibraryQueueBuild(build), /disk fault/)
  assert.throws(() => db.advanceLibraryQueueBuild(build), /expired/)
  assert.equal(db.needsQueryMaintenance, true)
  assert.throws(() => db.maintainQueryState(), /disk fault/)
  db.sql.exec(`DROP TRIGGER fail_mark;
    CREATE TEMP TRIGGER fail_delete BEFORE DELETE ON queue_entries WHEN old.queue_id='${build.build.id}'
    BEGIN SELECT RAISE(ABORT,'cleanup disk fault'); END;`)
  assert.throws(() => db.maintainQueryState(), /cleanup disk fault/)
  assert.equal(db.sql.isTransaction, false)
  assert.equal(count(), 400)
  assert.throws(() => db.readLibraryQueue(build.build.id), /does not exist/)
  db.sql.exec('DROP TRIGGER fail_delete')
  for (let i = 0; i < 2; i++) {
    const before = count()
    db.maintainQueryState()
    assert.equal(before - count(), 200)
  }
  assert.equal(db.needsQueryMaintenance, false)
  assert.equal(db.sql.prepare('SELECT 1 FROM queues WHERE id=?').get(build.build.id), undefined)
  assert.deepEqual(db.getLibraryQueue(previous.id), previous)
  assert.equal(db.readLibraryQueue(previous.id).items.length, 5)
})

test('later-batch and publication faults roll back the batch, never expose a partial queue, and leave the old cursor intact', (t) => {
  const { db, queue: previous } = fixture(t),
    query = mixedView(db)
  const build = db.beginLibraryQueueBuild(query)
  db.advanceLibraryQueueBuild(build)
  db.sql.exec(`CREATE TEMP TRIGGER fail_later_snapshot BEFORE INSERT ON queue_snapshots
    WHEN (SELECT position FROM queue_entries WHERE entry_id=new.entry_id)=252
    BEGIN SELECT RAISE(ABORT,'snapshot batch fault'); END;`)
  assert.throws(() => db.advanceLibraryQueueBuild(build), /snapshot batch fault/)
  assert.equal(build.build.offset, 200)
  assert.equal(
    db.sql.prepare('SELECT count(*) AS n FROM queue_entries WHERE queue_id=?').get(build.build.id)
      ?.n,
    200
  )
  assert.throws(() => db.getLibraryQueue(build.build.id), /does not exist/)
  db.abandonLibraryQueueBuild(build)
  db.sql.exec('DROP TRIGGER fail_later_snapshot')
  while (db.needsQueryMaintenance) db.maintainQueryState()
  const next = db.beginLibraryQueueBuild(query)
  for (let i = 0; i < 3; i++) assert.equal(db.advanceLibraryQueueBuild(next).ready, false)
  db.sql
    .exec(`CREATE TEMP TRIGGER fail_publish BEFORE UPDATE OF state ON queues WHEN new.state='ready'
    BEGIN SELECT RAISE(ABORT,'publish disk fault'); END;`)
  assert.throws(() => db.advanceLibraryQueueBuild(next), /publish disk fault/)
  assert.equal(next.build.offset, 600)
  assert.equal(
    db.sql.prepare('SELECT count(*) AS n FROM queue_entries WHERE queue_id=?').get(next.build.id)
      ?.n,
    600
  )
  assert.equal(db.sql.isTransaction, false)
  assert.throws(() => db.readLibraryQueue(next.build.id), /does not exist/)
  db.sql.exec('DROP TRIGGER fail_publish')
  db.abandonLibraryQueueBuild(next)
  while (db.needsQueryMaintenance) db.maintainQueryState()
  assert.deepEqual(db.getLibraryQueue(previous.id), previous)
})

test('build capacity includes abandoned rows until cleanup and cannot grow under repeated failures', (t) => {
  const { db } = fixture(t),
    query = mixedView(db)
  const builds = Array.from({ length: 4 }, () => db.beginLibraryQueueBuild(query))
  for (const build of builds) db.advanceLibraryQueueBuild(build)
  assert.throws(() => db.beginLibraryQueueBuild(query), /Too many queue builds/)
  db.abandonLibraryQueueBuild(builds[0])
  assert.throws(() => db.beginLibraryQueueBuild(query), /Too many queue builds/)
  db.maintainQueryState()
  assert.doesNotThrow(() => db.beginLibraryQueueBuild(query))
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM queues WHERE state<>'ready'").get()?.n, 4)
})

test('disposing a published large queue retires it immediately, cleans in bounded batches, and rolls back a failed first batch', (t) => {
  const { db, queue: previous } = fixture(t),
    query = mixedView(db)
  const queue = db.createLibraryQueue(query)
  db.sql.exec(`CREATE TEMP TRIGGER fail_dispose BEFORE DELETE ON queue_entries
    WHEN old.queue_id='${queue.id}' BEGIN SELECT RAISE(ABORT,'dispose fault'); END;`)
  assert.throws(() => db.deleteLibraryQueue(queue.id, queue.revision), /dispose fault/)
  assert.deepEqual(db.getLibraryQueue(queue.id), queue)
  assert.equal(db.sql.isTransaction, false)
  db.sql.exec('DROP TRIGGER fail_dispose')
  db.deleteLibraryQueue(queue.id, queue.revision)
  assert.throws(() => db.getLibraryQueue(queue.id), /does not exist/)
  const count = () =>
    Number(
      db.sql.prepare('SELECT count(*) AS n FROM queue_entries WHERE queue_id=?').get(queue.id)?.n
    )
  assert.equal(count(), 405)
  while (db.needsQueryMaintenance) {
    const before = count()
    db.maintainQueryState()
    assert.ok(before - count() <= 200)
  }
  assert.equal(count(), 0)
  assert.deepEqual(db.getLibraryQueue(previous.id), previous)
})

test('queue references protect live playback and workspace owners from deletion', (t) => {
  const { db, queue } = fixture(t)
  db.syncLibraryQueueReferences('playback-session', [queue.id])
  assert.throws(() => db.deleteLibraryQueue(queue.id, queue.revision), /still referenced/)
  assert.deepEqual(db.getLibraryQueue(queue.id), queue)

  db.syncLibraryQueueReferences('playback-session', [])
  db.syncLibraryQueueReferences('workspace', [queue.id])
  assert.throws(() => db.deleteLibraryQueue(queue.id, queue.revision), /still referenced/)
  db.syncLibraryQueueReferences('workspace', [])
  db.deleteLibraryQueue(queue.id, queue.revision)
  assert.throws(() => db.getLibraryQueue(queue.id), /does not exist/)
})

test('garbage collection retires only old unreferenced queues and cleans large queues in batches', (t) => {
  const { db, queue: retained } = fixture(t)
  const old = db.createLibraryQueue({ ids: ['0', '1', '2'], sort: 'playlist' })
  const large = db.createLibraryQueue(mixedView(db, 605, 'gc-large'))
  db.sql.prepare('UPDATE queues SET created_at=0 WHERE id IN (?,?)').run(old.id, large.id)
  db.syncLibraryQueueReferences('workspace', [retained.id, old.id])

  assert.equal(db.collectLibraryQueueGarbage(0), 1)
  assert.deepEqual(db.getLibraryQueue(old.id), old)
  assert.throws(() => db.getLibraryQueue(large.id), /does not exist/)
  assert.equal(
    db.sql.prepare('SELECT count(*) AS n FROM queue_entries WHERE queue_id=?').get(large.id)?.n,
    605
  )
  let batches = 0
  while (db.needsQueryMaintenance) {
    db.maintainQueryState()
    batches++
  }
  assert.equal(batches, 4)
  assert.equal(db.sql.prepare('SELECT 1 FROM queues WHERE id=?').get(large.id), undefined)
  assert.deepEqual(db.getLibraryQueue(old.id), old)
  assert.deepEqual(db.getLibraryQueue(retained.id), retained)
})

test('failed garbage collection leaves the queue ready and succeeds after the fault is removed', (t) => {
  const { db, queue } = fixture(t)
  db.sql.prepare('UPDATE queues SET created_at=0 WHERE id=?').run(queue.id)
  db.sql.exec(`CREATE TEMP TRIGGER fail_gc BEFORE UPDATE OF state ON queues
    WHEN new.id='${queue.id}' AND new.state='abandoned'
    BEGIN SELECT RAISE(ABORT,'gc disk fault'); END;`)
  assert.throws(() => db.collectLibraryQueueGarbage(0), /gc disk fault/)
  assert.deepEqual(db.getLibraryQueue(queue.id), queue)
  assert.equal(db.needsQueryMaintenance, true)
  db.sql.exec('DROP TRIGGER fail_gc')
  assert.equal(db.collectLibraryQueueGarbage(0), 1)
  assert.throws(() => db.getLibraryQueue(queue.id), /does not exist/)
  while (db.needsQueryMaintenance) db.maintainQueryState()
})

test('content/history fences and dropped or reused views invalidate unfinished queues before further writes', (t) => {
  const { db } = fixture(t),
    query = mixedView(db)
  const content = db.beginLibraryQueueBuild(query)
  db.advanceLibraryQueueBuild(content)
  db.patchTracks([{ id: '0', expectedVersion: 1, patch: { title: 'Changed' } }])
  assert.throws(() => db.advanceLibraryQueueBuild(content), /变化/)
  assert.equal(content.build.offset, 200)
  db.abandonLibraryQueueBuild(content)
  db.queryTracks(query)
  const recent = db.beginLibraryQueueBuild({ ...query, sort: 'lastPlayed' })
  const ordinary = db.beginLibraryQueueBuild(query)
  db.advanceLibraryQueueBuild(recent)
  db.syncListeningHistory({ kind: 'begin', id: 'history', mode: 'replace' })
  db.syncListeningHistory({
    kind: 'append',
    id: 'history',
    sequence: 1,
    entries: [{ id: '0', lastPlayed: 100 }]
  })
  db.syncListeningHistory({ kind: 'commit', id: 'history', sequence: 2 })
  assert.throws(() => db.advanceLibraryQueueBuild(recent), /Listening history changed/)
  db.abandonLibraryQueueBuild(recent)
  assert.equal(
    db.advanceLibraryQueueBuild(ordinary).ready,
    false,
    'irrelevant history does not invalidate the frozen order'
  )
  db.syncPlaylistView({ kind: 'drop', id: 'mixed' })
  assert.throws(() => db.advanceLibraryQueueBuild(ordinary), /expired/)
  db.abandonLibraryQueueBuild(ordinary)
  while (db.needsQueryMaintenance) db.maintainQueryState()
  mixedView(db, 605, 'mixed')
  assert.throws(() => db.advanceLibraryQueueBuild(ordinary), /expired/)
})

test('reopening abandons unpublished queues, keeps all committed mixed occurrences, and cleans only the interrupted build', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'queue-build-recovery-')),
    path = join(root, 'library.sqlite')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let db = new LibraryDatabase(path)
  try {
    db.replaceDocument({
      version: 2,
      revision: 0,
      folders: [],
      exclusions: [],
      tracks: Array.from({ length: 5 }, (_, i) => ({
        id: String(i),
        filePath: join(root, `${i}.flac`)
      }))
    })
    const query = mixedView(db)
    const ready = db.createLibraryQueue({ ...query, playlistEntryId: '600' }, 'ncm:7')
    const page = db.readLibraryQueue(ready.id, 595)
    const building = db.beginLibraryQueueBuild(query)
    db.advanceLibraryQueueBuild(building)
    const id = building.build.id
    db.close()
    db = new LibraryDatabase(path)
    assert.equal(db.sql.prepare('SELECT state FROM queues WHERE id=?').get(id)?.state, 'abandoned')
    assert.throws(() => db.getLibraryQueue(id), /does not exist/)
    assert.equal(
      db.sql.prepare('SELECT count(*) AS n FROM queue_entries WHERE queue_id=?').get(id)?.n,
      200
    )
    db.maintainQueryState()
    assert.equal(db.sql.prepare('SELECT 1 FROM queues WHERE id=?').get(id), undefined)
    assert.deepEqual(db.getLibraryQueue(ready.id), ready)
    assert.deepEqual(db.readLibraryQueue(ready.id, 595), page)
  } finally {
    db.close()
  }
})

test('v7 to v11 snapshots WAL and preserves existing queue identities, while failed DDL or backup rolls back', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'queue-build-upgrade-')),
    path = join(root, 'library.sqlite')
  const old = new LibraryDatabase(path)
  t.after(() => {
    old.close()
    rmSync(root, { recursive: true, force: true })
  })
  old.replaceDocument({
    version: 2,
    revision: 9,
    folders: [],
    exclusions: [],
    tracks: [{ id: 'one', filePath: join(root, 'one.flac') }]
  })
  const queue = old.createLibraryQueue({ ids: ['one', 'one'], sort: 'playlist' })
  const remoteEntry = old.readLibraryQueue(queue.id).items[1].queueEntryId
  old.sql.prepare('UPDATE queue_entries SET track_id=? WHERE entry_id=?').run('ncm:7', remoteEntry)
  old.sql.prepare('INSERT INTO queue_snapshots VALUES(?,?,?)').run(
    queue.id,
    remoteEntry,
    JSON.stringify({
      id: 'ncm:7',
      filePath: '',
      title: 'Remote',
      artist: 'Artist',
      source: 'ncm'
    })
  )
  const page = old.readLibraryQueue(queue.id)
  old.sql.exec(
    LEGACY_QUEUE_SCHEMA_SQL +
      'DROP INDEX queues_state; ALTER TABLE queues DROP COLUMN state; ALTER TABLE queues DROP COLUMN play_mode; DROP INDEX scan_checkpoint_cleanup; ALTER TABLE scan_jobs DROP COLUMN checked_files; ALTER TABLE scan_jobs DROP COLUMN checkpoints_reclaimed; PRAGMA user_version=7;'
  )
  const exec = DatabaseSync.prototype.exec
  const fail = t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('ALTER TABLE queues ADD COLUMN state')) {
        exec.call(this, 'CREATE TABLE partial_queue_upgrade(id TEXT)')
        throw new Error('queue state DDL fault')
      }
      return exec.call(this, sql)
    }
  )
  assert.throws(() => new LibraryDatabase(path), /DDL fault/)
  assert.equal(old.sql.prepare('PRAGMA user_version').get()?.user_version, 7)
  assert.equal(
    old.sql.prepare("SELECT name FROM sqlite_master WHERE name='partial_queue_upgrade'").get(),
    undefined
  )
  fail.mock.restore()
  const prepare = DatabaseSync.prototype.prepare
  const full = t.mock.method(
    DatabaseSync.prototype,
    'prepare',
    function (this: DatabaseSync, sql: string) {
      if (sql === 'VACUUM INTO ?') throw new Error('SQLITE_FULL backup fault')
      return prepare.call(this, sql)
    }
  )
  assert.throws(() => new LibraryDatabase(path), /SQLITE_FULL/)
  assert.equal(old.sql.prepare('PRAGMA user_version').get()?.user_version, 7)
  full.mock.restore()
  const upgraded = new LibraryDatabase(path)
  try {
    assert.equal(upgraded.sql.prepare('PRAGMA user_version').get()?.user_version, 12)
    assert.deepEqual(upgraded.getLibraryQueue(queue.id), queue)
    assert.deepEqual(upgraded.readLibraryQueue(queue.id), page)
    const backup = readdirSync(root).find((name) => name.includes('.v7-backup-'))!
    const snapshot = new DatabaseSync(join(root, backup), { readOnly: true })
    try {
      assert.equal(snapshot.prepare('PRAGMA user_version').get()?.user_version, 7)
      assert.equal(snapshot.prepare('SELECT count(*) AS n FROM queue_entries').get()?.n, 2)
      assert.equal(snapshot.prepare('SELECT count(*) AS n FROM queue_snapshots').get()?.n, 1)
    } finally {
      snapshot.close()
    }
  } finally {
    upgraded.close()
  }
})
