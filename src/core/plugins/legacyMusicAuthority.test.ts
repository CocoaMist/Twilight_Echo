import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import type { TwilightPluginDescriptor } from '../../shared/pluginTypes.ts'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { LEGACY_MUSIC_METADATA_SQL } from '../../main/library/legacyQueueSchema.fixture.ts'
import type { LegacyMusicAuthorityDatabase } from './legacyMusicAuthority.ts'
import { createLegacyMusicAuthority, legacyExperienceAlbumId } from './legacyMusicAuthority.ts'
import { CorePluginExperiences } from './experiences.ts'
import { createExperienceDocuments } from './experienceDocuments.ts'
import { LegacyMusicProvenance } from '../../main/library/legacyMusicProvenance.ts'
import { LibraryDatabaseLegacyMusic } from '../../main/library/libraryDatabaseLegacyMusic.ts'
import type { MusicAlbum } from '../../shared/rhineMusic.ts'

const PLUGIN = 'com.twilightecho.experience.rhine-lab'
const asyncDb = (db: LibraryDatabase) =>
  new Proxy({} as LegacyMusicAuthorityDatabase, {
    get:
      (_, key) =>
      async (...args: unknown[]) =>
        (db[key as keyof LibraryDatabase] as (...args: unknown[]) => unknown).apply(db, args)
  })
