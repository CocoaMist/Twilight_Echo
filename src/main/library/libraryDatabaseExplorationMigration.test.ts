import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { LibraryDatabase } from './libraryDatabase.ts'
import { LEGACY_EXPLORATION_SCHEMA_SQL } from './legacyQueueSchema.fixture.ts'

test('v26 exploration upgrade preserves personal history, Focus, tags and a restorable pre-upgrade snapshot', t => {
  const root = mkdtempSync(join(tmpdir(), 'exploration-v26-')), file = join(root, 'library.sqlite')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const old = new LibraryDatabase(file)
  old.replaceDocument({ version: 2, revision: 0, folders: [root], exclusions: [], tracks: [
    { id: 'one', filePath: join(root, 'one.flac'), title: 'One', artist: 'Artist', album: 'Album' }
  ] })
  while (old.catalogStatus().localPending) old.catalogAdvance()
  const id = old.catalogQuery({ kind: 'recording' }).items[0].id
  old.preferencesSet({ entityId: id, state: 'favorite', token: old.preferencesDetail(id).token }, 100)
  old.preferencesSet({ entityId: id, state: 'none', token: old.preferencesDetail(id).token }, 101)
  const personal = old.preferencesDetail(id), history = old.preferencesHistory({ entityId: id })
  const saved = old.focusSavedCreate({ name: 'All', savedRevision: 0,
    query: { version: 1, entity: 'recording', where: { source: { provider: 'local' } } } }, 102)
  const tag = old.tagsCreate({ name: 'Night', tagsRevision: 0 }, 103)
  old.tagsMemberSet({ tagId: tag.tag.id, entityId: id, present: true, membersRevision: 0 }, 104)
  const tags = old.tagsList({}), metadata = old.getMetadata()
  old.sql.exec(LEGACY_EXPLORATION_SCHEMA_SQL + 'PRAGMA user_version=26;')
  old.close()
  const current = new LibraryDatabase(file)
  assert.equal(current.sql.prepare('PRAGMA user_version').get()!.user_version, 28)
  assert.deepEqual(current.getMetadata(), metadata)
  assert.deepEqual(current.preferencesDetail(id), personal)
  assert.deepEqual(current.preferencesHistory({ entityId: id }), history)
  assert.deepEqual(current.tagsList({}), tags)
  assert.deepEqual(current.focusSavedList({}).items, [saved.item])
  assert.equal(current.explorationQuery({}).total, 0)
  assert.deepEqual(current.sql.prepare('PRAGMA foreign_key_check').all(), [])
  current.sql.prepare("INSERT INTO catalog_entities VALUES('work','work','A work','','source')").run()
  current.preferencesSet({ entityId: 'work', state: 'favorite', token: current.preferencesDetail('work').token }, 105)
  assert.equal(current.preferencesDetail('work').kind, 'work')
  current.close()
  const backups = readdirSync(root).filter(n => n.includes('.v26-backup-'))
  assert.equal(backups.length, 1)
  const snapshot = new DatabaseSync(join(root, backups[0]))
  assert.equal(snapshot.prepare('PRAGMA user_version').get()!.user_version, 26)
  assert.equal(snapshot.prepare("SELECT count(*) n FROM sqlite_master WHERE name='music_exploration_refs'").get()!.n, 0)
  assert.match(String(snapshot.prepare("SELECT sql FROM sqlite_master WHERE name='personal_preference_values'").get()!.sql), /'artist'\)/)
  snapshot.close()
  const reopened = new LibraryDatabase(file)
  assert.equal(reopened.preferencesDetail('work').value?.state, 'favorite')
  reopened.close()
  assert.equal(readdirSync(root).filter(n => n.includes('.v26-backup-')).length, 1)
})

test('v26 exploration DDL failure rolls back and incomplete current schema is rejected', t => {
  const root = mkdtempSync(join(tmpdir(), 'exploration-failure-')), file = join(root, 'library.sqlite')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const old = new LibraryDatabase(file)
  old.sql.exec(LEGACY_EXPLORATION_SCHEMA_SQL + 'PRAGMA user_version=26; CREATE TABLE music_exploration_refs(incompatible TEXT);')
  old.close()
  assert.throws(() => new LibraryDatabase(file), /already exists/)
  const raw = new DatabaseSync(file)
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 26)
  assert.equal(raw.prepare("SELECT count(*) n FROM sqlite_master WHERE name='music_exploration_state'").get()!.n, 0)
  raw.exec('DROP TABLE music_exploration_refs')
  raw.close()
  const current = new LibraryDatabase(file)
  current.sql.exec('DROP INDEX music_exploration_relations_from')
  current.close()
  assert.throws(() => new LibraryDatabase(file), /incomplete/)
})
