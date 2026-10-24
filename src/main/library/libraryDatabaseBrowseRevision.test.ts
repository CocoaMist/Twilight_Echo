import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LibraryDatabase } from './libraryDatabase.ts'
import { LEGACY_BROWSE_REVISION_SQL } from './legacyQueueSchema.fixture.ts'

const revision = (db: LibraryDatabase) => Number(db.sql.prepare(
  'SELECT metadata_revision FROM music_browse_state WHERE id=1').get()!.metadata_revision)

test('production classification supports platform album targets only with native album identity', t => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const tracks = [
    { id: 'ncm:1', albumId: '42', genre: 'Jazz' },
    { id: 'ncm:2', albumId: '42', genre: 'Rock' },
    { id: 'ncm:3', albumId: undefined, genre: 'Jazz' },
    { id: 'ncm:4', albumId: undefined, genre: 'Rock' }
  ].map(track => ({ ...track, source: 'ncm', title: track.id, artist: 'Artist', album: 'Same title',
    filePath: '', fileName: '', duration: 100, size: 0, cover: null, lyrics: null }))
  let sync = db.catalogSync({ kind: 'begin', revision: 0 })
  sync = db.catalogSync({ kind: 'append', ...sync, tracks })
  db.catalogSync({ kind: 'commit', ...sync })
  while (db.genresAdvance(200).pending) { /* existing bounded index */ }
  const releases = db.genresBrowse({ kind: 'release' })
  assert.equal(releases.total, 3)
  const album = releases.items.find(item => item.sourceCount === 2)!
  const targets = db.genresMembers({ entityId: album.id }).items.map(item => item.collectionTarget)
  assert.equal(targets.length, 2)
  assert.deepEqual(targets[0], targets[1])
  assert.ok(targets[0])
  db.genresOverride({ target: targets[0]!, revision: db.getGenresRevision(), genreIds: [] })
  assert.equal(db.genresMembers({ entityId: album.id }).entity!.genres.total, 0)
  for (const item of releases.items.filter(item => item.sourceCount === 1))
    assert.equal(db.genresMembers({ entityId: item.id }).items[0].collectionTarget, null)
  const guessed = db.sql.prepare("SELECT album_key FROM catalog_sources WHERE track_id='ncm:3'").get()!.album_key as string
  assert.throws(() => db.genresOverride({ target: { kind: 'collection', id: guessed },
    revision: db.getGenresRevision(), genreIds: [] }), /专辑集合不存在/)
})

test('metadata browse fence observes independent facts, identities and overrides transactionally', t => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.sql.exec("INSERT INTO catalog_entities(id,kind,title,artist,identity) VALUES('e','artist','Artist','','source')")
  const before = revision(db)
  db.sql.exec("INSERT INTO metadata_subjects(id) VALUES('e')")
  assert.ok(revision(db) > before)
  db.sql.exec("INSERT INTO metadata_entities VALUES('t','fixture','artist','42','Artist')")
  const subject = revision(db)
  db.sql.exec("INSERT INTO metadata_facts VALUES('t','fixture','country','und','{}')")
  assert.ok(revision(db) > subject)
  const inserted = revision(db)
  db.sql.exec("BEGIN; UPDATE metadata_facts SET payload='{\"value\":\"CN\"}'; ROLLBACK;")
  assert.equal(revision(db), inserted)
  db.sql.exec("UPDATE metadata_facts SET payload='{\"value\":\"CN\"}'; UPDATE metadata_facts SET payload='{}';")
  assert.ok(revision(db) >= inserted + 2)
  const changed = revision(db)
  db.sql.exec("INSERT INTO metadata_overrides VALUES('e','{}'); DELETE FROM metadata_facts;")
  assert.ok(revision(db) >= changed + 2)
})

test('v21 browse fence upgrade preserves user classifications and creates one pre-upgrade snapshot', t => {
  const root = mkdtempSync(join(tmpdir(), 'browse-v21-')), file = join(root, 'library.sqlite')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const old = new LibraryDatabase(file)
  old.genresEdit({ action: 'create', revision: old.getGenresRevision(), name: '我的分类', nameEn: 'My genre' })
  const genres = old.genresTree({})
  old.sql.exec(LEGACY_BROWSE_REVISION_SQL + 'PRAGMA user_version=21;')
  old.close()
  const db = new LibraryDatabase(file)
  assert.equal(db.sql.prepare('PRAGMA user_version').get()!.user_version, 28)
  assert.deepEqual(db.genresTree({}), genres)
  assert.equal(revision(db), 0)
  assert.deepEqual(db.sql.prepare('PRAGMA foreign_key_check').all(), [])
  db.close()
  const backups = readdirSync(root).filter(name => name.includes('.v21-backup-'))
  assert.equal(backups.length, 1)
  const snapshot = new DatabaseSync(join(root, backups[0]))
  assert.equal(snapshot.prepare('PRAGMA user_version').get()!.user_version, 21)
  assert.equal(snapshot.prepare('SELECT count(*) n FROM music_genres').get()!.n, genres.total)
  snapshot.close()
  const reopened = new LibraryDatabase(file)
  reopened.close()
  assert.equal(readdirSync(root).filter(name => name.includes('.v21-backup-')).length, 1)
})

test('v21 failed fence installation is rolled back and incomplete current schema is rejected', t => {
  const root = mkdtempSync(join(tmpdir(), 'browse-failure-')), file = join(root, 'library.sqlite')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const old = new LibraryDatabase(file)
  old.sql.exec(LEGACY_BROWSE_REVISION_SQL + 'PRAGMA user_version=21; CREATE TABLE music_browse_state(incompatible TEXT);')
  old.close()
  assert.throws(() => new LibraryDatabase(file), /already exists/)
  const raw = new DatabaseSync(file)
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 21)
  assert.equal(raw.prepare("SELECT count(*) n FROM sqlite_master WHERE name='music_browse_metadata_facts_ai'").get()!.n, 0)
  raw.exec('DROP TABLE music_browse_state')
  raw.close()
  const repaired = new LibraryDatabase(file)
  repaired.sql.exec('DROP TRIGGER music_browse_metadata_facts_ai')
  repaired.close()
  assert.throws(() => new LibraryDatabase(file), /incomplete/)
})