function seed(db: LibraryDatabase) {
  db.replaceDocument({
    version: 2,
    revision: 1,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'one',
        filePath: 'D:/Music/A/one.flac',
        source: 'local',
        title: 'One',
        artist: 'Artist',
        album: 'Album'
      },
      {
        id: 'two',
        filePath: 'D:/Music/B/two.flac',
        source: 'local',
        title: 'Two',
        artist: 'Artist',
        album: 'Album'
      }
    ]
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  return db.queryCollections('albums', { limit: 200 })
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'legacy-authority-')),
    db = new LibraryDatabase(join(root, 'library.sqlite'))
  const albums = seed(db),
    first = albums.items[0],
    id = legacyExperienceAlbumId(first.id)
  const dataDir = join(root, 'plugin')
  await mkdir(dataDir)
  const legacy = {
    revision: 7,
    value: {
      config: { onlineEnabled: false, musicBrainzContact: 'project' },
      proofs: { old: 'edition' },
      genreRules: { untouched: true },
      albums: {
        [id]: {
          description: 'User imported introduction',
          descriptionSource: {
            name: 'Reference',
            url: 'https://example.com/source',
            method: 'external-ai',
            batchId: 'keep-batch',
            importedAt: '2026-01-01',
            references: [{ name: 'Reference', url: 'https://example.com/source' }]
          },
          localNote: 'My note',
          online: { status: 'matched', releaseId: '11111111-1111-4111-8111-111111111111' },
          producers: [
            { name: 'Unconfirmed name', role: 'mix', source: 'QQ Music', trackTitle: 'One' }
          ]
        },
        'album-missing': { description: 'Unassigned introduction', localNote: 'Keep me' }
      }
    }
  }
  const file = join(dataDir, 'music-metadata.json')
  await writeFile(file, JSON.stringify(legacy))
  const plugin = {
    id: PLUGIN,
    enabled: true,
    status: 'enabled',
    permissions: ['ui:inject', 'library:write', 'settings'],
    apiVersion: 4,
    version: '1.0.0',
    type: ['ui'],
    contributes: {
      experiences: [{ id: 'library', name: 'Rhine', entry: 'ui/index.html', bridgeVersion: 2 }]
    },
    paths: { dataDir }
  } as TwilightPluginDescriptor
  const database = asyncDb(db),
    manager = { list: async () => [plugin], listExtensions: async () => [] }
  const service = new CorePluginExperiences(
    manager,
    {
      queryCollections: async (...args) => db.queryCollections(...args),
      queryTracks: async (...args) => db.queryTracks(...args)
    },
    () => false,
    async () => ({ saved: true }),
    database
  )
  t.after(async () => {
    await service.shutdown()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  const entityId = db
    .catalogQuery({ kind: 'release' })
    .items.find((e) =>
      db.catalogSources({ entityId: e.id }).items.some((s) => s.track.title === 'One')
    )!.id
  return { root, db, file, legacy, service, manager, database, entityId, id, albums }
}

test('production experience document moves to main SQLite, preserves original payload and IDs, and stops JSON writes', async (t) => {
  const f = await fixture(t)
  const before = await readFile(f.file, 'utf8')
  assert.deepEqual(await f.service.document(PLUGIN), f.legacy)
  const status = f.db.legacyMusicStatus(PLUGIN)!
  assert.equal(status.state, 'published')
  assert.deepEqual(status.counts, { bound: 1, unassigned: 1, conflicts: 0 })
  const next = structuredClone(f.legacy)
  next.value.albums[f.id].localNote = 'Updated in SQLite'
  const saved = await f.service.document(PLUGIN, next)
  assert.equal(saved.revision, 8)
  assert.equal(await readFile(f.file, 'utf8'), before)
  assert.deepEqual(
    JSON.parse(
      await readFile(join(f.root, 'plugin', 'music-metadata.before-main-library-7.json'), 'utf8')
    ),
    f.legacy
  )
  assert.equal(f.db.legacyMusicInventory(PLUGIN).total, 2)
  assert.equal(f.db.identificationDetail(f.entityId).link?.state ?? 'unresolved', 'unresolved')
  const detail = f.db.metadataDetail(f.entityId, 'en')
  assert.equal(detail.introduction?.origin, 'imported')
  assert.equal(detail.introduction?.value, 'User imported introduction')
  assert.equal(detail.imports?.[0].localNote, 'Updated in SQLite')
  assert.equal(detail.imports?.[0].credits[0].name, 'Unconfirmed name')
  assert.equal(detail.imports?.[0].credits[0].role, 'mix')
  assert.equal(detail.credits, undefined, 'legacy names are not confirmed typed credits')
  assert.deepEqual(f.db.legacyMusicRead(PLUGIN), saved)
  await assert.rejects(f.service.document(PLUGIN, next), /资料或曲库已发生变化/)
  // Editing the legacy file after publication cannot replace newer authority.
  await writeFile(f.file, JSON.stringify({ revision: 99, value: { albums: {} } }))
  assert.deepEqual(await f.service.document(PLUGIN), saved)
})

test('source-scoped imported text does not propagate to unrelated same-title albums and manual overrides retain priority', async (t) => {
  const f = await fixture(t)
  await f.service.document(PLUGIN)
  const releases = f.db.catalogQuery({ kind: 'release' }).items
  const other = releases.find((item) => item.id !== f.entityId)!
  assert.equal(f.db.metadataDetail(other.id, 'en').imports, undefined)
  const detail = f.db.metadataDetail(f.entityId, 'en')
  f.db.metadataOverride(
    { entityId: f.entityId, revision: detail.revision, mode: 'clear', language: 'en' },
    1000
  )
  assert.equal(f.db.metadataDetail(f.entityId, 'en').introduction, null)
  const after = f.db.metadataDetail(f.entityId, 'en')
  f.db.metadataOverride(
    { entityId: f.entityId, revision: after.revision, mode: 'reset', language: 'en' },
    1001
  )
  assert.equal(
    f.db.metadataDetail(f.entityId, 'en').introduction?.value,
    'User imported introduction'
  )
})

test('staging is invisible, bounded, restartable, idempotent and rejects library revision drift', async (t) => {
  const f = await fixture(t),
    revision = f.db.getContentRevision()
  f.db.legacyMusicBegin(PLUGIN, 7, { config: { keep: true }, albums: {} }, 2, revision)
  f.db.legacyMusicStage({
    pluginId: PLUGIN,
    sourceRevision: 7,
    contentRevision: revision,
    entries: [{ id: f.id, value: { description: 'Staged' }, collectionId: f.albums.items[0].id }]
  })
  assert.equal(f.db.legacyMusicRead(PLUGIN), null)
  assert.equal(f.db.metadataDetail(f.entityId, 'en').imports, undefined)
  assert.throws(() => f.db.legacyMusicPublish(PLUGIN, 7, revision), /incomplete/)
  assert.equal(
    f.db.legacyMusicBegin(PLUGIN, 7, { config: { keep: true }, albums: {} }, 2, revision).staged,
    1
  )
  f.db.legacyMusicStage({
    pluginId: PLUGIN,
    sourceRevision: 7,
    contentRevision: revision,
    entries: [
      { id: f.id, value: { description: 'Staged' }, collectionId: f.albums.items[0].id },
      { id: 'missing', value: { localNote: 'Keep' } }
    ]
  })
  assert.equal(f.db.legacyMusicStatus(PLUGIN)?.staged, 2)
  f.db.updateConfiguration({ folders: ['D:/Changed'], exclusions: [] })
  assert.throws(() => f.db.legacyMusicPublish(PLUGIN, 7, revision), { code: 'STALE_REVISION' })
  const current = f.db.getContentRevision()
  assert.equal(f.db.legacyMusicBegin(PLUGIN, 8, {}, 0, current).staged, 0)
  assert.equal(f.db.legacyMusicPublish(PLUGIN, 8, current).state, 'published')
})

test('migration rechecks source content and keeps old authority usable on failure before publication', async (t) => {
  const f = await fixture(t)
  const authority = createLegacyMusicAuthority(f.database, () => false)
  let reads = 0
  await assert.rejects(
    authority.open(
      PLUGIN,
      async () => (++reads === 1 ? f.legacy : { ...f.legacy, revision: 8 }),
      async () => {}
    ),
    /旧资料在迁移期间变化/
  )
  assert.equal(f.db.legacyMusicStatus(PLUGIN)?.state, 'staging')
  assert.equal(f.db.legacyMusicRead(PLUGIN), null)
  assert.deepEqual(await f.service.document(PLUGIN), f.legacy)
  assert.equal(f.db.legacyMusicStatus(PLUGIN)?.state, 'published')
})

test('task, preview and external-ai import use the migrated authority and preserve revision proofs', async (t) => {
  const f = await fixture(t)
  const task = (await f.service.music(PLUGIN, 'task', { scope: 'all' })) as {
    albums: Array<{
      id: string
      title: string
      artist: string
      year?: number
      expectedRevision: string
    }>
  }
  const entry = task.albums.find((album) => album.id === f.id)!
  const result = {
    format: 'rhine-album-introductions-result',
    version: 1,
    albums: [
      {
        id: entry.id,
        title: entry.title,
        artist: entry.artist,
        year: entry.year,
        expectedRevision: entry.expectedRevision,
        status: 'matched',
        description: 'New user imported text',
        sources: [{ name: 'New reference', url: 'https://example.com/new' }]
      }
    ]
  }
  const before = await f.service.document(PLUGIN)
  const preview = (await f.service.music(PLUGIN, 'preview', { result, allowReplace: true })) as {
    canApply: boolean
  }
  assert.equal(preview.canApply, true)
  assert.deepEqual(await f.service.document(PLUGIN), before)
  const imported = (await f.service.music(PLUGIN, 'import', { result, allowReplace: true })) as {
    backup: string
  }
  assert.deepEqual(
    JSON.parse(await readFile(join(f.root, 'plugin', imported.backup), 'utf8')),
    before
  )
  const after = await f.service.document(PLUGIN)
  assert.equal(
    (after.value.albums as Record<string, { description: string }>)[f.id].description,
    'New user imported text'
  )
  assert.equal(f.db.metadataDetail(f.entityId, 'en').introduction?.value, 'New user imported text')
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), f.legacy)
  const history = (await f.service.music(PLUGIN, 'history', {})) as { revisions: number[] }
  assert.ok(history.revisions.includes(before.revision))
  assert.deepEqual(
    await f.service.music(PLUGIN, 'history.read', { revision: before.revision }),
    before
  )
  await assert.rejects(
    f.service.music(PLUGIN, 'restore', {
      revision: before.revision,
      expectedRevision: before.revision
    }),
    { code: 'STALE_REVISION' }
  )
  const restored = (await f.service.music(PLUGIN, 'restore', {
    revision: before.revision,
    expectedRevision: after.revision
  })) as typeof before
  assert.equal(restored.revision, after.revision + 1)
  assert.deepEqual(restored.value, before.value)
  assert.equal(
    f.db.metadataDetail(f.entityId, 'en').introduction?.value,
    'User imported introduction'
  )
})

