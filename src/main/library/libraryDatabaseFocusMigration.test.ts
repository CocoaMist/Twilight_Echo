import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LibraryDatabase } from './libraryDatabase.ts'
import { LEGACY_FOCUS_SCHEMA_SQL } from './legacyQueueSchema.fixture.ts'
import type { TrackData } from '../../shared/track.ts'

test('v25 Focus migration snapshots WAL and preserves tags, personal states and ordinary duplicate occurrences', t => {
  const root = mkdtempSync(join(tmpdir(), 'focus-v25-')), file = join(root, 'library.sqlite')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const old = new LibraryDatabase(file)
  const track: TrackData = { id: 'one', source: 'local', title: 'One', artist: 'Artist', album: 'Album', duration: 100,
    filePath: join(root, 'one.flac'), fileName: 'one.flac', size: 1, cover: null, lyrics: null }
  old.replaceDocument({ version: 2, revision: 0, folders: [root], exclusions: [], tracks: [track] })
  while (old.catalogStatus().localPending) old.catalogAdvance()
  const entityId = old.catalogQuery({ kind: 'recording' }).items[0].id
  const rating = old.ratingsSet({ entityId, token: old.ratingsDetail(entityId).token, steps: 8 }, 100)
  const lists = old.preferencesPlaylistsMigrate({ version: 2, revision: 4, savedAt: 'old', data: [
    { id: 'ordinary', name: 'Ordinary', createdAt: 'old', trackIds: ['one', 'one'] }
  ] }, 101, { logicalMemberCount: 0 })
  const created = old.tagsCreate({ name: '夜晚', tagsRevision: 0 }, 102)
  old.tagsMemberSet({ tagId: created.tag.id, entityId, present: true, membersRevision: 0 }, 103)
  const tags = old.tagsList({}), metadata = old.getMetadata(), receipt = old.preferencesPlaylistsMigrationReceipt()
  old.sql.exec(LEGACY_FOCUS_SCHEMA_SQL + 'PRAGMA user_version=25;')
  old.close()
  const current = new LibraryDatabase(file)
  assert.equal(current.sql.prepare('PRAGMA user_version').get()!.user_version, 28)
  assert.deepEqual(current.tagsList({}), tags)
  assert.deepEqual(current.getMetadata(), metadata)
  assert.deepEqual(current.ratingsDetail(entityId), rating)
  assert.deepEqual(current.preferencesPlaylistsLoad(), lists)
  assert.deepEqual(current.preferencesPlaylistsMigrationReceipt(), receipt)
  const saved = current.focusSavedCreate({ name: '四星以上', savedRevision: 0,
    query: { version: 1, entity: 'recording', where: { rating: { target: 'self', mode: 'personal', gteStars: 4 } } } }, 104)
  assert.equal(current.focusQuery({ query: saved.item.query }).total, 1)
  assert.deepEqual(current.sql.prepare('PRAGMA foreign_key_check').all(), [])
  current.close()
  const backups = readdirSync(root).filter(name => name.includes('.v25-backup-'))
  assert.equal(backups.length, 1)
  const snapshot = new DatabaseSync(join(root, backups[0]))
  assert.equal(snapshot.prepare('PRAGMA user_version').get()!.user_version, 25)
  assert.equal(snapshot.prepare('SELECT count(*) n FROM personal_tags').get()!.n, 1)
  assert.equal(snapshot.prepare("SELECT count(*) n FROM sqlite_master WHERE name='personal_focus_queries'").get()!.n, 0)
  snapshot.close()
  const reopened = new LibraryDatabase(file)
  assert.deepEqual(reopened.focusSavedList({}).items, [saved.item])
  reopened.close()
  assert.equal(readdirSync(root).filter(name => name.includes('.v25-backup-')).length, 1)
})

test('failed Focus schema install rolls back and incomplete current schema is rejected', t => {
  const root = mkdtempSync(join(tmpdir(), 'focus-failure-')), file = join(root, 'library.sqlite')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const old = new LibraryDatabase(file)
  old.sql.exec(LEGACY_FOCUS_SCHEMA_SQL + 'PRAGMA user_version=25; CREATE TABLE personal_focus_queries(incompatible TEXT);')
  old.close()
  assert.throws(() => new LibraryDatabase(file))
  const raw = new DatabaseSync(file)
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 25)
  raw.exec('DROP TABLE personal_focus_queries;')
  raw.close()
  const repaired = new LibraryDatabase(file)
  repaired.sql.exec('DROP TABLE personal_focus_queries')
  repaired.close()
  assert.throws(() => new LibraryDatabase(file), /incomplete/)
})
