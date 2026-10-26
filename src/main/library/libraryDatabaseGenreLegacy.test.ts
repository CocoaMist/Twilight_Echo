import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { legacyExperienceAlbumId } from '../../core/plugins/legacyMusicAuthority.ts'
import type { LegacyMusicDocument } from '../../shared/legacyMusicMetadata.ts'
import type { GenreRules } from '../../shared/rhineMusic.ts'
import { GENRE_SCHEMA_SQL, LibraryDatabaseGenres } from './libraryDatabaseGenres.ts'
import { LibraryDatabase } from './libraryDatabase.ts'
import {
  GENRE_LEGACY_SCHEMA_SQL,
  LibraryDatabaseGenreLegacy,
  rhineGenreRules
} from './libraryDatabaseGenreLegacy.ts'

const PLUGIN = 'com.twilightecho.experience.rhine-lab'
const COLLECTION = 'album:exact-local-id'
const ID = legacyExperienceAlbumId(COLLECTION)
const rules = (albumOverrides: Record<string, string> = { [ID]: 'jazz' }): GenreRules => ({
  version: 1,
  genres: [
    { id: 'jazz', name: '爵士', aliases: ['Jazz', '爵士乐'] },
    { id: 'rock', name: '摇滚', aliases: ['Rock'] }
  ],
  albumOverrides
})

