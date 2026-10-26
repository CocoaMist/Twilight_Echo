import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LibraryDatabase } from './libraryDatabase.ts'
import { LEGACY_PERSONAL_METADATA_SCHEMA_SQL } from './legacyQueueSchema.fixture.ts'

test('v27 metadata upgrade keeps old text/identities untouched and snapshots the actual pre-upgrade schema', t => {
  const dir = mkdtempSync(join(tmpdir(), 'metadata-v27-')), path = join(dir, 'library.sqlite')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const old = new LibraryDatabase(path)
  old.sql.exec("INSERT INTO catalog_entities VALUES('artist','artist','Artist','','manual'); INSERT INTO metadata_subjects(id,revision) VALUES('artist',4); INSERT INTO metadata_overrides VALUES('artist','{\"mode\":\"value\",\"value\":\"Original text\",\"language\":\"en\"}')")
  const metadata = old.getMetadata(), revision = old.getClassificationMetadataRevision()
  old.sql.exec(LEGACY_PERSONAL_METADATA_SCHEMA_SQL + 'PRAGMA user_version=27;')
  old.close()
  const upgraded = new LibraryDatabase(path)
  assert.equal(upgraded.sql.prepare('PRAGMA user_version').get()!.user_version, 29)
  assert.deepEqual(upgraded.getMetadata(), metadata)
  const detail = upgraded.metadataDetail('artist', 'en')
  assert.equal(detail.revision, 4); assert.equal(detail.introduction?.value, 'Original text')
  assert.equal(detail.sourcePreference?.provider, null); assert.equal(detail.manualArtwork, null)
  assert.equal(upgraded.getClassificationMetadataRevision(), revision)
  const before = upgraded.musicBackupRevision()
  upgraded.metadataSourcePreference({ entityId: 'artist', revision: 4, language: 'en', provider: null }, 10)
  assert.ok(upgraded.musicBackupRevision().metadata > before.metadata)
  upgraded.close()
  const snapshots = readdirSync(dir).filter(name => name.includes('.v27-backup-'))
  assert.equal(snapshots.length, 1)
  const snapshot = new DatabaseSync(join(dir, snapshots[0]))
  assert.equal(snapshot.prepare('PRAGMA user_version').get()!.user_version, 27)
  assert.equal(snapshot.prepare("SELECT count(*) n FROM sqlite_master WHERE name='metadata_source_preferences'").get()!.n, 0)
  assert.equal(snapshot.prepare("SELECT revision FROM metadata_subjects WHERE id='artist'").get()!.revision, 4)
  snapshot.close()
  const reopened = new LibraryDatabase(path)
  assert.equal(reopened.metadataDetail('artist', 'en').revision, 5)
  reopened.close()
})

test('v28 metadata DDL rollback and incomplete authority checks preserve the old database', t => {
  const dir = mkdtempSync(join(tmpdir(), 'metadata-v28-failure-')), path = join(dir, 'library.sqlite')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const old = new LibraryDatabase(path)
  old.sql.exec(LEGACY_PERSONAL_METADATA_SCHEMA_SQL + 'PRAGMA user_version=27; CREATE TABLE metadata_artwork_overrides(incompatible TEXT);')
  old.close()
  assert.throws(() => new LibraryDatabase(path), /already exists/)
  const raw = new DatabaseSync(path)
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 27)
  assert.equal(raw.prepare("SELECT count(*) n FROM sqlite_master WHERE name='metadata_source_preferences'").get()!.n, 0)
  raw.exec('DROP TABLE metadata_artwork_overrides'); raw.close()
  const current = new LibraryDatabase(path)
  current.sql.exec('DROP TRIGGER music_browse_metadata_source_preferences_au'); current.close()
  assert.throws(() => new LibraryDatabase(path), /incomplete/)
})
