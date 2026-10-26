import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryDatabase } from './libraryDatabase.ts'
import { MUSIC_BACKUP_MAX_BYTES, validateMusicPersonalBackup, type MusicPersonalBackupDocument } from '../../shared/musicPersonalBackup.ts'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII='
const language = 'en' as const
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'personal-metadata-backup-')), db = new LibraryDatabase(join(dir, 'library.sqlite'))
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [
    { id: 'one', source: 'local', filePath: 'D:/Music/one.flac', title: 'One', artist: 'Artist', album: 'Album' }
  ] })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const artist = db.catalogQuery({ kind: 'artist' }).items[0].id
  return { db, artist }
}
const restore = (db: LibraryDatabase, data: MusicPersonalBackupDocument, id: string, conflict: 'keep-local' | 'use-backup' = 'use-backup') =>
  db.musicBackupRestore({ restoreId: id, conflict, music: data, expectedRevision: db.musicBackupRevision(), now: 100 })

test('personal images and metadata source preferences survive portable restore/re-export, with explicit clears and CAS fences', async t => {
  const a = fixture(t), b = fixture(t)
  a.db.metadataArtworkOverride({ entityId: a.artist, revision: 0, language, mode: 'value', dataUrl: png }, 10)
  a.db.metadataSourcePreference({ entityId: a.artist, revision: 1, language, provider: 'wikipedia' }, 11)
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  assert.equal(validateMusicPersonalBackup(data), true)
  assert.equal(data.records.artworkOverrides!.length, 1)
  assert.equal(data.records.sourcePreferences![0].provider, 'wikipedia')
  const mapping = b.db.musicBackupPreview(data).mappings.find(m => m.incomingId === a.artist)!
  await restore(b.db, data, 'assets')
  const detail = b.db.metadataDetail(mapping.targetId, language)
  assert.equal(detail.manualArtwork?.dataUrl, png)
  assert.equal(detail.sourcePreference?.provider, 'wikipedia')
  assert.equal(detail.sourcePreference?.available, false, 'preference does not grant a missing source')
  const again = b.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  assert.deepEqual(again.records.artworkOverrides!.map(r => r.payload), data.records.artworkOverrides!.map(r => r.payload))
  assert.equal(b.db.musicBackupPreview().current, Object.values(again.records).reduce((n, rows) => n + rows.length, 0))
  const before = b.db.musicBackupRevision()
  b.db.metadataArtworkOverride({ entityId: mapping.targetId, revision: detail.revision, language, mode: 'clear' }, 20)
  assert.ok(b.db.musicBackupRevision().metadata > before.metadata)
  await restore(b.db, data, 'keep-cleared', 'keep-local')
  assert.equal(b.db.metadataDetail(mapping.targetId, language).artworkOverride?.mode, 'clear')
  await restore(b.db, data, 'replace-clear')
  assert.equal(b.db.metadataDetail(mapping.targetId, language).manualArtwork?.dataUrl, png)
  a.db.metadataArtworkOverride({ entityId: a.artist, revision: 2, language, mode: 'clear' }, 30)
  a.db.metadataSourcePreference({ entityId: a.artist, revision: 3, language, provider: null }, 31)
  const cleared = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  await restore(b.db, cleared, 'clear-assets')
  assert.equal(b.db.metadataDetail(mapping.targetId, language).artworkOverride?.mode, 'clear')
  assert.equal(b.db.metadataDetail(mapping.targetId, language).sourcePreference?.provider, null)
  assert.equal(JSON.stringify(cleared).includes(png), false)
  await assert.rejects(b.db.musicBackupRestore({ restoreId: 'stale-assets', conflict: 'use-backup', music: data, expectedRevision: before }), { code: 'STALE_REVISION' })
})

test('older music v1 without additive assets remains readable; malformed or non-owned image resources cannot restore', async t => {
  const a = fixture(t), b = fixture(t)
  const old = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  delete old.records.artworkOverrides; delete old.records.sourcePreferences
  assert.equal(validateMusicPersonalBackup(old), true)
  b.db.metadataArtworkOverride({ entityId: b.artist, revision: 0, language, mode: 'value', dataUrl: png }, 20)
  await restore(b.db, old, 'old-v1')
  assert.equal(b.db.metadataDetail(b.artist, language).manualArtwork?.dataUrl, png, 'absent additive authorities never clear an existing personal image')
  const data = structuredClone(old)
  data.records.artworkOverrides = [{ entity_id: a.artist, payload: JSON.stringify({ mode: 'value', dataUrl: 'https://private.invalid/image', updatedAt: 1 }) }]
  assert.equal(validateMusicPersonalBackup(data), false)
  const nullRecord = { ...old, records: { ...old.records, artworkOverrides: null } }
  assert.equal(validateMusicPersonalBackup(nullRecord), false, 'optional means absent, not an invalid null collection')
  data.records.artworkOverrides[0].payload = JSON.stringify({ mode: 'value', dataUrl: png, updatedAt: 1, providerContext: 'session' })
  assert.equal(validateMusicPersonalBackup(data), false)
  data.records.artworkOverrides[0].payload = JSON.stringify({ mode: 'clear', updatedAt: 1 })
  data.records.artworkOverrides[0].entity_id = 'missing'
  assert.equal(validateMusicPersonalBackup(data), false)
})

