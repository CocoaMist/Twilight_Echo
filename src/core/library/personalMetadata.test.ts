import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { CoreEntityMetadataService } from './entityMetadataService.ts'
import type { EntityMetadataDatabaseApi, EntityMetadataFact } from '../../shared/entityMetadata.ts'
import { MusicBrainzWikiProvider } from './entityMetadataProvider.ts'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII='
const policy = { enabled: false, publicServiceApproved: false, wikipediaText: false, contact: '' }
const fact = (provider: string, value: string, extra: Partial<EntityMetadataFact> = {}): EntityMetadataFact => ({
  field: 'introduction', value, language: 'en', attribution: { provider, externalId: provider,
    url: 'https://example.com', license: '', licenseUrl: '', attribution: provider, revision: '1', retrievedAt: 1 }, ...extra
})
function seed(db: LibraryDatabase) {
  db.replaceDocument({ version: 2, revision: 1, folders: [], exclusions: [], tracks: [{ id: 'track',
    title: 'Song', artist: 'Artist', album: 'Album', duration: 1, size: 0, cover: null, lyrics: null,
    source: 'local', filePath: 'D:/music/song.flac', fileName: 'song.flac' }] })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  return db.catalogQuery({ kind: 'artist' }).items[0].id
}
function put(db: LibraryDatabase, item: EntityMetadataFact) {
  db.sql.prepare('INSERT OR REPLACE INTO metadata_facts VALUES(?,?,?,?,?)').run('target', item.attribution.provider, item.field, item.language, JSON.stringify(item))
}
function linked(db: LibraryDatabase, id: string) {
  db.sql.prepare('INSERT INTO metadata_entities VALUES(?,?,?,?,?)').run('target', 'musicbrainz', 'artist', 'external', 'Artist')
  db.sql.prepare('INSERT INTO metadata_subjects VALUES(?,?,?,?,?)').run(id, 0, 'target', '', 'confirmed')
}
const asyncDb = (db: LibraryDatabase): EntityMetadataDatabaseApi => new Proxy({} as EntityMetadataDatabaseApi, {
  get: (_, key: keyof EntityMetadataDatabaseApi) => async (...args: unknown[]) => (db[key] as (...args: unknown[]) => unknown).apply(db, args)
})
function service(db: EntityMetadataDatabaseApi, changed: () => void = () => {}) {
  return new CoreEntityMetadataService({ database: db, provider: new MusicBrainzWikiProvider(() => policy,
    async () => { throw new Error('personal metadata must not fetch') }), policy: () => policy, now: () => 100, changed, failed: error => { throw error } })
}

test('personal image authority persists without identity or provider enablement, fences stale writes and resets explicitly', async t => {
  const root = mkdtempSync(join(tmpdir(), 'personal-artwork-')), path = join(root, 'library.sqlite')
  let db = new LibraryDatabase(path)
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  const id = seed(db)
  let changes = 0, core = service(asyncDb(db), () => changes++)
  const saved = await core.artworkOverride({ entityId: id, revision: 0, mode: 'value', dataUrl: png, language: 'en' })
  assert.equal(saved.manualArtwork?.dataUrl, png)
  assert.equal(saved.manualArtwork?.width, 1)
  assert.equal(saved.targetId, null)
  assert.equal(changes, 1)
  await assert.rejects(core.artworkOverride({ entityId: id, revision: 0, mode: 'clear', language: 'en' }), { code: 'STALE_REVISION' })
  assert.equal((await core.detail(id, 'en')).manualArtwork?.dataUrl, png)
  await core.shutdown(); db.close(); db = new LibraryDatabase(path); core = service(asyncDb(db))
  assert.equal((await core.detail(id, 'en')).manualArtwork?.dataUrl, png)
  const cleared = await core.artworkOverride({ entityId: id, revision: 1, mode: 'clear', language: 'en' })
  assert.deepEqual(cleared.artworkOverride, { mode: 'clear' })
  assert.equal(cleared.manualArtwork, null)
  const reset = await core.artworkOverride({ entityId: id, revision: 2, mode: 'reset', language: 'en' })
  assert.equal(reset.artworkOverride, null)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM metadata_artwork_overrides').get()!.n, 0)
  await core.shutdown()
})

