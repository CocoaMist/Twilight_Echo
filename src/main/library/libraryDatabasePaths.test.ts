import { LEGACY_QUEUE_SCHEMA_SQL } from './legacyQueueSchema.fixture.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { LibraryDatabase } from './libraryDatabase.ts'
import { normalizePortableLibraryPath } from '../../shared/playlistPaths.ts'

const removePathIndex = `DROP TABLE queue_snapshots; DROP INDEX queues_state; ALTER TABLE queues DROP COLUMN state; ALTER TABLE queues DROP COLUMN play_mode; DROP INDEX tracks_recording; DROP INDEX tracks_playlist_path; DROP INDEX tracks_playlist_suffix;
ALTER TABLE tracks DROP COLUMN playlist_path; ALTER TABLE tracks DROP COLUMN playlist_path_reverse;
DROP INDEX scan_checkpoint_cleanup; ALTER TABLE scan_jobs DROP COLUMN checked_files; ALTER TABLE scan_jobs DROP COLUMN checkpoints_reclaimed; PRAGMA user_version=4;`
const paths = [
  'D:/Music/unique.flac',
  'D:/Music/Album/a.flac',
  'D:/Music/Album/a.flac',
  'D:/Music/Else/a.flac',
  '/Music/Case/One.flac',
  '/Music/case/one.flac',
  'D:/Music/100%_live.flac',
  'D:/Music/100aaalive.flac',
  'D:/Music/emoji-🌙.flac'
]
const tracks = paths.map((filePath, i) => ({ id: `t:${i}`, filePath, title: `Title ${i}` }))
function seed(db: LibraryDatabase) {
  db.replaceDocument({ version: 2, revision: 0, tracks, folders: [], exclusions: [] })
}
test('indexed path lookup exactly preserves legacy absolute, relative, ambiguity, CUE and case rules', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  seed(db)
  const requested = [
    'd:\\MUSIC\\UNIQUE.flac',
    'unique.flac',
    'D:/Music/Album/a.flac',
    'Album/a.flac',
    'a.flac',
    '/Music/Case/One.flac',
    '/Music/Case/one.flac',
    '100%_live.flac',
    'emoji-🌙.flac',
    'missing.flac',
    'unique.flac'
  ]
  const byPath = new Map(
    tracks.map((track) => [normalizePortableLibraryPath(track.filePath), track.id])
  )
  const legacy = requested.map((path) => {
    const key = normalizePortableLibraryPath(path),
      exact = byPath.get(key)
    if (exact) return exact
    if (/^[a-zA-Z]:\\/.test(key) || key.startsWith('\\')) return null
    const matching = tracks.filter((track) =>
      normalizePortableLibraryPath(track.filePath).endsWith(`\\${key}`)
    )
    return matching.length === 1 ? matching[0].id : null
  })
  assert.deepEqual(db.lookupTracksByPaths(requested).ids, legacy)
  assert.deepEqual(legacy, [
    't:0',
    't:0',
    't:2',
    null,
    null,
    't:4',
    null,
    't:6',
    't:8',
    null,
    't:0'
  ])
  for (const sql of [
    "SELECT id FROM tracks WHERE playlist_path='d:\\music\\unique.flac' ORDER BY seq DESC LIMIT 1",
    "SELECT id FROM tracks WHERE playlist_path_reverse>='calf' AND playlist_path_reverse<'calg' LIMIT 2"
  ])
    assert.match(
      db.sql
        .prepare('EXPLAIN QUERY PLAN ' + sql)
        .all()
        .map((row) => row.detail)
        .join(' '),
      /SEARCH.*tracks_playlist_/
    )
  assert.throws(() => db.lookupTracksByPaths(Array(1001).fill('one.flac')), /oversized/)
  assert.throws(() => db.lookupTracksByPaths(['']), /Invalid/)
  assert.throws(() => db.lookupTracksByPaths(['one\0.flac']), /Invalid/)
  assert.throws(() => db.lookupTracksByPaths(['unique.flac'], -1), /Invalid/)
  assert.throws(() => db.getTracksByIds(['t:0'], NaN), /Invalid/)
  const before = db.lookupTracksByPaths(['unique.flac'])
  db.patchTracks([{ id: 't:0', expectedVersion: 1, patch: { title: 'Edited' } }])
  assert.throws(() => db.lookupTracksByPaths(['unique.flac'], before.revision), /发生变化/)
  assert.throws(() => db.getTracksByIds(['t:0'], before.revision), /发生变化/)
  assert.equal(db.getTracksByIds(['t:0']).tracks[0].title, 'Edited')
})