test('v18 migration uses a consistent backup without damaging old facts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-schema-')),
    path = join(root, 'library.sqlite')
  t.after(() => rm(root, { recursive: true, force: true }))
  const old = new LibraryDatabase(path)
  seed(old)
  old.sql.exec(`${LEGACY_MUSIC_METADATA_SQL} PRAGMA user_version=18;`)
  old.close()
  const upgraded = new LibraryDatabase(path)
  assert.equal(upgraded.sql.prepare('PRAGMA user_version').get()!.user_version, 29)
  upgraded.close()
  const backup = (await readdir(root)).find((name) => name.includes('.v18-backup-'))!
  const snapshot = new DatabaseSync(join(root, backup), { readOnly: true })
  assert.equal(snapshot.prepare('PRAGMA user_version').get()!.user_version, 18)
  assert.equal(snapshot.prepare('SELECT count(*) n FROM tracks').get()!.n, 2)
  snapshot.close()
})

test('v19 legacy DDL failure rolls back the complete migration and leaves its v18 snapshot usable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-ddl-failure-')),
    path = join(root, 'library.sqlite')
  t.after(() => rm(root, { recursive: true, force: true }))
  const old = new LibraryDatabase(path)
  seed(old)
  old.sql.exec(
    `${LEGACY_MUSIC_METADATA_SQL} CREATE VIEW metadata_legacy_albums AS SELECT 1; PRAGMA user_version=18;`
  )
  old.close()
  assert.throws(() => new LibraryDatabase(path), /already exists/)
  const source = new DatabaseSync(path, { readOnly: true })
  assert.equal(source.prepare('PRAGMA user_version').get()!.user_version, 18)
  assert.equal(source.prepare('SELECT count(*) n FROM tracks').get()!.n, 2)
  assert.equal(
    source.prepare("SELECT 1 FROM sqlite_master WHERE name='metadata_legacy_documents'").get(),
    undefined
  )
  source.close()
  const backup = (await readdir(root)).find((name) => name.includes('v18-backup-'))!
  const snapshot = new DatabaseSync(join(root, backup), { readOnly: true })
  assert.equal(snapshot.prepare('SELECT count(*) n FROM tracks').get()!.n, 2)
  snapshot.close()
})

