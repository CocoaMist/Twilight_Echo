import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LibraryDatabase } from './libraryDatabase.ts'
import { LEGACY_TAG_SCHEMA_SQL } from './legacyQueueSchema.fixture.ts'
import type { TrackData } from '../../shared/track.ts'

test('v24 tags upgrade retains ratings, preference receipts and playlist occurrences in a WAL-consistent snapshot', t => {
  const root = mkdtempSync(join(tmpdir(), 'tags-v24-')), file = join(root, 'library.sqlite')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const track: TrackData = { id: 'one', source: 'local', filePath: join(root, 'one.flac'), fileName: 'one.flac',
    title: 'One', artist: 'Artist', album: 'Album', duration: 200, size: 1, cover: null, lyrics: null }
  const old = new LibraryDatabase(file)
  old.replaceDocument({ version: 2, revision: 0, folders: [root], exclusions: [], tracks: [track] })
  while (old.catalogStatus().localPending) old.catalogAdvance()
  const entityId = old.catalogQuery({ kind: 'recording' }).items[0].id
  const rating = old.ratingsSet({ entityId, token: old.ratingsDetail(entityId).token, steps: 8 }, 100)
  const playlists = old.preferencesPlaylistsMigrate({ version: 2, revision: 4, savedAt: 'old', data: [
    { id: 'original', name: 'Favorites', createdAt: 'old', isDefault: true, trackIds: [track.id], trackSnapshots: { [track.id]: track } },
    { id: 'ordinary', name: 'Ordinary', createdAt: 'old', trackIds: [track.id, track.id] }
  ] }, 101, { logicalMemberCount: 1 })
  const preference = old.preferencesDetail(entityId), receipt = old.preferencesPlaylistsMigrationReceipt()
  const metadata = old.getMetadata(), catalog = old.catalogStatus(), tracks = old.getTracksByIds([track.id])
  old.sql.exec(LEGACY_TAG_SCHEMA_SQL + 'PRAGMA user_version=24;')
  old.close()

  const current = new LibraryDatabase(file)
  assert.equal(current.sql.prepare('PRAGMA user_version').get()!.user_version, 29)
  assert.deepEqual(current.getMetadata(), metadata)
  assert.deepEqual(current.catalogStatus(), catalog)
  assert.deepEqual(current.getTracksByIds([track.id]), tracks)
  assert.deepEqual(current.ratingsDetail(entityId), rating)
  assert.deepEqual(current.preferencesDetail(entityId), preference)
  assert.deepEqual(current.preferencesPlaylistsLoad(), playlists)
  assert.deepEqual(current.preferencesPlaylistsMigrationReceipt(), receipt)
  assert.equal(current.tagsState().tagsRevision, 0)
  const { tag } = current.tagsCreate({ name: '夜晚', tagsRevision: 0 }, 102)
  const result = current.tagsMemberSet({ tagId: tag.id, entityId, present: true, membersRevision: tag.membersRevision }, 103)
  assert.deepEqual(current.sql.prepare('PRAGMA foreign_key_check').all(), [])
  current.close()

  const backups = readdirSync(root).filter(name => name.includes('.v24-backup-'))
  assert.equal(backups.length, 1)
  const snapshot = new DatabaseSync(join(root, backups[0]))
  assert.equal(snapshot.prepare('PRAGMA user_version').get()!.user_version, 24)
  assert.equal(snapshot.prepare('SELECT steps FROM personal_rating_values').get()!.steps, 8)
  assert.equal(snapshot.prepare('SELECT count(*) n FROM personal_preference_values').get()!.n, 1)
  assert.equal(snapshot.prepare('SELECT migration_receipt FROM personal_preference_playlists').get()!.migration_receipt, JSON.stringify(receipt))
  assert.equal(snapshot.prepare("SELECT count(*) n FROM sqlite_master WHERE name='personal_tags'").get()!.n, 0)
  snapshot.close()
  const reopened = new LibraryDatabase(file)
  assert.deepEqual(reopened.tagsList({}).items, [result.tag])
  assert.equal(reopened.tagsMembers({ tagId: tag.id }).items[0].id, entityId)
  assert.equal(reopened.tagsRecordings({ tagId: tag.id }).total, 1)
  reopened.close()
  assert.equal(readdirSync(root).filter(name => name.includes('.v24-backup-')).length, 1)
})

test('failed v24 tags installation rolls back and incomplete current tags schema is rejected', t => {
  const root = mkdtempSync(join(tmpdir(), 'tags-failure-')), file = join(root, 'library.sqlite')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const old = new LibraryDatabase(file)
  old.sql.exec(LEGACY_TAG_SCHEMA_SQL + 'PRAGMA user_version=24; CREATE TABLE personal_tags(incompatible TEXT);')
  old.close()
  assert.throws(() => new LibraryDatabase(file), /already exists/)
  const raw = new DatabaseSync(file)
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 24)
  assert.equal(raw.prepare("SELECT count(*) n FROM sqlite_master WHERE name='personal_tags_state'").get()!.n, 0)
  raw.exec('DROP TABLE personal_tags')
  raw.close()
  const repaired = new LibraryDatabase(file)
  repaired.sql.exec('DROP INDEX personal_tag_members_entity')
  repaired.close()
  assert.throws(() => new LibraryDatabase(file), /incomplete/)
})
