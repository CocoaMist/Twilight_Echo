import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LibraryDatabase } from './libraryDatabase.ts'
import { LEGACY_PREFERENCE_SCHEMA_SQL } from './legacyQueueSchema.fixture.ts'

test('v23 preferences upgrade preserves ratings and creates a consistent pre-upgrade snapshot', t => {
  const root = mkdtempSync(join(tmpdir(), 'preferences-v23-')), file = join(root, 'library.sqlite')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const old = new LibraryDatabase(file)
  old.replaceDocument({ version: 2, revision: 0, folders: [root], exclusions: [], tracks: [
    { id: 'one', filePath: join(root, 'one.flac'), title: 'One', artist: 'Artist', album: 'Album', genre: 'Jazz' }
  ] })
  while (old.catalogStatus().localPending) old.catalogAdvance()
  const entityId = old.catalogQuery({ kind: 'recording' }).items[0].id
  const rating = old.ratingsSet({ entityId, token: old.ratingsDetail(entityId).token, steps: 9 }, 100)
  const catalog = old.catalogStatus(), metadata = old.getMetadata(), tracks = old.getTracksByIds(['one'])
  old.sql.exec(LEGACY_PREFERENCE_SCHEMA_SQL + 'PRAGMA user_version=23;')
  old.close()

  const current = new LibraryDatabase(file)
  assert.equal(current.sql.prepare('PRAGMA user_version').get()!.user_version, 28)
  assert.deepEqual(current.catalogStatus(), catalog)
  assert.deepEqual(current.getMetadata(), metadata)
  assert.deepEqual(current.getTracksByIds(['one']), tracks)
  assert.deepEqual(current.ratingsDetail(entityId), rating)
  assert.equal(current.getPreferencesRevision(), 0)
  assert.equal(current.preferencesPlaylistsLoad(), null)
  const read = current.preferencesDetail(entityId)
  current.preferencesSet({ entityId, token: read.token, state: 'ban' }, 101)
  assert.deepEqual(current.sql.prepare('PRAGMA foreign_key_check').all(), [])
  current.close()

  const backups = readdirSync(root).filter(name => name.includes('.v23-backup-'))
  assert.equal(backups.length, 1)
  const snapshot = new DatabaseSync(join(root, backups[0]))
  assert.equal(snapshot.prepare('PRAGMA user_version').get()!.user_version, 23)
  assert.equal(snapshot.prepare('SELECT count(*) n FROM tracks').get()!.n, 1)
  assert.equal(snapshot.prepare('SELECT steps FROM personal_rating_values').get()!.steps, 9)
  assert.equal(snapshot.prepare("SELECT count(*) n FROM sqlite_master WHERE name='personal_preference_values'").get()!.n, 0)
  snapshot.close()
  const reopened = new LibraryDatabase(file)
  assert.equal(reopened.preferencesDetail(entityId).value?.state, 'ban')
  assert.deepEqual(reopened.ratingsDetail(entityId), rating)
  reopened.close()
  assert.equal(readdirSync(root).filter(name => name.includes('.v23-backup-')).length, 1)
})

test('failed v23 preferences installation rolls back and incomplete current preferences schema is rejected', t => {
  const root = mkdtempSync(join(tmpdir(), 'preferences-failure-')), file = join(root, 'library.sqlite')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const old = new LibraryDatabase(file)
  old.sql.exec(LEGACY_PREFERENCE_SCHEMA_SQL + 'PRAGMA user_version=23; CREATE TABLE personal_preference_values(incompatible TEXT);')
  old.close()
  assert.throws(() => new LibraryDatabase(file), /already exists/)
  const raw = new DatabaseSync(file)
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 23)
  assert.equal(raw.prepare("SELECT count(*) n FROM sqlite_master WHERE name='personal_preferences_state'").get()!.n, 0)
  raw.exec('DROP TABLE personal_preference_values')
  raw.close()
  const repaired = new LibraryDatabase(file)
  repaired.sql.exec('DROP INDEX personal_preference_history_target')
  repaired.close()
  assert.throws(() => new LibraryDatabase(file), /incomplete/)
})