test('replaying a staged ID without its collection clears old bindings; empty albums retains its exact root shape', async (t) => {
  const f = await fixture(t),
    revision = f.db.getContentRevision()
  f.db.legacyMusicBegin(PLUGIN, 7, { albums: {} }, 1, revision)
  const request = { pluginId: PLUGIN, sourceRevision: 7, contentRevision: revision }
  f.db.legacyMusicStage({
    ...request,
    entries: [{ id: f.id, value: null, collectionId: f.albums.items[0].id }]
  })
  assert.equal(f.db.legacyMusicStatus(PLUGIN)?.counts.bound, 1)
  f.db.legacyMusicStage({ ...request, entries: [{ id: f.id, value: null }] })
  assert.deepEqual(f.db.legacyMusicStatus(PLUGIN)?.counts, {
    bound: 0,
    conflicts: 0,
    unassigned: 1
  })
  f.db.legacyMusicPublish(PLUGIN, 7, revision)
  assert.equal(f.db.legacyMusicInventory(PLUGIN).items[0].bindings.length, 0)
  const empty = f.db.legacyMusicEdit(PLUGIN, { revision: 7, value: { config: {}, albums: {} } })
  assert.deepEqual(empty.value, { config: {}, albums: {} })
  const absent = f.db.legacyMusicEdit(PLUGIN, { revision: empty.revision, value: { config: {} } })
  assert.deepEqual(absent.value, { config: {} })
})

test('multiple old IDs with incompatible text or IDs remain visible conflicts, never a first-row introduction', async (t) => {
  const f = await fixture(t),
    revision = f.db.getContentRevision()
  f.db.legacyMusicBegin(PLUGIN, 7, { albums: {} }, 3, revision)
  f.db.legacyMusicStage({
    pluginId: PLUGIN,
    sourceRevision: 7,
    contentRevision: revision,
    entries: [
      {
        id: 'old-a',
        collectionId: f.albums.items[0].id,
        value: { description: 'First', online: { releaseId: 'a', status: 'matched' } }
      },
      {
        id: 'old-b',
        collectionId: f.albums.items[0].id,
        value: { description: 'Second', online: { releaseId: 'b', status: 'matched' } }
      },
      { id: 'orphan', value: { localNote: 'Keep orphan' } }
    ]
  })
  f.db.legacyMusicPublish(PLUGIN, 7, revision)
  assert.deepEqual(f.db.legacyMusicStatus(PLUGIN)?.counts, {
    bound: 0,
    conflicts: 2,
    unassigned: 1
  })
  const inventory = (await f.service.music(PLUGIN, 'inventory', { limit: 2 })) as ReturnType<
    LibraryDatabase['legacyMusicInventory']
  >
  assert.equal(inventory.total, 3)
  assert.equal(inventory.items.length, 2)
  assert.equal(inventory.items[0].bindings[0].collectionId, f.albums.items[0].id)
  assert.ok(inventory.items[0].bindings[0].trackIds.length)
  const detail = f.db.metadataDetail(f.entityId, 'en')
  assert.equal(detail.introduction, null)
  assert.equal(detail.imports?.length, 2)
  assert.ok(detail.imports?.every((item) => item.disposition === 'conflict'))
  assert.equal(f.db.identificationDetail(f.entityId).link, null)
  f.db.legacyMusicEdit(PLUGIN, {
    revision: 7,
    value: { albums: { 'old-a': { description: 'First' } } }
  })
  assert.deepEqual(f.db.legacyMusicStatus(PLUGIN)?.counts, {
    bound: 1,
    conflicts: 0,
    unassigned: 0
  })
  assert.equal(f.db.metadataDetail(f.entityId, 'en').introduction?.value, 'First')
  f.db.legacyMusicRestore(PLUGIN, 7, 8)
  assert.deepEqual(f.db.legacyMusicStatus(PLUGIN)?.counts, {
    bound: 0,
    conflicts: 2,
    unassigned: 1
  })
})