test('newer dictionary restores preserve local builtin definitions and exact referenced future nodes', async t => {
  const a = fixture(t), b = fixture(t)
  a.db.sql.exec("UPDATE music_genre_state SET value='2' WHERE key='dictionary_version'; UPDATE music_genres SET dictionary_version=2,name='Future Jazz',parent_id='genre:pop' WHERE id='genre:jazz'; INSERT INTO music_genres VALUES('genre:future','Future','Future','genre:jazz',2,0); INSERT INTO music_genre_aliases VALUES('*','future','Future','genre:future',0,1,0)")
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES), preview = b.db.musicBackupPreview(data)
  assert.ok(preview.dependencies.includes('genres:cross-dictionary'))
  await restore(b.db, data, 'future-dictionary')
  assert.equal(b.db.genresTree({}).dictionaryVersion, 1)
  const jazz = b.db.sql.prepare("SELECT * FROM music_genres WHERE id='genre:jazz'").get()!
  assert.equal(jazz.name, '爵士'); assert.equal(jazz.parent_id, null); assert.equal(jazz.dictionary_version, 1)
  const future = b.db.sql.prepare("SELECT * FROM music_genres WHERE id='genre:future'").get()!
  assert.equal(future.parent_id, 'genre:jazz'); assert.equal(future.dictionary_version, 2)
  assert.equal(b.db.sql.prepare("SELECT genre_id FROM music_genre_aliases WHERE normalized='future'").get()!.genre_id, 'genre:future')
  assert.equal(b.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES).records.genres.find(r => r.id === 'genre:future')!.dictionary_version, 2)
  assert.deepEqual(b.db.sql.prepare('PRAGMA foreign_key_check').all(), [])
})

test('older dictionary user edits obey keep/use while local dictionary version never downgrades', async t => {
  const a = fixture(t), b = fixture(t)
  a.db.sql.exec("UPDATE music_genres SET name='My Jazz',parent_id='genre:blues',user_modified=1 WHERE id='genre:jazz'")
  b.db.sql.exec("UPDATE music_genre_state SET value='3' WHERE key='dictionary_version'; UPDATE music_genres SET name='Latest Jazz',dictionary_version=3 WHERE id='genre:jazz'")
  const data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  await restore(b.db, data, 'keep-taxonomy', 'keep-local')
  assert.equal(b.db.sql.prepare("SELECT name FROM music_genres WHERE id='genre:jazz'").get()!.name, 'Latest Jazz')
  await restore(b.db, data, 'use-taxonomy')
  assert.equal(b.db.sql.prepare("SELECT name FROM music_genres WHERE id='genre:jazz'").get()!.name, 'My Jazz')
  assert.equal(b.db.sql.prepare("SELECT parent_id FROM music_genres WHERE id='genre:jazz'").get()!.parent_id, 'genre:blues')
  assert.equal(b.db.genresTree({}).dictionaryVersion, 3)
})

test('future alias normalization, missing parents and mixed cross-version cycles are rejected before publishing', async t => {
  const a = fixture(t), b = fixture(t), data = a.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  data.dictionaryVersion = 2
  data.records.genreAliases[0].normalization_version = 2
  assert.equal(validateMusicPersonalBackup(data), true)
  assert.ok(b.db.musicBackupPreview(data).referenceConflicts.some(c => c.kind === 'genre-alias'))
  const before = b.db.musicBackupRevision()
  await assert.rejects(restore(b.db, data, 'unsupported-normalization'), { code: 'IDENTITY_CONFLICT' })
  assert.deepEqual(b.db.musicBackupRevision(), before)
  data.records.genreAliases[0].normalization_version = 1
  data.records.genres.find(r => r.id === 'genre:jazz')!.parent_id = 'missing-parent'
  assert.equal(validateMusicPersonalBackup(data), false)
  data.records.genres.find(r => r.id === 'genre:jazz')!.parent_id = 'genre:blues'
  data.records.genres.find(r => r.id === 'genre:jazz')!.user_modified = 1
  b.db.sql.exec("UPDATE music_genres SET parent_id='genre:jazz' WHERE id='genre:blues'")
  assert.equal(validateMusicPersonalBackup(data), true)
  assert.ok(b.db.musicBackupPreview(data).referenceConflicts.some(c => c.kind === 'genre'))
  await assert.rejects(restore(b.db, data, 'cross-version-cycle'), { code: 'IDENTITY_CONFLICT' })
})
