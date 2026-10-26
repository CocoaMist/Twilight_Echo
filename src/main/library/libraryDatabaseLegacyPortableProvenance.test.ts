import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryDatabase } from './libraryDatabase.ts'
import { LegacyMusicProvenance } from './legacyMusicProvenance.ts'
import { MUSIC_BACKUP_MAX_BYTES, type MusicPersonalBackupDocument } from '../../shared/musicPersonalBackup.ts'

const PLUGIN = 'com.twilightecho.experience.rhine-lab'
const SOURCE = { name: 'Old platform', url: 'https://example.com/platform' }
function fixture(t: test.TestContext, seed = true) {
  const root = mkdtempSync(join(tmpdir(), 'legacy-portable-provenance-'))
  const db = new LibraryDatabase(join(root, 'library.sqlite'))
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  if (seed) {
    const revision = db.queryCollections('albums').revision
    db.legacyMusicBegin(PLUGIN, 1, { albums: {} }, 2, revision)
    db.legacyMusicStage({ pluginId: PLUGIN, sourceRevision: 1, contentRevision: revision, entries: [
      { id: 'manual-album', value: { title: 'Manual album', description: 'Uncertain old body', descriptionSource: SOURCE } },
      { id: 'old-album', value: { title: 'Old album', description: 'Separate uncertain body', descriptionSource: SOURCE } }
    ] })
    db.legacyMusicPublish(PLUGIN, 1, revision)
  }
  return db
}
function edit(db: LibraryDatabase, id: string, patch: Record<string, unknown>) {
  const document = db.legacyMusicRead(PLUGIN)!
  Object.assign((document.value.albums as Record<string, Record<string, unknown>>)[id], patch)
  return db.legacyMusicEdit(PLUGIN, document)
}
function value(db: LibraryDatabase, id: string) {
  return (db.legacyMusicRead(PLUGIN)!.value.albums as Record<string, Record<string, unknown>>)[id]
}
function current(data: MusicPersonalBackupDocument, id: string): Record<string, unknown> {
  return JSON.parse(String(data.records.legacyAlbums.find(row => row.legacy_id === id)!.payload))
}
function historical(data: MusicPersonalBackupDocument, revision: number, id: string): Record<string, unknown> {
  return JSON.parse(String(data.records.legacyHistory.find(row => row.revision === revision)!.payload)).albums[id]
}
function restore(db: LibraryDatabase, music: MusicPersonalBackupDocument) {
  return db.musicBackupRestore({ restoreId: 'legacy-provenance-transfer', conflict: 'use-backup', music,
    expectedRevision: db.musicBackupRevision(), now: 100 })
}

test('portable export keeps every proven handwritten history, rejects uncertain text, and honours explicit exclusion', t => {
  const db = fixture(t)
  edit(db, 'manual-album', { description: 'First handwritten body' })
  edit(db, 'manual-album', { description: 'Second handwritten body' })
  edit(db, 'manual-album', { localNote: 'Checkpoint without a body change' })
  let data = db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  assert.equal(current(data, 'manual-album').description, 'Second handwritten body')
  assert.equal(historical(data, 2, 'manual-album').description, 'First handwritten body')
  assert.equal(historical(data, 3, 'manual-album').description, 'Second handwritten body')
  assert.equal(historical(data, 1, 'manual-album').description, undefined)
  assert.equal(current(data, 'old-album').description, undefined)
  assert.equal(JSON.stringify(data).includes('Old platform'), false, 'stale provider attribution is not the author of a handwritten body')
  const revision = db.legacyMusicRead(PLUGIN)!.revision
  db.legacyMusicProvenanceReview(PLUGIN, { expectedRevision: revision, albumId: 'manual-album', snapshotRevision: -1,
    description: 'Second handwritten body', disposition: 'excluded' })
  data = db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  assert.equal(current(data, 'manual-album').description, undefined, 'explicit exclusion overrides the old edit-pair inference')
  assert.equal(historical(data, 3, 'manual-album').description, 'Second handwritten body', 'current exclusion does not relabel another history')
  assert.equal(value(db, 'manual-album').description, 'Second handwritten body', 'exclusion does not delete source data')
})