test('new imported material for a real album binds from its Core-derived ID; unknown IDs do not get title matches', async (t) => {
  const f = await fixture(t)
  await writeFile(f.file, JSON.stringify({ revision: 0, value: {} }))
  assert.deepEqual(await f.service.document(PLUGIN), { revision: 0, value: {} })
  await f.service.document(PLUGIN, {
    revision: 0,
    value: {
      albums: {
        [f.id]: {
          description: 'First import for existing album',
          descriptionSource: { method: 'external-ai' }
        },
        unknown: { description: 'Unknown', title: 'Album', artist: 'Artist' }
      }
    }
  })
  assert.equal(
    f.db.metadataDetail(f.entityId, 'en').introduction?.value,
    'First import for existing album'
  )
  assert.deepEqual(f.db.legacyMusicStatus(PLUGIN)?.counts, {
    bound: 1,
    conflicts: 0,
    unassigned: 1
  })
})

test('staging failure keeps JSON usable but publication permanently disables JSON fallback on read failures', async (t) => {
  const f = await fixture(t)
  let fail = 'stage'
  const database = new Proxy(f.database, {
    get(target, key) {
      if (
        (key === 'legacyMusicStage' && fail === 'stage') ||
        (key === 'legacyMusicRead' && fail === 'read')
      )
        return async () => {
          throw new Error('Database unavailable')
        }
      return target[key as keyof typeof target]
    }
  })
  const documents = createExperienceDocuments(
    f.manager,
    createLegacyMusicAuthority(database, () => false)
  )
  assert.deepEqual(await documents(PLUGIN), f.legacy)
  assert.match((await documents.migrationStatus(PLUGIN)).error!, /Database unavailable/)
  const edited = structuredClone(f.legacy)
  edited.value.albums[f.id].localNote = 'Pre-publication edit'
  const saved = await documents(PLUGIN, edited)
  assert.equal(saved.revision, 8)
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), saved)
  fail = ''
  assert.deepEqual(await documents(PLUGIN), saved)
  assert.equal((await documents.migrationStatus(PLUGIN)).error, null)
  fail = 'read'
  await assert.rejects(documents(PLUGIN), /Database unavailable/)
  await assert.rejects(documents(PLUGIN, { revision: 8, value: {} }), /Database unavailable/)
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), saved)
  fail = ''
  assert.deepEqual(await documents(PLUGIN), saved)
  assert.equal((await documents.migrationStatus(PLUGIN)).error, null)
})

test('the original whole-document size limit also applies to legacy reads and staged aggregates', async (t) => {
  const f = await fixture(t)
  await writeFile(f.file, JSON.stringify({ revision: -1, value: {} }))
  await assert.rejects(f.service.document(PLUGIN), /Invalid metadata document/)
  const revision = f.db.getContentRevision()
  f.db.legacyMusicBegin(PLUGIN, 0, {}, 2, revision)
  assert.throws(
    () =>
      f.db.legacyMusicStage({
        pluginId: PLUGIN,
        sourceRevision: 0,
        contentRevision: revision,
        entries: [
          { id: 'a', value: 'x'.repeat(9 * 1024 * 1024) },
          { id: 'b', value: 'x'.repeat(9 * 1024 * 1024) }
        ]
      }),
    /exceeds 16 MiB/
  )
  assert.equal(f.db.legacyMusicStatus(PLUGIN)?.staged, 0)
})