test('per-entity source preference selects only authorised facts, keeps unavailable choice and never overrides manual prose', t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  const id = seed(db); linked(db, id)
  put(db, fact('wikipedia', 'Wiki'))
  put(db, fact('ncm', 'Platform', { sourceProvider: 'ncm', providerContext: 'account1',
    usage: { display: true, cache: true, crossSource: false, export: false, expiresAt: 500 } }))
  let detail = db.metadataSourcePreference({ entityId: id, revision: 0, provider: 'ncm', language: 'en' }, 100)
  assert.equal(detail.introduction?.value, 'Wiki')
  assert.deepEqual(detail.sourcePreference, { provider: 'ncm', available: false })
  detail = db.metadataDetail(id, 'en', { platformContexts: { ncm: 'account1' }, now: 100 })
  assert.equal(detail.introduction?.value, 'Wiki', 'preference does not grant cross-source rights')
  put(db, fact('ncm', 'Platform', { sourceProvider: 'ncm', providerContext: 'account1',
    usage: { display: true, cache: true, crossSource: true, export: false, expiresAt: 500 } }))
  detail = db.metadataDetail(id, 'en', { platformContexts: { ncm: 'account1' }, now: 100 })
  assert.equal(detail.introduction?.value, 'Platform')
  assert.equal(detail.sourcePreference?.available, true)
  assert.deepEqual(detail.sourceOptions, ['ncm', 'wikipedia'])
  assert.equal(db.metadataDetail(id, 'en', { platformContexts: { ncm: 'other' }, now: 100 }).introduction?.value, 'Wiki')
  db.metadataOverride({ entityId: id, revision: 1, mode: 'value', value: 'Mine', language: 'en' }, 101)
  assert.equal(db.metadataDetail(id, 'en', { platformContexts: { ncm: 'account1' }, now: 100 }).introduction?.value, 'Mine')
  db.metadataOverride({ entityId: id, revision: 2, mode: 'reset', language: 'en' }, 102)
  assert.equal(db.metadataDetail(id, 'en', { platformContexts: { ncm: 'account1' }, now: 500 }).introduction?.value, 'Wiki')
  assert.deepEqual(db.metadataDetail(id, 'en').sourcePreference, { provider: 'ncm', available: false })
  assert.throws(() => db.metadataSourcePreference({ entityId: id, revision: 1, provider: null, language: 'en' }, 103), { code: 'STALE_REVISION' })
  assert.equal(db.metadataSourcePreference({ entityId: id, revision: 3, provider: null, language: 'en' }, 103).sourcePreference?.provider, null)
})

test('Core personal artwork suppresses external grant projection', async t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  const id = seed(db); linked(db, id)
  db.metadataArtworkOverride({ entityId: id, revision: 0, mode: 'clear', language: 'en' }, 100)
  const original = asyncDb(db), database = { ...original, metadataArtwork: original.metadataArtwork } as EntityMetadataDatabaseApi
  let projections = 0
  database.metadataDetail = original.metadataDetail
  database.metadataArtwork = async (...args) => { projections++; return original.metadataArtwork(...args) }
  const core = new CoreEntityMetadataService({ database, provider: new MusicBrainzWikiProvider(() => policy),
    enrichmentProviders: () => [{ id: 'public-artwork', supports: () => true, blockedReason: () => null, context: () => 'art',
      enrich: async () => ({ facts: [], availability: 'not_found' }) }],
    artwork: async () => { throw new Error('no external image') }, policy: () => policy, now: () => 100, changed() {}, failed() {} })
  t.after(() => core.shutdown())
  assert.equal((await core.detail(id, 'en')).artworkOverride?.mode, 'clear')
  assert.equal(projections, 0)
  db.metadataArtworkOverride({ entityId: id, revision: 1, mode: 'reset', language: 'en' }, 100)
  await core.detail(id, 'en')
  assert.equal(projections, 1, 'reset returns to the existing external reader')
})