test('confirming one old history migrates only that snapshot and survives a real new-machine restore/re-export', async t => {
  const a = fixture(t), b = fixture(t, false)
  edit(a, 'manual-album', { description: 'First handwritten body' })
  edit(a, 'manual-album', { description: 'Second handwritten body' })
  a.legacyMusicProvenanceReview(PLUGIN, { expectedRevision: a.legacyMusicRead(PLUGIN)!.revision,
    albumId: 'old-album', snapshotRevision: 2, description: 'Separate uncertain body', disposition: 'manual' })
  const data = a.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  assert.equal(current(data, 'old-album').description, undefined)
  assert.equal(historical(data, 1, 'old-album').description, undefined)
  assert.equal(historical(data, 2, 'old-album').description, 'Separate uncertain body')
  await restore(b, data)
  const exported = b.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  assert.equal(current(exported, 'manual-album').description, 'Second handwritten body')
  assert.equal(historical(exported, 2, 'manual-album').description, 'First handwritten body')
  assert.equal(historical(exported, 2, 'old-album').description, 'Separate uncertain body')
  assert.equal(JSON.stringify(exported).includes('Old platform'), false)
  const document = b.legacyMusicRestore(PLUGIN, 2, b.legacyMusicRead(PLUGIN)!.revision)
  const provenance = new LegacyMusicProvenance(b.sql)
  const restored = (document.value.albums as Record<string, unknown>)['manual-album']
  assert.equal(provenance.disposition(PLUGIN, 'manual-album', -1, restored), 'manual')
  assert.equal(value(b, 'manual-album').description, 'First handwritten body')
  assert.equal(value(b, 'manual-album').descriptionSource, undefined)
  assert.equal(b.legacyMusicProvenanceList(PLUGIN).total, 0, 'safe portable fields do not become new ambiguous provider-marked bodies')
})

test('manual missing-field clears stay explicit through portable restore', async t => {
  const a = fixture(t), b = fixture(t, false)
  edit(a, 'manual-album', { description: 'Before clear' })
  const document = a.legacyMusicRead(PLUGIN)!
  delete (document.value.albums as Record<string, Record<string, unknown>>)['manual-album'].description
  a.legacyMusicEdit(PLUGIN, document)
  const data = a.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  assert.equal(current(data, 'manual-album').description, null)
  await restore(b, data)
  assert.equal(value(b, 'manual-album').description, null)
  assert.equal(current(b.musicBackupExport(MUSIC_BACKUP_MAX_BYTES), 'manual-album').description, null)
})

test('restoring an unverified old history cannot bypass portable text filtering through the legacy input-pair heuristic', t => {
  const db = fixture(t)
  edit(db, 'manual-album', { description: 'Handwritten replacement' })
  const document = db.legacyMusicRestore(PLUGIN, 1, db.legacyMusicRead(PLUGIN)!.revision)
  assert.equal(value(db, 'manual-album').description, 'Uncertain old body')
  assert.equal(new LegacyMusicProvenance(db.sql).disposition(PLUGIN, 'manual-album', -1, value(db, 'manual-album')), 'unverified')
  let data = db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  assert.equal(current(data, 'manual-album').description, undefined)
  const pending = db.legacyMusicProvenanceList(PLUGIN).items.find(item => item.albumId === 'manual-album' && item.snapshotRevision === -1)!
  assert.equal(pending.disposition, 'pending')
  db.legacyMusicProvenanceReview(PLUGIN, { expectedRevision: document.revision, albumId: 'manual-album', snapshotRevision: -1,
    description: pending.description, disposition: 'manual' })
  data = db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  assert.equal(current(data, 'manual-album').description, 'Uncertain old body', 'only explicit user confirmation makes the restored body portable')
})