test('v4 upgrade snapshots WAL and builds path indexes without changing content, scan identities or frozen queues', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'library-path-upgrade-')),
    path = join(root, 'library.sqlite')
  const old = new LibraryDatabase(path)
  t.after(() => {
    old.close()
    rmSync(root, { recursive: true, force: true })
  })
  seed(old)
  const before = old.exportDocument(),
    versions = old.getTracksByIds(['t:0', 't:2']).versions
  const files = old.sql
    .prepare('SELECT file_key,content_version FROM files ORDER BY file_key')
    .all()
  const queue = old.createLibraryQueue({ sort: 'playlist', ids: ['t:0', 't:0'] })
  old.sql.exec(LEGACY_QUEUE_SCHEMA_SQL + removePathIndex)
  const upgraded = new LibraryDatabase(path)
  try {
    assert.equal(upgraded.sql.prepare('PRAGMA user_version').get()?.user_version, 12)
    assert.deepEqual(upgraded.exportDocument(), before)
    assert.deepEqual(upgraded.getTracksByIds(['t:0', 't:2']).versions, versions)
    assert.deepEqual(
      upgraded.sql.prepare('SELECT file_key,content_version FROM files ORDER BY file_key').all(),
      files
    )
    assert.deepEqual(upgraded.lookupTracksByPaths(['unique.flac', paths[2]]).ids, ['t:0', 't:2'])
    assert.equal(upgraded.readLibraryQueue(queue.id).total, 2)
    const snapshot = new DatabaseSync(
      join(root, readdirSync(root).find((name) => name.includes('.v4-backup-'))!),
      { readOnly: true }
    )
    try {
      assert.equal(snapshot.prepare('PRAGMA user_version').get()?.user_version, 4)
      assert.equal(snapshot.prepare('SELECT count(*) AS n FROM tracks').get()?.n, tracks.length)
      assert.equal(snapshot.prepare('SELECT count(*) AS n FROM queue_entries').get()?.n, 2)
    } finally {
      snapshot.close()
    }
  } finally {
    upgraded.close()
  }
})

test('path schema DDL faults roll back and a failed snapshot prevents any upgrade', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'library-path-fault-')),
    path = join(root, 'library.sqlite')
  const old = new LibraryDatabase(path)
  t.after(() => {
    old.close()
    rmSync(root, { recursive: true, force: true })
  })
  seed(old)
  old.sql.exec(LEGACY_QUEUE_SCHEMA_SQL + removePathIndex)
  const original = DatabaseSync.prototype.exec
  const mock = t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      if (sql.includes('ALTER TABLE tracks ADD COLUMN playlist_path')) {
        original.call(this, "ALTER TABLE tracks ADD COLUMN playlist_path TEXT NOT NULL DEFAULT ''")
        throw new Error('path DDL fault')
      }
      return original.call(this, sql)
    }
  )
  assert.throws(() => new LibraryDatabase(path), /path DDL fault/)
  assert.equal(old.sql.prepare('PRAGMA user_version').get()?.user_version, 4)
  assert.ok(
    !old.sql
      .prepare('PRAGMA table_info(tracks)')
      .all()
      .some((row) => row.name === 'playlist_path')
  )
  mock.mock.restore()
  const prepare = DatabaseSync.prototype.prepare
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql === 'VACUUM INTO ?') throw new Error('SQLITE_FULL: snapshot failed')
    return prepare.call(this, sql)
  })
  assert.throws(() => new LibraryDatabase(path), /SQLITE_FULL/)
  assert.equal(old.sql.prepare('PRAGMA user_version').get()?.user_version, 4)
})