const albumValue = (document: { value: Record<string, unknown> }, id: string) =>
  (document.value.albums as Record<string, Record<string, unknown>>)[id]
const platformText = { name: 'Old platform', url: 'https://example.com/platform' }
async function oldPlatformFixture(t: TestContext) {
  const f = await fixture(t)
  f.legacy.value.albums[f.id].descriptionSource = platformText as typeof f.legacy.value.albums[typeof f.id]['descriptionSource']
  await writeFile(f.file, JSON.stringify(f.legacy))
  await f.service.document(PLUGIN)
  return f
}

test('new manual body provenance survives multiple snapshots and ignores retained provider labels', async (t) => {
  const f = await oldPlatformFixture(t)
  let document = f.db.legacyMusicRead(PLUGIN)!
  albumValue(document, f.id).description = 'First handwritten revision'
  document = f.db.legacyMusicEdit(PLUGIN, document)
  albumValue(document, f.id).localNote = 'Separate note edit'
  document = f.db.legacyMusicEdit(PLUGIN, document)
  albumValue(document, f.id).description = 'Second handwritten revision'
  document = f.db.legacyMusicEdit(PLUGIN, document)
  const provenance = new LegacyMusicProvenance(f.db.sql)
  assert.equal(provenance.disposition(PLUGIN, f.id, -1, albumValue(document, f.id)), 'manual')
  const history = f.db.legacyMusicHistoryRead(PLUGIN, 8)!
  assert.equal(provenance.disposition(PLUGIN, f.id, 8, albumValue(history, f.id)), 'manual')
  const backup = f.db.musicBackupExport(8 * 1024 * 1024)
  const portableCurrent = JSON.parse(String(backup.records.legacyAlbums.find(row => row.legacy_id === f.id)!.payload))
  assert.equal(portableCurrent.description, 'Second handwritten revision')
  assert.equal(portableCurrent.descriptionSource, undefined)
  const portableFirst = JSON.parse(String(backup.records.legacyHistory.find(row => row.revision === 8)!.payload))
  assert.equal(portableFirst.albums[f.id].description, 'First handwritten revision')
  assert.equal(portableFirst.albums[f.id].descriptionSource, undefined)
  const portableOld = JSON.parse(String(backup.records.legacyHistory.find(row => row.revision === 7)!.payload))
  assert.equal(portableOld.albums[f.id].description, undefined, 'old uncertain platform-marked body is excluded')
})

test('old current and historical body reviews are separate, explicit, paged and compare-and-set', async (t) => {
  const f = await oldPlatformFixture(t)
  const document = f.db.legacyMusicRead(PLUGIN)!
  albumValue(document, f.id).localNote = 'Create a historical checkpoint without changing the body'
  f.db.legacyMusicEdit(PLUGIN, document)
  const first = f.db.legacyMusicProvenanceList(PLUGIN, { limit: 1 })
  assert.equal(first.total, 2)
  assert.equal(first.items[0].snapshotRevision, 7)
  assert.equal(f.db.legacyMusicProvenanceList(PLUGIN, { offset: 1, limit: 1 }).items[0].snapshotRevision, -1)
  const item = first.items[0]
  assert.throws(() => f.db.legacyMusicProvenanceReview(PLUGIN, {
    expectedRevision: first.revision, ...item, description: 'not the displayed body', disposition: 'manual'
  }), /Invalid provenance review/)
  const request = { expectedRevision: first.revision, albumId: item.albumId, snapshotRevision: item.snapshotRevision, description: item.description, disposition: 'manual' as const }
  assert.throws(() => f.db.legacyMusicProvenanceReview(PLUGIN, { ...request, description: 'changed' }), { code: 'STALE_REVISION' })
  const after = f.db.legacyMusicProvenanceReview(PLUGIN, request)
  assert.equal(after.total, 1)
  assert.throws(() => f.db.legacyMusicProvenanceReview(PLUGIN, request), { code: 'STALE_REVISION' })
  const current = after.items[0]
  f.db.legacyMusicProvenanceReview(PLUGIN, { expectedRevision: after.revision, albumId: current.albumId, snapshotRevision: -1, description: current.description, disposition: 'excluded' })
  assert.equal(f.db.legacyMusicProvenanceList(PLUGIN).total, 0)
  assert.equal(f.db.legacyMusicProvenanceList(PLUGIN, { includeReviewed: true }).total, 2)
  assert.equal(albumValue(f.db.legacyMusicRead(PLUGIN)!, f.id).description, item.description, 'review never rewrites source material')
  const backup = f.db.musicBackupExport(8 * 1024 * 1024)
  assert.equal(JSON.parse(String(backup.records.legacyAlbums.find(row => row.legacy_id === f.id)!.payload)).description, undefined)
  assert.equal(JSON.parse(String(backup.records.legacyHistory.find(row => row.revision === 7)!.payload)).albums[f.id].description, item.description)
})

