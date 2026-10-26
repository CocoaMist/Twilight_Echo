import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LibraryDatabase } from './libraryDatabase.ts'
import { libraryTrack } from '../../core/playback/libraryTrack.ts'
import { buildDerivedCollections } from '../../core/library/derivedCollections.ts'
import { fileArtistCredits, type TrackIdentityTags } from '../../shared/trackIdentification.ts'
import type { TrackData } from '../../shared/track.ts'

const tags = (names = ['AC/DC', 'Guest']): TrackIdentityTags => ({
  version: 1, scope: 'audio_file', artists: { value: names, origin: 'audio_tag' }
})
const track = (id: string, extra: Partial<TrackData> = {}): TrackData => ({
  id, title: id, artist: 'AC/DC/Guest', album: 'Album', source: 'local',
  filePath: `D:/Music/${id}.flac`, fileName: `${id}.flac`, duration: 200,
  size: 0, cover: null, lyrics: null, ...extra
})
const drain = (db: LibraryDatabase) => { while (db.catalogStatus().localPending) db.catalogAdvance(1) }
const seed = (db: LibraryDatabase, tracks: TrackData[]) => db.replaceDocument({
  version: 2, revision: 1, tracks, folders: ['D:/Music'], exclusions: []
})

test('file credit projection preserves literal names and never infers IDs or CUE/legacy credits', () => {
  assert.deepEqual(fileArtistCredits(tags([' AC/DC ', 'Guest', 'Guest', 'Earth, Wind & Fire'])),
    [{ name: 'AC/DC' }, { name: 'Guest' }, { name: 'Earth, Wind & Fire' }])
  assert.deepEqual(fileArtistCredits({ ...tags(), musicbrainz: { artistIds: ['one', 'two'], albumArtistIds: [] } }),
    [{ name: 'AC/DC' }, { name: 'Guest' }])
  assert.deepEqual(fileArtistCredits({ ...tags(), scope: 'cue_track' }), [])
  assert.deepEqual(fileArtistCredits({ ...tags(), artists: { value: ['A/B'], origin: 'legacy' } }), [])
  const raw = track('duet', { identityTags: tags() })
  assert.deepEqual(libraryTrack({ ...raw }).artists, [{ name: 'AC/DC' }, { name: 'Guest' }])
  assert.deepEqual(libraryTrack({ ...raw, artists: [{ name: 'Explicit', id: 'known' }] }).artists,
    [{ name: 'Explicit', id: 'known' }])
  assert.deepEqual(buildDerivedCollections([raw], [], '').artists.map(a => a.name).sort(), ['AC/DC', 'Guest'])
})

test('saved multi-value tags align cards, exact queries, albums, catalog identity indexes and queues', t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  seed(db, [track('solo', { artist: 'Guest' }), track('duet', { identityTags: tags() })]); drain(db)
  assert.equal(db.queryCollections('artists', { collectionCountOnly: true }).total, 2)
  assert.deepEqual(db.queryCollections('artists').items.map(a => [a.name, a.trackCount]).sort(), [['AC/DC', 1], ['Guest', 2]])
  assert.equal(db.queryTracks({ artist: 'Guest', limit: 1 }).total, 2)
  assert.equal(db.queryCollections('albums', { artist: 'Guest' }).total, 1)
  assert.equal(db.queryTracks({ artist: 'AC/DC/Guest' }).total, 1, 'old full-credit links still work')
  for (const [index, name] of ['AC/DC', 'Guest'].entries()) {
    const context = { type: 'collection' as const, collection: 'artists' as const, id: name }
    const page = db.catalogQuery({ kind: 'artist', artistName: name, context })
    assert.ok(page.items.length)
    assert.ok(page.items.every(a => a.title === name))
    const duetEntity = page.items.find(a => db.identificationInput(a.id).sources?.some(s => s.trackId === 'duet'))!
    assert.deepEqual(db.identificationInput(duetEntity.id).sources![0].artistIndexes, [index])
  }
  const queue = db.createLibraryQueue({ artist: 'Guest' })
  assert.equal(queue.total, 2)
})

test('old saved tags backfill without rescanning, renaming a composite entity or inheriting its personal data', t => {
  const root = mkdtempSync(join(tmpdir(), 'file-artist-backfill-')), path = join(root, 'library.sqlite')
  let db = new LibraryDatabase(path)
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  seed(db, [track('duet'), track('solo', { artist: 'Guest' })]); drain(db)
  const old = db.catalogQuery({ kind: 'artist', artistName: 'AC/DC/Guest' }).items[0]
  const solo = db.catalogQuery({ kind: 'artist', artistName: 'Guest' }).items[0]
  db.metadataOverride({ entityId: old.id, revision: 0, mode: 'value', value: 'Composite notes', language: 'en' }, 1)
  db.metadataOverride({ entityId: solo.id, revision: 0, mode: 'value', value: 'Solo notes', language: 'en' }, 1)
  const sql = (db as unknown as { sql: DatabaseSync }).sql
  const recording = String(sql.prepare("SELECT recording_id FROM catalog_sources WHERE track_id='duet'").get()!.recording_id)
  const soloRecording = String(sql.prepare("SELECT recording_id FROM catalog_sources WHERE track_id='solo'").get()!.recording_id)
  // Reproduce the old catalog's positional alias and raw tags omitted by its scanner.
  sql.prepare("UPDATE catalog_aliases SET key=? WHERE namespace='source.artist' AND entity_id=?").run(JSON.stringify(['local', recording, 0]), old.id)
  sql.prepare("UPDATE catalog_aliases SET key=? WHERE namespace='source.artist' AND entity_id=?").run(JSON.stringify(['local', soloRecording, 0]), solo.id)
  sql.prepare("UPDATE tracks SET payload=json_set(payload,'$.identityTags',json(?)) WHERE id='duet'").run(JSON.stringify(tags()))
  sql.exec("DELETE FROM catalog_pending; DELETE FROM catalog_state WHERE key LIKE 'file_artist_%_v1';")
  db.close()
  db = new LibraryDatabase(path)
  assert.equal(db.catalogStatus().localPending, true)
  db.catalogAdvance(1)
  assert.equal(db.catalogStatus().localPending, true, 'bounded backfill does not drain two rows at once')
  drain(db)
  const credits = db.catalogQuery({ kind: 'artist', context: { type: 'track', provider: 'local', id: 'duet' } }).items
  assert.deepEqual(credits.map(a => a.title).sort(), ['AC/DC', 'Guest'])
  assert.ok(credits.every(a => a.id !== old.id))
  assert.equal(db.catalogDetail(old.id).entity!.title, 'AC/DC/Guest')
  assert.equal(db.metadataDetail(old.id, 'en').introduction?.value, 'Composite notes')
  assert.ok(credits.every(a => !db.metadataDetail(a.id, 'en').introduction))
  // An unchanged old solo alias is adopted, preserving overrides when next reindexed.
  db.patchTracks([{ id: 'solo', expectedVersion: db.getTracksByIds(['solo']).versions.solo, patch: { title: 'Updated solo' } }]); drain(db)
  const sameSolo = db.catalogQuery({ kind: 'artist', context: { type: 'track', provider: 'local', id: 'solo' } }).items[0]
  assert.equal(sameSolo.id, solo.id)
  assert.equal(db.metadataDetail(sameSolo.id, 'en').introduction?.value, 'Solo notes')
  db.close(); db = new LibraryDatabase(path)
  assert.equal(db.catalogStatus().localPending, false, 'successful backfill does not repeat on reopen')
})
