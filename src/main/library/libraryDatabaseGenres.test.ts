import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { GENRE_SCHEMA_SQL, LibraryDatabaseGenres } from './libraryDatabaseGenres.ts'
import {
  MAX_GENRE_ID_LENGTH,
  normalizeGenreAlias,
  validGenresPayload,
  type GenreTarget
} from '../../shared/musicGenres.ts'

function fixture(t: test.TestContext) {
  const sql = new DatabaseSync(':memory:')
  t.after(() => sql.close())
  sql.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE catalog_sources(id TEXT PRIMARY KEY,provider TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE catalog_memberships(owner TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(owner,source_id));`)
  sql.exec(GENRE_SCHEMA_SQL)
  const transaction = <T>(action: () => T): T => {
    sql.exec('BEGIN IMMEDIATE')
    try {
      const value = action()
      sql.exec('COMMIT')
      return value
    } catch (error) {
      sql.exec('ROLLBACK')
      throw error
    }
  }
  const genres = new LibraryDatabaseGenres({
    sql,
    transaction,
    collectionExists: (id) => id === 'album:exact'
  })
  const source = (id: string, genre: string | null, provider = 'local') => {
    sql
      .prepare(
        `INSERT INTO catalog_sources VALUES(?,?,?) ON CONFLICT(id)
      DO UPDATE SET provider=excluded.provider,payload=excluded.payload`
      )
      .run(id, provider, JSON.stringify({ genre }))
    sql.prepare('INSERT OR IGNORE INTO catalog_memberships VALUES(?,?)').run(provider, id)
    return { kind: 'source', id } as const
  }
  const drain = (separators?: string) => {
    let result = genres.advance(2, separators)
    while (result.pending) result = genres.advance(2, separators)
    return result
  }
  const revision = () => genres.tree().revision
  return { sql, genres, source, drain, revision }
}

test('small first-party dictionary is idempotent, hierarchical and separates language/attributes', (t) => {
  const { sql, genres } = fixture(t)
  sql.exec(GENRE_SCHEMA_SQL)
  const page = genres.tree()
  assert.equal(page.total, 16)
  assert.equal(page.dictionaryVersion, 1)
  assert.equal(genres.tree({ parentId: 'genre:rock' }).items.length, 2)
  assert.deepEqual(genres.tree({ search: 'bebop' }).items[0].ancestorIds, ['genre:jazz'])
  assert.equal(genres.tree({ search: '粤语' }).total, 0)
  assert.equal(genres.tree({ search: '现场' }).total, 0)
  assert.equal(genres.tree({ parentId: null, limit: 2 }).items.length, 2)
})

test('normalization is deterministic NFKC/case/whitespace, not fuzzy inference', () => {
  assert.equal(normalizeGenreAlias('  ＪＡＺＺ  '), 'jazz')
  assert.equal(normalizeGenreAlias('Hip   Hop'), 'hip hop')
  assert.notEqual(normalizeGenreAlias('粤语'), normalizeGenreAlias('流行'))
})

test('raw local string and separators survive indexing; platform arrays are never split', (t) => {
  const { genres, source, drain } = fixture(t)
  const target = source('one', ' Jazz / 爵士；Unusual ')
  drain()
  const fact = genres.evidence({ target })
  assert.deepEqual(fact.selection.genreIds, ['genre:jazz'])
  assert.deepEqual(fact.items[0].raw, {
    format: 'text',
    value: ' Jazz / 爵士；Unusual ',
    separators: ',，;；、/'
  })
  assert.deepEqual(
    fact.items[0].values.map((v) => v.value),
    ['Jazz', '爵士', 'Unusual']
  )
  genres.ingest({
    target,
    key: 'structured',
    provider: 'fixture',
    origin: 'source',
    provenance: 'approved fixture',
    raw: { format: 'array', values: ['Jazz/Rock', '爵士'] }
  })
  const structured = genres.evidence({ target }).items.find((v) => v.key === 'structured')!
  assert.equal(structured.values[0].value, 'Jazz/Rock')
  assert.equal(structured.values[0].genreId, null)
  assert.deepEqual(structured.raw, { format: 'array', values: ['Jazz/Rock', '爵士'] })
})

test('provider-specific alias wins over common alias and ignores do not erase evidence', (t) => {
  const { genres, source, drain, revision } = fixture(t)
  const one = source('one', 'Jazz', 'fixture'),
    two = source('two', 'Jazz')
  drain()
  genres.map({
    revision: revision(),
    provider: 'fixture',
    value: 'ＪＡＺＺ',
    genreId: 'genre:rock'
  })
  assert.deepEqual(genres.evidence({ target: one }).selection.genreIds, ['genre:rock'])
  assert.deepEqual(genres.evidence({ target: two }).selection.genreIds, ['genre:jazz'])
  genres.map({
    revision: revision(),
    provider: 'fixture',
    value: 'jazz',
    genreId: null,
    ignored: true
  })
  assert.deepEqual(genres.evidence({ target: one }).selection.genreIds, [])
  assert.equal(genres.evidence({ target: one }).items[0].raw.format, 'text')
  assert.equal(genres.unmapped().total, 0)
  assert.equal(genres.unmapped({ includeIgnored: true }).items[0].ignored, true)
  genres.map({ revision: revision(), provider: 'fixture', value: 'jazz', genreId: null })
  assert.deepEqual(genres.evidence({ target: one }).selection.genreIds, ['genre:jazz'])
})

test('unmapped grouping counts exact targets once and excludes removed library memberships', (t) => {
  const { sql, genres, source, drain } = fixture(t)
  const one = source('one', 'Odd;Odd;Other'),
    two = source('two', 'odd')
  drain()
  genres.ingest({
    target: one,
    key: 'second',
    provider: 'local',
    origin: 'source',
    provenance: 'fixture',
    raw: { format: 'array', values: ['odd'] }
  })
  const page = genres.unmapped({ limit: 1 })
  assert.equal(page.total, 2)
  assert.equal(page.items[0].normalized, 'odd')
  assert.equal(page.items[0].targetCount, 2)
  assert.equal(genres.unmapped({ limit: 1, offset: 1 }).items[0].normalized, 'other')
  sql.prepare('DELETE FROM catalog_memberships WHERE source_id=?').run(two.id)
  assert.equal(genres.unmapped({ search: 'odd' }).items[0].targetCount, 1)
  assert.throws(() => genres.evidence({ target: two }), /不属于/)
})

test('atomic create-and-map preserves all evidence and is revision guarded', (t) => {
  const { genres, source, drain, revision } = fixture(t)
  const target = source('one', 'New Style')
  drain()
  const before = revision()
  const result = genres.map({
    revision: before,
    provider: 'local',
    value: 'new style',
    create: { name: '新风格', nameEn: 'New style', parentId: 'genre:rock' }
  })
  assert.deepEqual(genres.evidence({ target }).selection.genreIds, [result.genreId])
  assert.equal(genres.unmapped().total, 0)
  assert.throws(
    () =>
      genres.map({
        revision: before,
        provider: 'local',
        value: 'other',
        create: { name: '重复', nameEn: 'Duplicate' }
      }),
    { code: 'STALE_REVISION' }
  )
  assert.equal(genres.tree({ search: 'Duplicate' }).total, 0)
})

test('manual values including empty set survive source rescans; reset restores automatic values', (t) => {
  const { genres, source, drain, revision } = fixture(t)
  const target = source('one', 'Jazz')
  drain()
  genres.override({ target, revision: revision(), genreIds: [] })
  source('one', 'Rock')
  drain()
  assert.deepEqual(genres.evidence({ target }).selection, {
    target,
    revision: revision(),
    genreIds: [],
    override: [],
    origin: 'manual'
  })
  genres.override({ target, revision: revision(), genreIds: ['genre:jazz', 'genre:jazz'] })
  assert.deepEqual(genres.evidence({ target }).selection.genreIds, ['genre:jazz'])
  genres.override({ target, revision: revision(), genreIds: null })
  assert.deepEqual(genres.evidence({ target }).selection.genreIds, ['genre:rock'])
})

test('allowed external classification is fallback, never copied over current source or manual classification', (t) => {
  const { genres, source, drain, revision } = fixture(t)
  const target = source('one', null)
  drain()
  genres.ingest({
    target,
    key: 'approved:fixture',
    provider: 'approved',
    origin: 'external',
    provenance: 'already authorized',
    raw: { format: 'array', values: ['Jazz'] }
  })
  assert.equal(genres.evidence({ target }).selection.origin, 'external')
  source('one', 'Rock')
  drain()
  assert.deepEqual(genres.evidence({ target }).selection.genreIds, ['genre:rock'])
  genres.override({ target, revision: revision(), genreIds: [] })
  assert.deepEqual(genres.evidence({ target }).selection.genreIds, [])
})

test('parent edits reject self and arbitrarily deep cycles atomically', (t) => {
  const { genres, revision } = fixture(t)
  const a = genres.edit({
    action: 'create',
    revision: revision(),
    name: 'A',
    nameEn: 'A',
    parentId: 'genre:rock'
  }).genreId!
  const b = genres.edit({
    action: 'create',
    revision: revision(),
    name: 'B',
    nameEn: 'B',
    parentId: a
  }).genreId!
  const c = genres.edit({
    action: 'create',
    revision: revision(),
    name: 'C',
    nameEn: 'C',
    parentId: b
  }).genreId!
  const before = revision()
  assert.throws(
    () =>
      genres.edit({
        action: 'update',
        revision: before,
        genreId: 'genre:rock',
        parentId: c,
        name: 'Must roll back'
      }),
    /循环/
  )
  assert.equal(revision(), before)
  assert.equal(genres.tree({ search: 'Must roll back' }).total, 0)
  assert.throws(
    () => genres.edit({ action: 'update', revision: revision(), genreId: a, parentId: a }),
    /循环/
  )
  assert.throws(
    () => genres.edit({ action: 'update', revision: revision(), genreId: a, parentId: 'missing' }),
    /不存在/
  )
})

test('delete requires an explicit destination and unmapping preserves raw facts and manual empty sets', (t) => {
  const { genres, source, drain, revision } = fixture(t)
  const target = source('one', 'Jazz')
  drain()
  genres.override({ target, revision: revision(), genreIds: ['genre:jazz'] })
  assert.throws(
    () => genres.edit({ action: 'delete', revision: revision(), genreId: 'genre:jazz' } as never),
    /参数/
  )
  genres.edit({ action: 'delete', revision: revision(), genreId: 'genre:jazz', replacement: null })
  assert.deepEqual(genres.evidence({ target }).selection.override, [])
  assert.equal(genres.evidence({ target }).items[0].raw.format, 'text')
  assert.equal(genres.unmapped().items[0].normalized, 'jazz')
  assert.equal(genres.tree({ search: 'bebop' }).items[0].parentId, null)
})

test('delete migrates aliases, children and manual references, but cannot migrate into a descendant', (t) => {
  const { genres, source, drain, revision } = fixture(t)
  const target = source('one', 'Rock')
  drain()
  genres.override({ target, revision: revision(), genreIds: ['genre:rock', 'genre:jazz'] })
  assert.throws(
    () =>
      genres.edit({
        action: 'delete',
        revision: revision(),
        genreId: 'genre:rock',
        replacement: 'genre:punk'
      }),
    /循环/
  )
  genres.edit({
    action: 'delete',
    revision: revision(),
    genreId: 'genre:rock',
    replacement: 'genre:jazz'
  })
  assert.deepEqual(genres.evidence({ target }).selection.override, ['genre:jazz'])
  genres.override({ target, revision: revision(), genreIds: null })
  assert.deepEqual(genres.evidence({ target }).selection.genreIds, ['genre:jazz'])
  assert.equal(genres.tree({ search: 'punk' }).items[0].parentId, 'genre:jazz')
})

test('bounded advance honors separators changes without changing arrays or overrides', (t) => {
  const { genres, source, revision } = fixture(t)
  const one = source('one', 'Jazz/Rock'),
    two = source('two', 'Jazz/Rock', 'platform')
  let result = genres.advance(1, ';')
  assert.equal(result.processed, 1)
  assert.equal(result.pending, true)
  while (result.pending) result = genres.advance(1, ';')
  assert.deepEqual(genres.evidence({ target: one }).selection.genreIds, [])
  genres.ingest({
    target: one,
    key: 'array',
    provider: 'platform',
    origin: 'source',
    provenance: 'fixture',
    raw: { format: 'array', values: ['Jazz/Rock'] }
  })
  genres.override({ target: two, revision: revision(), genreIds: [] })
  result = genres.advance(1, '/')
  assert.equal(result.pending, true)
  while (result.pending) result = genres.advance(1, '/')
  assert.deepEqual(genres.evidence({ target: one }).selection.genreIds, [
    'genre:jazz',
    'genre:rock'
  ])
  assert.deepEqual(genres.evidence({ target: two }).selection.genreIds, [])
  assert.equal(genres.evidence({ target: two }).items[0].values.length, 1)
  assert.equal(
    genres.evidence({ target: one }).items.find((item) => item.key === 'array')!.values.length,
    1
  )
  assert.throws(() => genres.advance(201), /参数/)
})

test('trusted imported nodes keep original identities and modern name/parent edits on repeat import', (t) => {
  const { genres, revision } = fixture(t)
  const original = { id: 'original-id', name: '旧名称', aliases: ['旧别名'] }
  const ids = genres.importNodes('rhine:fixture', [original])
  assert.equal(genres.projectImportedNodes('rhine:fixture')[0].originalId, original.id)
  genres.edit({
    action: 'update',
    revision: revision(),
    genreId: ids[original.id],
    name: '新名称',
    parentId: 'genre:jazz'
  })
  assert.equal(genres.importNodes('rhine:fixture', [original])[original.id], ids[original.id])
  const imported = genres.projectImportedNodes('rhine:fixture')[0]
  assert.equal(imported.name, '新名称')
  assert.ok(imported.aliases.includes('旧别名'))
  assert.equal(genres.tree({ search: '新名称' }).items[0].parentId, 'genre:jazz')
})

test('long Unicode imported IDs remain usable through public tree/edit/map/override contracts', (t) => {
  const { genres, source, drain, revision } = fixture(t)
  const originalId = '流'.repeat(512)
  const id = genres.importNodes('legacy:rhine', [{ id: originalId, name: 'Long ID' }])[originalId]
  assert.ok(id.length > 512 && id.length <= MAX_GENRE_ID_LENGTH)
  const target = source('one', 'Mapped value')
  drain()
  genres.edit({
    action: 'update',
    revision: revision(),
    genreId: id,
    name: 'Edited long ID',
    parentId: 'genre:jazz'
  })
  const child = genres.edit({
    action: 'create',
    revision: revision(),
    name: 'Child',
    nameEn: 'Child',
    parentId: id
  }).genreId!
  assert.equal(genres.tree({ parentId: id }).items[0].id, child)
  genres.map({ revision: revision(), provider: 'local', value: 'Mapped value', genreId: id })
  assert.deepEqual(genres.evidence({ target }).selection.genreIds, [id])
  genres.override({ target, revision: revision(), genreIds: [id] })
  assert.deepEqual(genres.evidence({ target }).selection.override, [id])
  genres.edit({ action: 'delete', revision: revision(), genreId: child, replacement: id })
  genres.edit({ action: 'delete', revision: revision(), genreId: id, replacement: 'genre:jazz' })
  assert.deepEqual(genres.evidence({ target }).selection.override, ['genre:jazz'])
})

test('public genre ID limit is 8192 across references while names stay at 512', () => {
  const id = 'i'.repeat(MAX_GENRE_ID_LENGTH)
  const tooLong = id + 'i'
  for (const value of [id, tooLong]) {
    const expected = value === id
    assert.equal(validGenresPayload('genres.tree', { parentId: value }), expected)
    assert.equal(
      validGenresPayload('genres.edit', {
        action: 'update',
        revision: 1,
        genreId: value,
        name: 'Name'
      }),
      expected
    )
    assert.equal(
      validGenresPayload('genres.edit', {
        action: 'delete',
        revision: 1,
        genreId: 'genre:jazz',
        replacement: value
      }),
      expected
    )
    assert.equal(
      validGenresPayload('genres.map', {
        revision: 1,
        provider: 'local',
        value: 'x',
        genreId: value
      }),
      expected
    )
    assert.equal(
      validGenresPayload('genres.override', {
        revision: 1,
        target: { kind: 'source', id: 'one' },
        genreIds: [value]
      }),
      expected
    )
  }
  assert.equal(
    validGenresPayload('genres.edit', {
      action: 'create',
      revision: 1,
      name: 'n'.repeat(513),
      nameEn: 'Name'
    }),
    false
  )
})

test('import alias bridge maps local raw strings without becoming an album manual override', (t) => {
  const { genres, source, drain } = fixture(t)
  const target = source('one', 'MyStyle')
  drain()
  const id = genres.importNodes('legacy:rhine', [
    { id: 'chill', name: 'Chill', aliases: ['MyStyle'] }
  ]).chill
  genres.bridgeImportedAliases('legacy:rhine', 'local')
  const detail = genres.evidence({ target })
  assert.deepEqual(detail.selection.genreIds, [id])
  assert.equal(detail.selection.override, null)
  assert.equal(detail.selection.origin, 'source')
  assert.equal(detail.items[0].provider, 'local')
  assert.deepEqual(detail.items[0].raw, {
    format: 'text',
    value: 'MyStyle',
    separators: ',，;；、/'
  })
  assert.equal(genres.unmapped().total, 0)
})

test('bridge snapshot replacement preserves exact local map/ignore decisions and reset restores bridge', (t) => {
  const { genres, source, drain, revision } = fixture(t)
  const target = source('one', 'MyStyle')
  drain()
  const id = genres.importNodes('legacy:rhine', [
    { id: 'chill', name: 'Chill', aliases: ['MyStyle'] }
  ]).chill
  genres.bridgeImportedAliases('legacy:rhine', 'local')
  genres.map({ revision: revision(), provider: 'local', value: 'MyStyle', genreId: 'genre:jazz' })
  genres.importNodes('legacy:rhine', [{ id: 'chill', name: 'Chill', aliases: ['MyStyle'] }])
  genres.bridgeImportedAliases('legacy:rhine', 'local')
  assert.deepEqual(genres.evidence({ target }).selection.genreIds, ['genre:jazz'])
  genres.map({
    revision: revision(),
    provider: 'local',
    value: 'MyStyle',
    genreId: null,
    ignored: true
  })
  genres.bridgeImportedAliases('legacy:rhine', 'local')
  assert.deepEqual(genres.evidence({ target }).selection.genreIds, [])
  assert.equal(genres.unmapped().total, 0)
  assert.equal(genres.unmapped({ includeIgnored: true }).items[0].ignored, true)
  genres.map({ revision: revision(), provider: 'local', value: 'MyStyle', genreId: null })
  assert.deepEqual(genres.evidence({ target }).selection.genreIds, [id])
})

test('removing one imported dictionary withdraws only its bridge and leaves other imports/local decisions', (t) => {
  const { genres, source, drain, revision } = fixture(t)
  const first = source('one', 'First'),
    second = source('two', 'Second'),
    manual = source('three', 'Manual')
  drain()
  genres.importNodes('legacy:first', [{ id: 'first', name: 'First' }])
  const secondId = genres.importNodes('legacy:second', [{ id: 'second', name: 'Second' }]).second
  genres.bridgeImportedAliases('legacy:first', 'local')
  genres.bridgeImportedAliases('legacy:second', 'local')
  genres.map({ revision: revision(), provider: 'local', value: 'Manual', genreId: 'genre:rock' })
  genres.importNodes('legacy:first', [])
  genres.bridgeImportedAliases('legacy:first', 'local')
  assert.deepEqual(genres.evidence({ target: first }).selection.genreIds, [])
  assert.deepEqual(genres.evidence({ target: second }).selection.genreIds, [secondId])
  assert.deepEqual(genres.evidence({ target: manual }).selection.genreIds, ['genre:rock'])
  assert.deepEqual(
    genres.unmapped().items.map((item) => item.normalized),
    ['first']
  )
})

test('different import bridges cannot silently select the first genre for an ambiguous local alias', (t) => {
  const { genres, source, drain } = fixture(t)
  const target = source('one', 'Shared')
  drain()
  genres.importNodes('legacy:first', [{ id: 'first', name: 'First', aliases: ['Shared'] }])
  genres.importNodes('legacy:second', [{ id: 'second', name: 'Second', aliases: ['Shared'] }])
  genres.bridgeImportedAliases('legacy:first', 'local')
  genres.bridgeImportedAliases('legacy:second', 'local')
  assert.deepEqual(genres.evidence({ target }).selection.genreIds, [])
  assert.equal(genres.unmapped().items[0].normalized, 'shared')
})

test('legacy full snapshots replace automatic aliases while preserving modern scoped decisions', (t) => {
  const { genres, source, drain, revision } = fixture(t)
  const provider = 'rhine:fixture'
  const target = source('one', 'old alias', provider)
  drain()
  const [original, other] = [
    { id: 'one', name: 'Old name', aliases: ['old alias'] },
    { id: 'two', name: 'Other', aliases: ['retained manual'] }
  ]
  const ids = genres.importNodes(provider, [original, other])
  assert.deepEqual(genres.evidence({ target }).selection.genreIds, [ids.one])
  genres.map({ revision: revision(), provider, value: 'retained manual', genreId: 'genre:jazz' })
  genres.importNodes(provider, [{ id: 'one', name: 'New name', aliases: ['new alias'] }])
  assert.deepEqual(genres.evidence({ target }).selection.genreIds, [])
  assert.deepEqual(
    genres.projectImportedNodes(provider).map((node) => node.originalId),
    ['one']
  )
  source('one', 'retained manual', provider)
  drain()
  assert.deepEqual(genres.evidence({ target }).selection.genreIds, ['genre:jazz'])
})

test('modern deletion tombstones imported IDs and replacement cannot rename a shared canonical genre', (t) => {
  const { genres, revision } = fixture(t)
  const node = { id: 'one', name: 'Imported name' }
  const id = genres.importNodes('rhine:fixture', [node]).one
  genres.edit({ action: 'delete', revision: revision(), genreId: id, replacement: null })
  assert.deepEqual(genres.importNodes('rhine:fixture', [node]), {})
  assert.equal(genres.tree({ search: 'Imported name' }).total, 0)
  const other = { id: 'two', name: 'Must not rename jazz' }
  const second = genres.importNodes('rhine:fixture', [node, other]).two
  genres.edit({
    action: 'delete',
    revision: revision(),
    genreId: second,
    replacement: 'genre:jazz'
  })
  genres.importNodes('rhine:fixture', [node, other])
  assert.equal(genres.tree({ search: 'Jazz' }).items[0].name, '爵士')
  assert.equal(genres.projectImportedNodes('rhine:fixture')[0].id, 'genre:jazz')
})

test('imported album manual classifications stay exact and modern explicit empty takes precedence', (t) => {
  const { genres, revision } = fixture(t)
  const target: GenreTarget = { kind: 'collection', id: 'album:exact' }
  genres.setImportedOverride(target, ['genre:jazz'], 'rhine:album')
  assert.deepEqual(genres.evidence({ target }).selection.genreIds, ['genre:jazz'])
  genres.override({ target, revision: revision(), genreIds: [] })
  genres.setImportedOverride(target, ['genre:rock'], 'rhine:album')
  assert.deepEqual(genres.evidence({ target }).selection.genreIds, [])
  genres.override({ target, revision: revision(), genreIds: null })
  assert.deepEqual(genres.evidence({ target }).selection.genreIds, ['genre:rock'])
  genres.setImportedOverride(target, null, 'rhine:album')
  assert.deepEqual(genres.evidence({ target }).selection.genreIds, [])
  assert.throws(
    () =>
      genres.override({
        target: { kind: 'collection', id: 'same title' },
        revision: revision(),
        genreIds: ['genre:jazz']
      }),
    /不存在/
  )
})

test('public validators bound every entry point and preserve explicit empty/null distinctions', () => {
  assert.equal(validGenresPayload('genres.tree', { limit: 201 }), false)
  assert.equal(validGenresPayload('genres.tree', { parentId: null }), true)
  assert.equal(
    validGenresPayload('genres.map', {
      revision: 1,
      provider: 'local',
      value: 'x',
      create: { name: 'X', nameEn: 'X' }
    }),
    true
  )
  assert.equal(
    validGenresPayload('genres.map', {
      revision: 1,
      provider: 'local',
      value: 'x',
      genreId: 'genre:jazz',
      ignored: true
    }),
    false
  )
  assert.equal(
    validGenresPayload('genres.override', {
      target: { kind: 'source', id: 's' },
      revision: 1,
      genreIds: []
    }),
    true
  )
  assert.equal(
    validGenresPayload('genres.override', {
      target: { kind: 'source', id: 's' },
      revision: 1,
      genreIds: null
    }),
    true
  )
  assert.equal(
    validGenresPayload('genres.override', {
      target: { kind: 'source', id: 's' },
      revision: 1,
      genreIds: [],
      network: true
    }),
    false
  )
})

test('membership changes invalidate classification revision even when raw evidence stays the same', (t) => {
  const { sql, genres, source, drain, revision } = fixture(t)
  source('one', 'Odd')
  drain()
  const before = revision()
  sql.prepare('DELETE FROM catalog_memberships WHERE source_id=?').run('one')
  assert.throws(() => genres.unmapped({ revision: before }), { code: 'STALE_REVISION' })
  const removed = revision()
  sql.prepare('INSERT INTO catalog_memberships VALUES(?,?)').run('local', 'one')
  assert.throws(() => genres.tree({ revision: removed }), { code: 'STALE_REVISION' })
})

test('trusted adapter can remove a stale collection override after the collection disappeared', (t) => {
  const { sql } = fixture(t)
  let present = true
  const genres = new LibraryDatabaseGenres({
    sql,
    collectionExists: () => present,
    transaction: (action) => {
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
  })
  const target: GenreTarget = { kind: 'collection', id: 'album:exact' }
  genres.setImportedOverride(target, ['genre:jazz'], 'legacy:key')
  present = false
  genres.setImportedOverride(target, null, 'legacy:key')
  assert.equal(sql.prepare('SELECT 1 FROM music_genre_import_overrides').get(), undefined)
})

test('reopening preserves raw evidence, mapping, user dictionary edits and explicit empty manual values', (t) => {
  const path = join(tmpdir(), `twilight-genres-${randomUUID()}.sqlite`)
  let sql = new DatabaseSync(path)
  t.after(() => {
    sql.close()
    unlinkSync(path)
  })
  const makeRepository = () =>
    new LibraryDatabaseGenres({
      sql,
      transaction: (action) => {
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
    })
  sql.exec(`CREATE TABLE catalog_sources(id TEXT PRIMARY KEY,provider TEXT,payload TEXT);
    CREATE TABLE catalog_memberships(owner TEXT,source_id TEXT);`)
  sql.exec(GENRE_SCHEMA_SQL)
  sql.prepare('INSERT INTO catalog_sources VALUES(?,?,?)').run('one', 'local', '{"genre":"Jazz"}')
  sql.prepare('INSERT INTO catalog_memberships VALUES(?,?)').run('local', 'one')
  let genres = makeRepository()
  genres.advance()
  const target: GenreTarget = { kind: 'source', id: 'one' }
  genres.edit({
    action: 'update',
    revision: genres.revision(),
    genreId: 'genre:jazz',
    name: '我的爵士',
    parentId: 'genre:rock'
  })
  genres.override({ target, revision: genres.revision(), genreIds: [] })
  const before = genres.evidence({ target })
  sql.close()
  sql = new DatabaseSync(path)
  sql.exec(GENRE_SCHEMA_SQL)
  genres = makeRepository()
  assert.deepEqual(genres.evidence({ target }), before)
  assert.equal(genres.tree({ search: '我的爵士' }).items[0].parentId, 'genre:rock')
})