test('review list bounds long text and detail fetch keeps exact text for confirmation', async (t) => {
  const f = await fixture(t)
  const value = f.legacy.value.albums[f.id]
  value.description = '旧正文'.repeat(20000)
  value.descriptionSource = platformText as typeof value.descriptionSource
  await writeFile(f.file, JSON.stringify(f.legacy))
  await f.service.document(PLUGIN)
  const page = f.db.legacyMusicProvenanceList(PLUGIN)
  assert.equal(page.items[0].description.length, 20000)
  assert.equal(page.items[0].truncated, true)
  const detail = f.db.legacyMusicProvenanceRead(PLUGIN, f.id, -1)
  assert.equal(detail.item.description, value.description)
  assert.equal(detail.item.truncated, false)
  assert.throws(() => f.db.legacyMusicProvenanceList(PLUGIN, { limit: 101 }), /Invalid provenance review page/)
})

test('automatic lookups mark provider prose and cannot replace explicitly handwritten body', async (t) => {
  const f = await oldPlatformFixture(t)
  const authority = new LibraryDatabaseLegacyMusic({ sql: f.db.sql, transaction: action => action(), contentRevision: () => f.albums.revision, albumAliases: id => [id] })
  const work = { pluginId: PLUGIN, albumId: f.id, operation: 'introductions' as const, collectionId: f.albums.items[0].id,
    batchId: 'test', title: 'Album', force: true, contact: '', album: { id: f.id, title: 'Album', artist: 'Artist', tracks: [], producers: [], rawGenres: [] } as unknown as MusicAlbum }
  const lookup = (description: string) => ({ operation: 'introductions' as const, value: {
    status: 'matched' as const, checkedAt: '2026-10-24', description,
    descriptionSource: { name: 'Provider', url: 'https://example.com/new' }
  } })
  authority.checkpoint(PLUGIN)
  authority.applyLookup(work, lookup('User imported introduction'))
  let document = f.db.legacyMusicRead(PLUGIN)!
  const provenance = new LegacyMusicProvenance(f.db.sql)
  assert.equal(provenance.disposition(PLUGIN, f.id, -1, albumValue(document, f.id)), 'provider')
  assert.equal(albumValue(document, f.id).description, 'User imported introduction', 'same-text provider results still record their actual source')
  assert.equal(f.db.legacyMusicProvenanceList(PLUGIN).items.some(item => item.snapshotRevision === -1), false)
  const backup = f.db.musicBackupExport(8 * 1024 * 1024)
  assert.equal(JSON.parse(String(backup.records.legacyAlbums.find(row => row.legacy_id === f.id)!.payload)).description, undefined)
  albumValue(document, f.id).description = 'Manual body'
  document = f.db.legacyMusicEdit(PLUGIN, document)
  authority.checkpoint(PLUGIN)
  authority.applyLookup(work, lookup('Must not overwrite'))
  assert.equal(albumValue(f.db.legacyMusicRead(PLUGIN)!, f.id).description, 'Manual body')
  assert.equal(provenance.disposition(PLUGIN, f.id, -1, albumValue(document, f.id)), 'manual')
})

test('history restore copies its original provenance instead of relabelling every restored body as manual', async (t) => {
  const f = await oldPlatformFixture(t)
  let document = f.db.legacyMusicRead(PLUGIN)!
  albumValue(document, f.id).description = 'Manual revision'
  document = f.db.legacyMusicEdit(PLUGIN, document)
  albumValue(document, f.id).localNote = 'Make manual revision a history'
  document = f.db.legacyMusicEdit(PLUGIN, document)
  document = f.db.legacyMusicRestore(PLUGIN, 7, document.revision)
  const provenance = new LegacyMusicProvenance(f.db.sql)
  assert.equal(provenance.disposition(PLUGIN, f.id, -1, albumValue(document, f.id)), 'unverified')
  assert.equal(f.db.legacyMusicProvenanceList(PLUGIN).items.some(item => item.snapshotRevision === -1 && item.disposition === 'pending'), true)
  const backup = f.db.musicBackupExport(8 * 1024 * 1024)
  assert.equal(JSON.parse(String(backup.records.legacyAlbums.find(row => row.legacy_id === f.id)!.payload)).description, undefined,
    'restoring an uncertain history must not make its body pass the old manual-input heuristic')
  document = f.db.legacyMusicRestore(PLUGIN, 8, document.revision)
  assert.equal(provenance.disposition(PLUGIN, f.id, -1, albumValue(document, f.id)), 'manual')
})