function fixture(t: test.TestContext, value: LegacyMusicDocument['value'] = { rules: rules() }) {
  const sql = new DatabaseSync(':memory:')
  t.after(() => sql.close())
  sql.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE catalog_sources(id TEXT PRIMARY KEY,provider TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE catalog_memberships(owner TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(owner,source_id));
    CREATE TABLE metadata_legacy_documents(plugin_id TEXT PRIMARY KEY,state TEXT,revision INTEGER,base TEXT);
    CREATE TABLE metadata_legacy_albums(plugin_id TEXT,legacy_id TEXT,payload TEXT,PRIMARY KEY(plugin_id,legacy_id));
    CREATE TABLE metadata_legacy_bindings(plugin_id TEXT,legacy_id TEXT,evidence TEXT);`)
  sql.exec(GENRE_SCHEMA_SQL + GENRE_LEGACY_SCHEMA_SQL)
  const transaction = <T>(action: () => T): T => {
    sql.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      sql.exec('COMMIT')
      return result
    } catch (error) {
      sql.exec('ROLLBACK')
      throw error
    }
  }
  const collections = new Set([COLLECTION])
  let contentRevision = 1
  const genres = new LibraryDatabaseGenres({
    sql,
    transaction,
    collectionExists: (id) => collections.has(id)
  })
  const owner = {
    sql,
    transaction,
    contentRevision: () => contentRevision,
    albumCollections: () => [...collections].map((id) => ({ id })),
    genres
  }
  let adapter = new LibraryDatabaseGenreLegacy(owner)
  const store = (document: LegacyMusicDocument) => {
    const { albums, ...base } = document.value
    sql
      .prepare(
        `INSERT INTO metadata_legacy_documents VALUES(?,'published',?,?)
      ON CONFLICT(plugin_id) DO UPDATE SET revision=excluded.revision,base=excluded.base`
      )
      .run(PLUGIN, document.revision, JSON.stringify(base))
    sql.prepare('DELETE FROM metadata_legacy_albums WHERE plugin_id=?').run(PLUGIN)
    for (const [id, album] of Object.entries((albums ?? {}) as Record<string, unknown>))
      sql
        .prepare('INSERT INTO metadata_legacy_albums VALUES(?,?,?)')
        .run(PLUGIN, id, JSON.stringify(album))
  }
  let current: LegacyMusicDocument = { revision: 7, value }
  store(current)
  const read = () => adapter.project(PLUGIN, structuredClone(current))
  const edit = (incoming: LegacyMusicDocument['value']) => {
    const previous = read(),
      next = { revision: current.revision, value: incoming }
    transaction(() => {
      store({ revision: current.revision + 1, value: incoming })
      adapter.edited(PLUGIN, previous, next)
    })
    current = { revision: current.revision + 1, value: incoming }
    return read()
  }
  const drain = (limit = 2) => {
    let result = adapter.advance(limit),
      calls = 1
    while (result.pending) {
      result = adapter.advance(limit)
      if (++calls > 100) throw new Error('Unbounded migration')
    }
    return result
  }
  const selection = () =>
    genres.evidence({ target: { kind: 'collection', id: COLLECTION } }).selection
  const retained = (id = ID) => {
    const row = sql
      .prepare('SELECT payload FROM music_genre_legacy_albums WHERE plugin_id=? AND legacy_id=?')
      .get(PLUGIN, id)
    return row ? JSON.parse(String(row.payload)) : null
  }
  return {
    sql,
    genres,
    read,
    edit,
    drain,
    selection,
    retained,
    collections,
    advance: (limit: number) => adapter.advance(limit),
    revision: () => genres.tree().revision,
    bumpContent: () => {
      contentRevision++
    },
    reopen: () => {
      adapter = new LibraryDatabaseGenreLegacy(owner)
    }
  }
}

test('recognizes the real hosted value.rules contract and rejects inconsistent manual references', () => {
  assert.deepEqual(rhineGenreRules(rules()), rules())
  assert.equal(rhineGenreRules(undefined), null)
  assert.throws(
    () => rhineGenreRules({ version: 1, genres: [], albumOverrides: { missing: 'jazz' } }),
    /流派规则无效/
  )
  assert.throws(
    () => rhineGenreRules({ ...rules(), genres: [...rules().genres, rules().genres[0]] }),
    /流派规则无效/
  )
})

test('rules-only album overrides retain original IDs and bind through the exact established album identity', (t) => {
  const f = fixture(t)
  f.drain()
  const nodes = f.genres.projectImportedNodes(`legacy:${PLUGIN}`)
  const jazz = nodes.find((node) => node.originalId === 'jazz')!
  assert.notEqual(jazz.id, 'genre:jazz')
  assert.equal(jazz.name, '爵士')
  assert.ok(jazz.aliases.includes('Jazz'))
  assert.deepEqual(f.selection().genreIds, [jazz.id])
  assert.equal(f.selection().override, null)
  assert.deepEqual(f.retained(), { manualGenreId: 'jazz' })
  assert.deepEqual(f.read().value.rules, rules())
})

test('first-track-derived genre IDs and mixed historical raw arrays stay evidence, not manual or licensed external classifications', (t) => {
  const rawGenres = ['Jazz/Rock', ' 爵士 ', 'Rare Community Genre']
  const f = fixture(t, { rules: rules({}), albums: { [ID]: { genreId: 'jazz', rawGenres } } })
  f.drain()
  assert.deepEqual(f.retained(), { derivedGenreId: 'jazz', rawGenres })
  assert.deepEqual(f.selection().genreIds, [])
  assert.equal(f.selection().origin, 'none')
  assert.equal(f.genres.evidence({ target: { kind: 'collection', id: COLLECTION } }).total, 0)
})

test('unbound overrides remain source-scoped and activate only after their exact collection appears', (t) => {
  const futureCollection = 'album:future-local-id',
    futureId = legacyExperienceAlbumId(futureCollection)
  const f = fixture(t, { rules: rules({ [futureId]: 'rock' }) })
  f.drain()
  assert.deepEqual(f.retained(futureId), { manualGenreId: 'rock' })
  assert.deepEqual(f.selection().genreIds, [])
  f.collections.add(futureCollection)
  f.bumpContent()
  f.drain()
  const result = f.genres.evidence({
    target: { kind: 'collection', id: futureCollection }
  }).selection
  assert.equal(result.genreIds.length, 1)
  assert.ok(result.genreIds[0].endsWith(':rock'))
})

test('advance is bounded and resumes its persisted cursor with a new adapter instance', (t) => {
  const f = fixture(t, { rules: rules({ missing1: 'jazz', missing2: 'jazz', missing3: 'rock' }) })
  assert.deepEqual(f.advance(1), { processed: 1, pending: true })
  f.reopen()
  assert.deepEqual(f.advance(1), { processed: 1, pending: true })
  f.drain(1)
  assert.equal(
    Number(f.sql.prepare('SELECT count(*) n FROM music_genre_legacy_albums').get()!.n),
    3
  )
  assert.deepEqual(f.advance(1), { processed: 0, pending: false })
})

test('an introduction edit does not clear either imported genres or modern explicit-empty manual classification', (t) => {
  const f = fixture(t, { rules: rules(), albums: { [ID]: { description: 'Before' } } })
  f.drain()
  const imported = f.selection().genreIds
  f.genres.override({
    target: { kind: 'collection', id: COLLECTION },
    revision: f.revision(),
    genreIds: []
  })
  const value = f.read().value
  f.edit({ ...value, albums: { [ID]: { description: 'After' } } })
  assert.deepEqual(f.selection().override, [])
  f.genres.override({
    target: { kind: 'collection', id: COLLECTION },
    revision: f.revision(),
    genreIds: null
  })
  assert.deepEqual(f.selection().genreIds, imported)
})

test('an explicit old scalar override edit is rejected beneath a modern multi-value or empty set and rolls back the document', (t) => {
  const f = fixture(t)
  f.drain()
  f.genres.override({
    target: { kind: 'collection', id: COLLECTION },
    revision: f.revision(),
    genreIds: []
  })
  assert.throws(() => f.edit({ rules: rules({ [ID]: 'rock' }) }), /新整理入口/)
  assert.equal(f.sql.prepare('SELECT revision FROM metadata_legacy_documents').get()!.revision, 7)
  assert.deepEqual(f.selection().override, [])
  assert.deepEqual(f.retained(), { manualGenreId: 'jazz' })
})

test('legacy override removal restores automatic classification without deleting retained raw fields', (t) => {
  const f = fixture(t, {
    rules: rules(),
    albums: { [ID]: { rawGenres: ['Jazz/Rock'], genreId: 'derived' } }
  })
  f.drain()
  f.edit({ rules: rules({}), albums: { [ID]: { rawGenres: ['Jazz/Rock'], genreId: 'derived' } } })
  assert.deepEqual(f.selection().genreIds, [])
  assert.deepEqual(f.retained(), { rawGenres: ['Jazz/Rock'], derivedGenreId: 'derived' })
})

test('modern imported-node names project back by the original ID and survive an old metadata save and rescan', (t) => {
  const f = fixture(t)
  f.drain()
  const jazz = f.genres
    .projectImportedNodes(`legacy:${PLUGIN}`)
    .find((node) => node.originalId === 'jazz')!
  f.genres.edit({
    action: 'update',
    revision: f.revision(),
    genreId: jazz.id,
    name: '我的爵士',
    parentId: 'genre:jazz'
  })
  const projected = f.read()
  const projectedRules = projected.value.rules as GenreRules
  assert.equal(projectedRules.genres[0].id, 'jazz')
  assert.equal(projectedRules.genres[0].name, '我的爵士')
  f.edit({ ...projected.value, albums: { [ID]: { localNote: 'Keep the modern hierarchy' } } })
  f.bumpContent()
  f.drain()
  assert.equal((f.read().value.rules as GenreRules).genres[0].name, '我的爵士')
  const node = f.genres.tree({ search: '我的爵士' }).items[0]
  assert.equal(node.parentId, 'genre:jazz')
  assert.deepEqual(f.retained(), { manualGenreId: 'jazz' })
})

test('unrelated opaque genreRules and invalid historical rules do not prevent introduction edits', (t) => {
  const opaque = { keep: ['unchanged'] }
  const f = fixture(t, {
    genreRules: opaque,
    rules: { old: 'opaque' },
    albums: { [ID]: { description: 'Before' } }
  })
  f.drain()
  const value = f.read().value
  const result = f.edit({ ...value, albums: { [ID]: { description: 'After' } } })
  assert.deepEqual(result.value.genreRules, opaque)
  assert.deepEqual(result.value.rules, { old: 'opaque' })
  assert.deepEqual(f.selection().genreIds, [])
})

test('deleted collections lose only their imported projection while original override evidence remains recoverable', (t) => {
  const f = fixture(t)
  f.drain()
  f.collections.delete(COLLECTION)
  f.bumpContent()
  f.drain()
  assert.equal(
    Number(f.sql.prepare('SELECT count(*) n FROM music_genre_import_overrides').get()!.n),
    0
  )
  assert.deepEqual(f.retained(), { manualGenreId: 'jazz' })
})

test('schema creation is idempotent and repeated unchanged backfill does not bump the common genre revision', (t) => {
  const f = fixture(t)
  f.sql.exec(GENRE_LEGACY_SCHEMA_SQL)
  f.drain()
  const revision = f.revision()
  f.reopen()
  f.drain()
  f.bumpContent()
  f.drain()
  assert.equal(f.revision(), revision)
})

test('old custom aliases classify actual local source tags without turning a first-track value into an album override', (t) => {
  const custom: GenreRules = {
    version: 1,
    genres: [{ id: 'chill', name: '我的舒缓', aliases: ['MyStyle'] }],
    albumOverrides: {}
  }
  const f = fixture(t, { rules: custom, albums: { [ID]: { genreId: 'MyStyle' } } })
  for (const provider of ['local', 'cloud']) {
    f.sql
      .prepare('INSERT INTO catalog_sources VALUES(?,?,?)')
      .run(provider, provider, JSON.stringify({ genre: 'MyStyle' }))
    f.sql.prepare('INSERT INTO catalog_memberships VALUES(?,?)').run(provider, provider)
  }
  f.drain()
  let result = f.genres.advance(2)
  while (result.pending) result = f.genres.advance(2)
  const imported = f.genres.projectImportedNodes(`legacy:${PLUGIN}`)[0].id
  assert.deepEqual(
    f.genres.evidence({ target: { kind: 'source', id: 'local' } }).selection.genreIds,
    [imported]
  )
  assert.deepEqual(
    f.genres.evidence({ target: { kind: 'source', id: 'cloud' } }).selection.genreIds,
    []
  )
  assert.deepEqual(f.selection().genreIds, [])
  f.edit({ rules: { ...custom, genres: [{ ...custom.genres[0], aliases: [] }] } })
  assert.deepEqual(
    f.genres.evidence({ target: { kind: 'source', id: 'local' } }).selection.genreIds,
    []
  )
})

test('modern local map and ignore decisions win over legacy alias imports and later rule edits', (t) => {
  const custom: GenreRules = {
    version: 1,
    genres: [{ id: 'chill', name: '我的舒缓', aliases: ['MyStyle'] }],
    albumOverrides: {}
  }
  const f = fixture(t, { rules: custom })
  f.sql
    .prepare('INSERT INTO catalog_sources VALUES(?,?,?)')
    .run('local', 'local', JSON.stringify({ genre: 'MyStyle' }))
  f.sql.prepare('INSERT INTO catalog_memberships VALUES(?,?)').run('local', 'local')
  f.drain()
  let result = f.genres.advance(2)
  while (result.pending) result = f.genres.advance(2)
  const target = { kind: 'source', id: 'local' } as const
  f.genres.map({
    provider: 'local',
    value: 'MyStyle',
    genreId: 'genre:rock',
    revision: f.revision()
  })
  f.edit({ rules: { ...custom, genres: [{ ...custom.genres[0], name: 'Updated old name' }] } })
  assert.deepEqual(f.genres.evidence({ target }).selection.genreIds, ['genre:rock'])
  f.genres.map({
    provider: 'local',
    value: 'MyStyle',
    genreId: null,
    ignored: true,
    revision: f.revision()
  })
  f.edit({ rules: custom })
  assert.deepEqual(f.genres.evidence({ target }).selection.genreIds, [])
  assert.equal(f.genres.evidence({ target }).items[0].values[0].ignored, true)
})

function databaseFixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'rhine-genre-integration-'))
  const db = new LibraryDatabase(join(root, 'library.sqlite'))
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  db.replaceDocument({
    version: 2,
    revision: 1,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'one',
        filePath: 'D:/Music/One/one.flac',
        source: 'local',
        title: 'One',
        artist: 'Artist',
        album: 'Album',
        genre: 'Jazz'
      }
    ]
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const page = db.queryCollections('albums', { limit: 200 }),
    collection = page.items[0].id
  const id = legacyExperienceAlbumId(collection)
  db.legacyMusicBegin(PLUGIN, 7, { rules: rules({ [id]: 'jazz' }), albums: {} }, 1, page.revision)
  db.legacyMusicStage({
    pluginId: PLUGIN,
    sourceRevision: 7,
    contentRevision: page.revision,
    entries: [
      {
        id,
        collectionId: collection,
        value: { description: 'Before', genreId: 'first-track-derived', rawGenres: ['Jazz/Rock'] }
      }
    ]
  })
  db.legacyMusicPublish(PLUGIN, 7, page.revision)
  const drain = () => {
    let result = db.genresAdvance(2)
    while (result.pending) result = db.genresAdvance(2)
  }
  drain()
  const target = { kind: 'collection', id: collection } as const
  return { db, id, target, drain }
}

test('real legacy publication, edits and history restore share one imported-genre authority', (t) => {
  const { db, id, target, drain } = databaseFixture(t)
  const original = db.genresEvidence({ target }).selection.genreIds
  assert.equal(original.length, 1)
  const previous = db.legacyMusicRead(PLUGIN)!
  db.legacyMusicEdit(PLUGIN, {
    revision: previous.revision,
    value: {
      ...previous.value,
      rules: rules({ [id]: 'rock' }),
      albums: { [id]: { description: 'After' } }
    }
  })
  assert.notDeepEqual(db.genresEvidence({ target }).selection.genreIds, original)
  const current = db.legacyMusicRead(PLUGIN)!
  db.legacyMusicRestore(PLUGIN, previous.revision, current.revision)
  assert.deepEqual(db.genresEvidence({ target }).selection.genreIds, original)
  assert.equal(
    (db.legacyMusicRead(PLUGIN)!.value.albums as Record<string, { description: string }>)[id]
      .description,
    'Before'
  )
  drain()
  assert.deepEqual(db.genresEvidence({ target }).selection.genreIds, original)
})

test('real old introduction save works after modern manual changes; explicit scalar changes fail atomically', (t) => {
  const { db, id, target } = databaseFixture(t)
  const loaded = db.legacyMusicRead(PLUGIN)!
  db.genresOverride({
    target,
    revision: db.genresTree({}).revision,
    genreIds: ['genre:rock', 'genre:jazz']
  })
  const saved = db.legacyMusicEdit(PLUGIN, {
    revision: loaded.revision,
    value: {
      ...loaded.value,
      albums: { [id]: { description: 'Still editable' } }
    }
  })
  assert.deepEqual(db.genresEvidence({ target }).selection.override, ['genre:jazz', 'genre:rock'])
  assert.throws(
    () =>
      db.legacyMusicEdit(PLUGIN, {
        revision: saved.revision,
        value: { ...saved.value, rules: rules({ [id]: 'rock' }) }
      }),
    /新整理入口/
  )
  assert.equal(db.legacyMusicRead(PLUGIN)!.revision, saved.revision)
  assert.equal(
    (db.legacyMusicRead(PLUGIN)!.value.albums as Record<string, { description: string }>)[id]
      .description,
    'Still editable'
  )
})
