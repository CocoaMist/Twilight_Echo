import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryDatabase } from './libraryDatabase.ts'
import { LEGACY_BROWSE_REVISION_SQL } from './legacyQueueSchema.fixture.ts'

function profile(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'genre-schema-')),
    file = join(root, 'library.sqlite')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const db = new LibraryDatabase(file)
  db.replaceDocument({
    version: 2,
    revision: 7,
    folders: [root],
    exclusions: [],
    tracks: [
      {
        id: 'retained',
        source: 'local',
        filePath: join(root, 'one.flac'),
        title: 'Original',
        artist: 'Artist',
        album: 'Album',
        genre: 'Jazz;Fusion'
      }
    ]
  })
  const queue = db.createLibraryQueue({}, 'retained')
  return { root, file, db, queue }
}
function downgrade(db: LibraryDatabase) {
  db.sql.exec(LEGACY_BROWSE_REVISION_SQL)
  // Remove only this increment, producing a genuine pre-classification schema.
  const objects = db.sql
    .prepare(
      "SELECT type,name FROM sqlite_master WHERE name LIKE 'music_genre%' ORDER BY CASE type WHEN 'trigger' THEN 0 WHEN 'table' THEN 1 ELSE 2 END"
    )
    .all()
  db.sql.exec('PRAGMA foreign_keys=OFF')
  for (const object of objects)
    if (object.type === 'trigger' || object.type === 'table')
      db.sql.exec(`DROP ${String(object.type)} "${String(object.name).replaceAll('"', '""')}"`)
  db.sql.exec('PRAGMA user_version=20; PRAGMA foreign_keys=ON')
}

test('v20 classification migration backs up and preserves library, queues and exact genre meaning', (t) => {
  const { root, file, db, queue } = profile(t)
  const metadata = db.getMetadata(),
    before = db.getTracksByIds(['retained'])
  downgrade(db)
  db.close()
  const upgraded = new LibraryDatabase(file)
  try {
    assert.equal(upgraded.sql.prepare('PRAGMA user_version').get()!.user_version, 29)
    assert.deepEqual(upgraded.getMetadata(), metadata)
    assert.deepEqual(upgraded.getTracksByIds(['retained']), before)
    assert.deepEqual(upgraded.getLibraryQueue(queue.id), queue)
    assert.equal(upgraded.queryTracks({ genre: 'Jazz', genreSeparators: ';' }).total, 1)
    assert.equal(upgraded.genresTree({}).total, 16)
    assert.equal(upgraded.sql.prepare('PRAGMA foreign_key_check').all().length, 0)
  } finally {
    upgraded.close()
  }
  const backups = readdirSync(root).filter((name) => name.includes('.v20-backup-'))
  assert.equal(backups.length, 1)
  const backup = new DatabaseSync(join(root, backups[0]))
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 20)
    assert.equal(backup.prepare('SELECT count(*) n FROM tracks').get()!.n, 1)
  } finally {
    backup.close()
  }
  const reopened = new LibraryDatabase(file)
  reopened.close()
  assert.equal(readdirSync(root).filter((name) => name.includes('.v20-backup-')).length, 1)
})

test('failed v20 schema upgrade rolls back all new objects and leaves a recoverable snapshot', (t) => {
  const { root, file, db } = profile(t)
  downgrade(db)
  // An incompatible partial object forces the seed to fail inside the upgrade.
  db.sql.exec('CREATE TABLE music_genres(incompatible TEXT)')
  db.close()
  assert.throws(() => new LibraryDatabase(file), /column|columns/)
  const retained = new DatabaseSync(file)
  try {
    assert.equal(retained.prepare('PRAGMA user_version').get()!.user_version, 20)
    assert.equal(retained.prepare('SELECT count(*) n FROM tracks').get()!.n, 1)
    assert.equal(
      retained.prepare("SELECT count(*) n FROM sqlite_master WHERE name='music_genre_state'").get()!
        .n,
      0
    )
    assert.equal(retained.prepare('PRAGMA quick_check').get()!.quick_check, 'ok')
  } finally {
    retained.close()
  }
  assert.equal(readdirSync(root).filter((name) => name.includes('.v20-backup-')).length, 1)
})

test('incomplete current classification schema is rejected without silently recreating user state', (t) => {
  const { file, db } = profile(t)
  db.sql.exec('DROP TABLE music_genre_legacy_targets')
  db.close()
  assert.throws(() => new LibraryDatabase(file), /incomplete/)
})
