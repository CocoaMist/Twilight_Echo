import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LibraryDatabase } from './libraryDatabase.ts'
import { LEGACY_RATING_SCHEMA_SQL } from './legacyQueueSchema.fixture.ts'

test('v22 rating upgrade keeps library data and creates one consistent pre-upgrade snapshot', t => {
  const root = mkdtempSync(join(tmpdir(), 'ratings-v22-')), file = join(root, 'library.sqlite')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const old = new LibraryDatabase(file)
  old.replaceDocument({ version: 2, revision: 0, folders: [root], exclusions: [], tracks: [
    { id: 'one', filePath: join(root, 'one.flac'), title: 'One', artist: 'Artist', album: 'Album', genre: 'Jazz' }
  ] })
  while (old.catalogStatus().localPending) old.catalogAdvance()
  while (old.genresAdvance().pending) { /* original bounded index */ }
  const entityId = old.catalogQuery({ kind: 'recording' }).items[0].id
  const catalog = old.catalogStatus(), metadata = old.getMetadata(), before = old.getTracksByIds(['one'])
  old.sql.exec(LEGACY_RATING_SCHEMA_SQL + 'PRAGMA user_version=22;')
  old.close()
  const current = new LibraryDatabase(file)
  assert.equal(current.sql.prepare('PRAGMA user_version').get()!.user_version, 28)
  assert.deepEqual(current.catalogStatus(), catalog)
  assert.deepEqual(current.getMetadata(), metadata)
  assert.deepEqual(current.getTracksByIds(['one']), before)
  assert.equal(current.getRatingsRevision(), 0)
  const read = current.ratingsDetail(entityId)
  current.ratingsSet({ entityId, token: read.token, steps: 1 }, 100)
  assert.deepEqual(current.sql.prepare('PRAGMA foreign_key_check').all(), [])
  current.close()
  const backups = readdirSync(root).filter(name => name.includes('.v22-backup-'))
  assert.equal(backups.length, 1)
  const snapshot = new DatabaseSync(join(root, backups[0]))
  assert.equal(snapshot.prepare('PRAGMA user_version').get()!.user_version, 22)
  assert.equal(snapshot.prepare('SELECT count(*) n FROM tracks').get()!.n, 1)
  assert.equal(snapshot.prepare("SELECT count(*) n FROM sqlite_master WHERE name='personal_rating_values'").get()!.n, 0)
  snapshot.close()
  const reopened = new LibraryDatabase(file)
  assert.equal(reopened.ratingsDetail(entityId).value?.steps, 1)
  reopened.close()
  assert.equal(readdirSync(root).filter(name => name.includes('.v22-backup-')).length, 1)
})

test('failed v22 rating installation rolls back fully and incomplete current schema is rejected', t => {
  const root = mkdtempSync(join(tmpdir(), 'ratings-failure-')), file = join(root, 'library.sqlite')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const old = new LibraryDatabase(file)
  old.sql.exec(LEGACY_RATING_SCHEMA_SQL + 'PRAGMA user_version=22; CREATE TABLE personal_rating_values(incompatible TEXT);')
  old.close()
  assert.throws(() => new LibraryDatabase(file), /already exists/)
  const raw = new DatabaseSync(file)
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 22)
  assert.equal(raw.prepare("SELECT count(*) n FROM sqlite_master WHERE name='personal_ratings_state'").get()!.n, 0)
  raw.exec('DROP TABLE personal_rating_values')
  raw.close()
  const repaired = new LibraryDatabase(file)
  repaired.sql.exec('DROP INDEX personal_rating_history_target')
  repaired.close()
  assert.throws(() => new LibraryDatabase(file), /incomplete/)
})