test('Core discards authorised facts if platform context changes while the database read is pending', async t => {
  const db = new LibraryDatabase(':memory:'); t.after(() => db.close())
  const id = seed(db); linked(db, id)
  let context = 'account1'
  const original = asyncDb(db)
  const database = { metadataDetail: async (...args: Parameters<EntityMetadataDatabaseApi['metadataDetail']>) => {
    const result = await original.metadataDetail(...args); context = 'account2'; return result
  } } as EntityMetadataDatabaseApi
  const core = new CoreEntityMetadataService({ database, provider: new MusicBrainzWikiProvider(() => policy),
    enrichmentProviders: () => [{ id: 'platform.ncm', supports: () => true, blockedReason: () => null, context: () => context,
      enrich: async () => ({ facts: [], availability: 'not_found' }) }],
    policy: () => policy, now: () => 100, changed() {}, failed() {} })
  t.after(() => core.shutdown())
  await assert.rejects(core.detail(id, 'en'), { code: 'STALE_REVISION' })
})

test('exact Rhine manual text and clear override automatic facts locally and after portable restoration', async t => {
  const root = mkdtempSync(join(tmpdir(), 'personal-clear-'))
  const source = new LibraryDatabase(join(root, 'source.sqlite')), destination = new LibraryDatabase(join(root, 'destination.sqlite'))
  t.after(() => { source.close(); destination.close(); rmSync(root, { recursive: true, force: true }) })
  const prepare = (db: LibraryDatabase) => {
    seed(db)
    const id = db.catalogQuery({ kind: 'release' }).items[0].id
    db.sql.prepare('INSERT INTO metadata_entities VALUES(?,?,?,?,?)').run('target', 'musicbrainz', 'release', '11111111-1111-4111-8111-111111111111', 'Album')
    db.sql.prepare('INSERT INTO metadata_subjects(id) VALUES(?)').run(id)
    db.sql.prepare('INSERT INTO metadata_identity_refs VALUES(?,?,?,?,?)').run('musicbrainz', 'release', 'mbid', '11111111-1111-4111-8111-111111111111', 'target')
    db.sql.prepare('INSERT INTO metadata_identity_links VALUES(?,?,?,?,?,?)').run('release-link', id, 'release', 1, 'target', 'confirmed')
    put(db, fact('wikipedia', 'Automatic album introduction'))
    return id
  }
  const id = prepare(source), destinationId = prepare(destination), plugin = 'test.rhine'
  const revision = source.getContentRevision(), collectionId = source.queryCollections('albums').items[0].id
  source.legacyMusicBegin(plugin, 7, { albums: {} }, 1, revision)
  source.legacyMusicStage({ pluginId: plugin, sourceRevision: 7, contentRevision: revision,
    entries: [{ id: 'old-album', collectionId, value: { description: null, descriptionSource: { name: 'Old platform', url: 'https://example.com' } } }] })
  source.legacyMusicPublish(plugin, 7, revision)
  assert.equal(source.metadataDetail(id, 'en').introduction?.value, 'Automatic album introduction', 'unknown old emptiness is not an explicit clear')
  let document = source.legacyMusicRead(plugin)!
  const album = () => (document.value.albums as Record<string, Record<string, unknown>>)['old-album']
  album().description = 'Handwritten album introduction'
  document = source.legacyMusicEdit(plugin, document)
  assert.equal(source.metadataDetail(id, 'en').introduction?.value, 'Handwritten album introduction')
  assert.equal(source.metadataDetail(id, 'en').imports?.[0].method, 'manual')
  album().description = null
  document = source.legacyMusicEdit(plugin, document)
  assert.equal(source.metadataDetail(id, 'en').introduction, null)
  assert.equal(source.metadataDetail(id, 'en').imports?.[0].descriptionCleared, true)
  const music = source.musicBackupExport(8 * 1024 * 1024)
  await destination.musicBackupRestore({ restoreId: 'manual-clear-roundtrip', conflict: 'use-backup', music,
    expectedRevision: destination.musicBackupRevision(), now: 100 })
  assert.equal(destination.metadataDetail(destinationId, 'en').introduction, null)
  assert.equal(destination.metadataDetail(destinationId, 'en').imports?.[0].descriptionCleared, true)
  assert.equal(destination.metadataDetail(destinationId, 'en').facts[0].value, 'Automatic album introduction', 'clear suppresses the still-existing provider fact')
})