test('an exact manual clear conflicts with another nonempty body on the same bound entity and suppresses fallback', async (t) => {
  const f = await oldPlatformFixture(t)
  const document = f.db.legacyMusicRead(PLUGIN)!
  albumValue(document, f.id).description = null
  ;(document.value.albums as Record<string, unknown>)['other-original-id'] = { description: 'Another retained body' }
  f.db.legacyMusicEdit(PLUGIN, document)
  const evidence = f.db.sql.prepare('SELECT evidence FROM metadata_legacy_bindings WHERE plugin_id=? AND legacy_id=? AND entity_id=?').get(PLUGIN, f.id, f.entityId)!.evidence
  f.db.sql.prepare('INSERT INTO metadata_legacy_bindings VALUES(?,?,?,?)').run(PLUGIN, 'other-original-id', f.entityId, evidence)
  const next = f.db.legacyMusicRead(PLUGIN)!
  albumValue(next, f.id).localNote = 'Reconcile original IDs'
  f.db.legacyMusicEdit(PLUGIN, next)
  const inventory = f.db.legacyMusicInventory(PLUGIN)
  assert.equal(inventory.items.find(item => item.id === f.id)!.disposition, 'conflict')
  assert.equal(inventory.items.find(item => item.id === 'other-original-id')!.disposition, 'conflict')
  const detail = f.db.metadataDetail(f.entityId, 'en')
  assert.equal(detail.introduction, null)
  assert.equal(detail.imports!.find(item => item.albumId === f.id)!.descriptionCleared, true)
  assert.equal(detail.imports!.find(item => item.albumId === f.id)!.sources.length, 0)
})

test('the public experience music entry exposes review without enumerating library albums', async (t) => {
  const f = await oldPlatformFixture(t)
  const page = await f.service.music(PLUGIN, 'provenance.list', { limit: 1 }) as ReturnType<LibraryDatabase['legacyMusicProvenanceList']>
  const detail = await f.service.music(PLUGIN, 'provenance.read', { albumId: page.items[0].albumId, snapshotRevision: -1 }) as ReturnType<LibraryDatabase['legacyMusicProvenanceRead']>
  const result = await f.service.music(PLUGIN, 'provenance.review', { expectedRevision: detail.revision, albumId: detail.item.albumId, snapshotRevision: -1, description: detail.item.description, disposition: 'excluded' }) as ReturnType<LibraryDatabase['legacyMusicProvenanceList']>
  assert.equal(result.total, 0)
  await assert.rejects(() => f.service.music(PLUGIN, 'provenance.list', { limit: 1000 }), /Invalid provenance review page/)
})

test('standalone automatic compatibility writes remain provider material and preserve an existing manual replacement', async (t) => {
  const f = await oldPlatformFixture(t)
  let document = await f.service.document(PLUGIN)
  albumValue(document, f.id).description = 'Compatibility provider text'
  document = await f.service.document.automatic(PLUGIN, document)
  const provenance = new LegacyMusicProvenance(f.db.sql)
  assert.equal(provenance.disposition(PLUGIN, f.id, -1, albumValue(document, f.id)), 'provider')
  let data = f.db.musicBackupExport(8 * 1024 * 1024)
  assert.equal(JSON.parse(String(data.records.legacyAlbums.find(row => row.legacy_id === f.id)!.payload)).description, undefined)
  albumValue(document, f.id).description = 'Manual replacement after compatibility lookup'
  document = await f.service.document(PLUGIN, document)
  albumValue(document, f.id).description = 'Another compatibility result'
  document = await f.service.document.automatic(PLUGIN, document)
  assert.equal(albumValue(document, f.id).description, 'Manual replacement after compatibility lookup')
  data = f.db.musicBackupExport(8 * 1024 * 1024)
  assert.equal(JSON.parse(String(data.records.legacyAlbums.find(row => row.legacy_id === f.id)!.payload)).description, 'Manual replacement after compatibility lookup')
})