test('external-ai import sources keep their original contract; a later handwritten replacement loses stale attribution', async t => {
  const a = fixture(t), b = fixture(t, false)
  const source = { name: 'User supplied reference', url: 'https://example.com/reference', method: 'external-ai', importedAt: '2026-10-24', batchId: 'one',
    references: [{ name: 'User supplied reference', url: 'https://example.com/reference' }] }
  edit(a, 'manual-album', { description: 'Imported introduction', descriptionSource: source })
  const data = a.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  assert.deepEqual(current(data, 'manual-album').descriptionSource, source)
  await restore(b, data)
  assert.deepEqual(current(b.musicBackupExport(MUSIC_BACKUP_MAX_BYTES), 'manual-album').descriptionSource, source)
  edit(b, 'manual-album', { description: 'My own replacement' })
  const after = current(b.musicBackupExport(MUSIC_BACKUP_MAX_BYTES), 'manual-album')
  assert.equal(after.description, 'My own replacement')
  assert.equal(after.descriptionSource, undefined)
})

test('portable clear restoration reconciles a new same-entity conflict with another local original ID', async t => {
  const a = fixture(t, false), b = fixture(t, false)
  const prepare = (db: LibraryDatabase, id: string, description: string) => {
    db.replaceDocument({ version: 2, revision: 1, folders: [], exclusions: [], tracks: [{
      id: 'track', filePath: 'D:/Music/album/song.flac', source: 'local', title: 'Song', artist: 'Artist', album: 'Album'
    }] })
    while (db.catalogStatus().localPending) db.catalogAdvance()
    const collection = db.queryCollections('albums').items[0]
    const revision = db.getContentRevision()
    db.legacyMusicBegin(PLUGIN, 1, { albums: {} }, 1, revision)
    db.legacyMusicStage({ pluginId: PLUGIN, sourceRevision: 1, contentRevision: revision,
      entries: [{ id, collectionId: collection.id, value: { description, descriptionSource: SOURCE } }] })
    db.legacyMusicPublish(PLUGIN, 1, revision)
    return db.catalogQuery({ kind: 'release' }).items[0].id
  }
  prepare(a, 'manual-album', 'Before manual clear')
  const id = prepare(b, 'another-local-original-id', 'Retained local body')
  edit(a, 'manual-album', { description: null })
  b.sql.prepare('INSERT INTO metadata_entities VALUES(?,?,?,?,?)').run('target', 'musicbrainz', 'release', '11111111-1111-4111-8111-111111111111', 'Album')
  b.sql.prepare('INSERT INTO metadata_subjects(id) VALUES(?)').run(id)
  b.sql.prepare('INSERT INTO metadata_identity_refs VALUES(?,?,?,?,?)').run('musicbrainz', 'release', 'mbid', '11111111-1111-4111-8111-111111111111', 'target')
  b.sql.prepare('INSERT INTO metadata_identity_links VALUES(?,?,?,?,?,?)').run('release-link', id, 'release', 1, 'target', 'confirmed')
  b.sql.prepare('INSERT INTO metadata_facts VALUES(?,?,?,?,?)').run('target', 'wikipedia', 'introduction', 'en', JSON.stringify({
    field: 'introduction', value: 'Automatic provider body', language: 'en', attribution: { provider: 'wikipedia', externalId: 'page',
      url: 'https://example.com', license: '', licenseUrl: '', attribution: 'Wikipedia', revision: '1', retrievedAt: 1 }
  }))
  assert.equal(b.metadataDetail(id, 'en').introduction?.value, 'Automatic provider body')
  await restore(b, a.musicBackupExport(MUSIC_BACKUP_MAX_BYTES))
  const inventory = b.legacyMusicInventory(PLUGIN)
  assert.equal(inventory.items.find(item => item.id === 'manual-album')!.disposition, 'conflict')
  assert.equal(inventory.items.find(item => item.id === 'another-local-original-id')!.disposition, 'conflict')
  const detail = b.metadataDetail(id, 'en')
  assert.equal(detail.imports!.length, 2)
  assert.equal(detail.introduction, null)
  assert.equal(detail.facts[0].value, 'Automatic provider body', 'the provider fact remains cached but cannot undo the explicit clear')
})
