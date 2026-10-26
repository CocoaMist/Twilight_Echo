import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  classificationDimensionsCtes,
  classificationDimensionsContext,
  classificationFacetSql,
  compileClassificationFilters,
  type ClassificationReadContext
} from './libraryDatabaseClassificationDimensions.ts'
import {
  classificationDimensionAvailability,
  classificationFacetLabel,
  validClassificationFacetQuery,
  validClassificationFilters,
  type ClassificationDimension,
  type ClassificationFilter
} from '../../shared/musicClassificationDimensions.ts'

function fixture(t: test.TestContext) {
  const sql = new DatabaseSync(':memory:')
  t.after(() => sql.close())
  sql.exec(`CREATE TABLE catalog_sources(id TEXT PRIMARY KEY,provider TEXT,payload TEXT,
      recording TEXT,release TEXT,availability TEXT);
    CREATE TABLE catalog_release_projects(release_id TEXT,project_id TEXT);
    CREATE TABLE metadata_identity_links(entity_id TEXT,state TEXT,target_id TEXT);
    CREATE TABLE metadata_facts(target_id TEXT,field TEXT,payload TEXT);
    CREATE TABLE metadata_overrides(entity_id TEXT,payload TEXT);
    CREATE TABLE metadata_legacy_documents(plugin_id TEXT,state TEXT);
    CREATE TABLE metadata_legacy_albums(plugin_id TEXT,legacy_id TEXT,payload TEXT,disposition TEXT);
    CREATE TABLE metadata_legacy_bindings(plugin_id TEXT,legacy_id TEXT,entity_id TEXT);`)
  const source = (
    id: string,
    provider: string,
    recording: string,
    release: string | null,
    payload: Record<string, unknown> = {},
    availability = 'indexed'
  ) => {
    sql
      .prepare('INSERT INTO catalog_sources VALUES(?,?,?,?,?,?)')
      .run(id, provider, JSON.stringify(payload), recording, release, availability)
  }
  const link = (entity: string, state = 'confirmed') => {
    sql
      .prepare('INSERT INTO metadata_identity_links VALUES(?,?,?)')
      .run(entity, state, `target:${entity}`)
  }
  const fact = (
    entity: string,
    field: string,
    value: string,
    extra: Record<string, unknown> = {}
  ) => {
    sql
      .prepare('INSERT INTO metadata_facts VALUES(?,?,?)')
      .run(`target:${entity}`, field, JSON.stringify({ field, value, language: 'und', ...extra }))
  }
  const ctes = (
    kind: 'recording' | 'release' = 'recording',
    context: ClassificationReadContext = {},
    now = 1000
  ) => {
    const dimensions = classificationDimensionsCtes(kind, 1000, context, now)
    return {
      sql: `WITH scoped_sources AS (SELECT * FROM catalog_sources),${dimensions.sql}`,
      params: dimensions.params
    }
  }
  const values = (
    id: string,
    dimension: ClassificationDimension,
    kind: 'recording' | 'release' = 'recording',
    context: ClassificationReadContext = {},
    now = 1000
  ) => {
    const q = ctes(kind, context, now)
    return sql
      .prepare(
        `${q.sql} SELECT value FROM source_dimensions WHERE source_id=? AND dimension=? ORDER BY value`
      )
      .all(...q.params, id, dimension)
      .map((row) => String(row.value))
  }
  const matches = (filters: ClassificationFilter[], provider?: string) => {
    const q = ctes(),
      filter = compileClassificationFilters(filters)
    return sql
      .prepare(
        `${q.sql} SELECT s.id FROM scoped_sources s WHERE ${filter.sql}
      ${provider ? 'AND s.provider=?' : ''} ORDER BY s.id`
      )
      .all(...q.params, ...filter.params, ...(provider ? [provider] : []))
      .map((row) => String(row.id))
  }
  return { sql, source, link, fact, ctes, values, matches }
}

test('technical dimensions keep unknowns and constrain format/depth/rate to one actual source', (t) => {
  const { source, values, matches } = fixture(t)
  source('local16', 'local', 'recording:shared', 'release:one', {
    format: ' flac ',
    bitDepth: 16,
    sampleRate: 44100
  })
  source('cloud24', 'ncm', 'recording:shared', 'release:one', {
    format: 'FLAC',
    bitDepth: 24,
    sampleRate: 96000
  })
  source('local24', 'local', 'recording:two', 'release:two', {
    format: 'ALAC',
    bitDepth: 24,
    sampleRate: 44100
  })
  source('unknown', 'local', 'recording:three', null, { format: '', bitDepth: 0, sampleRate: -1 })
  assert.deepEqual(values('local16', 'format'), ['FLAC'])
  assert.deepEqual(values('unknown', 'format'), ['unknown'])
  assert.deepEqual(values('unknown', 'bitDepth'), ['unknown'])
  assert.deepEqual(matches([{ dimension: 'bitDepth', values: ['24'] }], 'local'), ['local24'])
  assert.deepEqual(
    matches(
      [
        { dimension: 'bitDepth', values: ['24'] },
        { dimension: 'sampleRate', values: ['96000'] }
      ],
      'local'
    ),
    []
  )
  assert.deepEqual(matches([{ dimension: 'bitDepth', values: ['16', 'unknown'] }]), [
    'local16',
    'unknown'
  ])
})

test('technical values and unknowns are single-valued without a repeated payload fallback', t => {
  const { sql, source } = fixture(t)
  const cases = [
    { payload: { format: ' flac ', bitDepth: 24, sampleRate: 96000 }, values: ['FLAC', '24', '96000'] },
    { payload: {}, values: ['unknown', 'unknown', 'unknown'] },
    { payload: { format: null, bitDepth: null, sampleRate: null }, values: ['unknown', 'unknown', 'unknown'] },
    { payload: { format: 42, bitDepth: '24', sampleRate: '44100' }, values: ['unknown', 'unknown', 'unknown'] },
    { payload: { format: ['FLAC'], bitDepth: true, sampleRate: {} }, values: ['unknown', 'unknown', 'unknown'] },
    { payload: { format: ' ', bitDepth: 0, sampleRate: -1 }, values: ['unknown', 'unknown', 'unknown'] },
    { payload: { format: 'x'.repeat(65), bitDepth: 24.5, sampleRate: 44100.5 }, values: ['unknown', 'unknown', 'unknown'] },
    { payload: { format: 'x'.repeat(64), bitDepth: 16.0, sampleRate: 44100.0 }, values: ['X'.repeat(64), '16', '44100'] }
  ]
  cases.forEach(({ payload }, index) => source(String(index), 'local', `r:${index}`, null, payload))
  const dimensions = ['format', 'bitDepth', 'sampleRate'] as const
  const q = classificationDimensionsCtes('recording', 1000, {}, 1000, dimensions)
  const graph = `WITH scoped_sources AS (SELECT * FROM catalog_sources),${q.sql}`
  const rows = sql.prepare(`${graph} SELECT * FROM source_dimensions ORDER BY source_id,dimension`).all(...q.params)
  assert.equal(rows.length, cases.length * dimensions.length)
  cases.forEach(({ values }, index) => dimensions.forEach((dimension, dimensionIndex) => {
    assert.deepEqual(rows.filter(row => row.source_id === String(index) && row.dimension === dimension).map(row => row.value),
      [values[dimensionIndex]])
  }))
  assert.deepEqual(sql.prepare(`${graph} SELECT * FROM dimension_known_values`).all(...q.params), [])
  assert.deepEqual(sql.prepare(`${graph} SELECT * FROM dimension_names`).all(...q.params), [])
  const plan = sql.prepare(`EXPLAIN QUERY PLAN ${graph} SELECT * FROM source_dimensions`).all(...q.params)
  assert.equal(plan.filter(row => /^(SCAN|SEARCH) c( USING|$)/.test(String(row.detail))).length, 3)
  assert.equal(plan.some(row => String(row.detail).includes('CORRELATED SCALAR SUBQUERY')), false)
})

test('project first year, release year, country and type use only their confirmed layer', (t) => {
  const { sql, source, link, fact, values } = fixture(t)
  source('one', 'local', 'recording:one', 'release:one', { releaseDate: '2020-03-15' })
  sql.prepare('INSERT INTO catalog_release_projects VALUES(?,?)').run('release:one', 'project:one')
  link('recording:one')
  link('release:one')
  link('project:one')
  fact('project:one', 'firstReleaseDate', '1973-03-01')
  fact('project:one', 'primaryType', 'Album')
  fact('release:one', 'releaseDate', '2011-09-26')
  fact('release:one', 'country', 'GB')
  fact('recording:one', 'country', 'US')
  assert.deepEqual(values('one', 'projectYear'), ['1973'])
  assert.deepEqual(values('one', 'releaseYear'), ['2011'])
  assert.deepEqual(values('one', 'region'), ['GB'])
  assert.deepEqual(values('one', 'albumType'), ['album'])
  sql
    .prepare("UPDATE metadata_identity_links SET state='detached' WHERE entity_id='project:one'")
    .run()
  assert.deepEqual(values('one', 'projectYear'), ['unknown'])
  assert.deepEqual(values('one', 'albumType'), ['unknown'])
  sql
    .prepare("UPDATE metadata_identity_links SET state='unresolved' WHERE entity_id='release:one'")
    .run()
  assert.deepEqual(values('one', 'region'), ['unknown'])
  assert.deepEqual(values('one', 'releaseYear'), ['2020'])
})

test('requested dimensions map only their metadata layers and fields, skipping absent facts without losing native fallback', t => {
  const { sql, source, link, fact } = fixture(t)
  source('one', 'local', 'recording:one', 'release:one', { releaseDate: '2020-03-15', format: 'flac' })
  sql.prepare('INSERT INTO catalog_release_projects VALUES(?,?)').run('release:one', 'project:one')
  for (const id of ['recording:one', 'release:one', 'project:one']) link(id)
  fact('recording:one', 'introduction', 'Recording introduction')
  fact('release:one', 'introduction', 'Release introduction')
  const read = (requested: ClassificationDimension[], relation: string, kind: 'recording' | 'release' = 'recording') => {
    const q = classificationDimensionsCtes(kind, 1000, {}, 1000, requested)
    return sql.prepare(`WITH scoped_sources AS (SELECT * FROM catalog_sources),${q.sql} SELECT * FROM ${relation}`)
      .all(...q.params).map(row => ({ ...row }))
  }
  assert.deepEqual(read(['releaseYear'], 'dimension_source_entities'), [])
  assert.deepEqual(read(['releaseYear'], 'source_dimensions'), [{ source_id: 'one', dimension: 'releaseYear', value: '2020' }])
  assert.deepEqual(read(['format'], 'dimension_source_entities'), [])
  assert.deepEqual(read(['format'], 'source_dimensions'), [{ source_id: 'one', dimension: 'format', value: 'FLAC' }])
  fact('recording:one', 'releaseDate', '1990')
  fact('release:one', 'releaseDate', '2011')
  fact('release:one', 'country', 'GB')
  fact('project:one', 'firstReleaseDate', '1973')
  fact('project:one', 'primaryType', 'Album')
  assert.deepEqual(read(['releaseYear'], 'dimension_source_entities'), [{ source_id: 'one', entity_id: 'release:one', kind: 'release' }])
  assert.deepEqual(read(['releaseYear'], 'dimension_facts').map(row => [row.kind, row.field, row.value]), [['release', 'releaseDate', '2011']])
  assert.deepEqual(read(['projectYear', 'albumType'], 'dimension_facts').map(row => [row.kind, row.field]).sort(),
    [['album_project', 'firstReleaseDate'], ['album_project', 'primaryType']])
  for (const kind of ['recording', 'release'] as const) {
    const fields = read(['management'], 'dimension_facts', kind)
    assert.deepEqual(fields.map(row => [row.kind, row.field]), [[kind, 'introduction']])
  }
  const full = classificationDimensionsCtes('recording', 1000)
  const all = sql.prepare(`WITH scoped_sources AS (SELECT * FROM catalog_sources),${full.sql} SELECT * FROM source_dimensions`).all(...full.params)
  for (const dimension of ['format', 'region', 'releaseYear', 'projectYear', 'albumType', 'management'] as const)
    assert.deepEqual(read([dimension], 'source_dimensions').sort((a, b) => String(a.value).localeCompare(String(b.value))),
      all.filter(row => row.dimension === dimension).map(row => ({ ...row })).sort((a, b) => String(a.value).localeCompare(String(b.value))))
})

test('date classification accepts actual precision, not invalid dates or name-like prefixes', (t) => {
  const { source, values } = fixture(t)
  const dates = [
    '1997',
    '1997-05',
    '1997-05-21',
    '1997-05-21T00:00:00.000Z',
    '1997 live',
    '0000',
    '2023-02-29',
    '2024-02-29',
    '2024-13'
  ]
  dates.forEach((date, i) => source(String(i), 'local', `r:${i}`, null, { releaseDate: date }))
  assert.deepEqual(
    dates.map((_, i) => values(String(i), 'releaseYear')[0]),
    ['1997', '1997', '1997', '1997', 'unknown', 'unknown', 'unknown', '2024', 'unknown']
  )
})

test('language and live/remaster properties stay unknown when only titles or text languages exist', (t) => {
  const { source, link, fact, values } = fixture(t)
  source('one', 'local', 'recording:one', 'release:one', {
    title: '粤语演唱会 Live',
    album: 'Deluxe Remaster Explicit',
    language: 'zh',
    country: 'CN'
  })
  link('recording:one')
  fact('recording:one', 'introduction', '介绍', { language: 'zh-Hans' })
  assert.deepEqual(values('one', 'language'), ['unknown'])
  assert.deepEqual(values('one', 'versionAttribute'), ['unknown'])
  assert.deepEqual(values('one', 'region'), ['unknown'])
  assert.equal(classificationDimensionAvailability('language').available, false)
  assert.equal(classificationDimensionAvailability('versionAttribute').available, false)
  assert.equal(classificationDimensionAvailability('releaseYear').available, true)
})

test('platform facts require current account context and same source unless cross-source is authorized', (t) => {
  const { sql, source, link, fact, values } = fixture(t)
  source('local', 'local', 'r:one', 'release:one')
  source('cloud', 'ncm', 'r:one', 'release:one')
  link('release:one')
  const usage = { display: true, cache: true, crossSource: false, export: false, expiresAt: 2000 }
  fact('release:one', 'country', 'JP', {
    sourceProvider: 'ncm',
    providerContext: 'account:one',
    usage
  })
  const context = { platformContexts: { ncm: 'account:one' } }
  assert.deepEqual(values('cloud', 'region'), ['unknown'])
  assert.deepEqual(values('local', 'region', 'recording', context), ['unknown'])
  assert.deepEqual(values('cloud', 'region', 'recording', context), ['JP'])
  assert.deepEqual(
    values('cloud', 'region', 'recording', { platformContexts: { ncm: 'account:two' } }),
    ['unknown']
  )
  sql.prepare("UPDATE metadata_facts SET payload=json_set(payload,'$.usage.crossSource',1)").run()
  assert.deepEqual(values('local', 'region', 'recording', context), ['JP'])
  assert.deepEqual(values('cloud', 'region', 'recording', context, 2000), ['unknown'])
  sql.prepare("UPDATE metadata_facts SET payload=json_set(payload,'$.usage.display',0)").run()
  assert.deepEqual(values('cloud', 'region', 'recording', context), ['unknown'])
})

test('facets count distinct final matched entities, retain all filters and paginate in SQL', (t) => {
  const { sql, source, ctes } = fixture(t)
  source('one', 'local', 'recording:one', null, { format: 'flac', bitDepth: 24 })
  source('two', 'ncm', 'recording:one', null, { format: 'flac', bitDepth: 24 })
  source('three', 'local', 'recording:two', null, { format: 'flac', bitDepth: 16 })
  source('four', 'local', 'recording:three', null, {})
  const q = ctes(),
    filter = compileClassificationFilters([{ dimension: 'bitDepth', values: ['24'] }])
  const facet = classificationFacetSql({ dimension: 'format', facetSearch: 'FL' })
  const statement = `${q.sql},matched_members AS (SELECT s.recording entity_id,s.id source_id
    FROM scoped_sources s WHERE ${filter.sql}) ${facet.sql} ORDER BY value LIMIT ? OFFSET ?`
  const rows = sql.prepare(statement).all(...q.params, ...filter.params, ...facet.params, 1, 0)
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [{ value: 'FLAC', count: 1 }]
  )
  assert.deepEqual(
    sql.prepare(statement).all(...q.params, ...filter.params, ...facet.params, 1, 1),
    []
  )
})

test('management reflects exact identity, actual availability, introduction override and legacy imports', (t) => {
  const { sql, source, link, fact, values } = fixture(t)
  source('one', 'local', 'recording:one', 'release:one', {}, 'missing')
  link('recording:one')
  link('release:one', 'unresolved')
  fact('recording:one', 'description', 'Description')
  assert.deepEqual(values('one', 'management'), [
    'has_introduction',
    'identified',
    'release_pending',
    'source_missing'
  ])
  assert.deepEqual(values('one', 'management', 'release'), [
    'missing_introduction',
    'release_pending',
    'source_missing',
    'unidentified'
  ])
  sql
    .prepare('INSERT INTO metadata_overrides VALUES(?,?)')
    .run('recording:one', JSON.stringify({ mode: 'clear' }))
  assert.equal(values('one', 'management').includes('missing_introduction'), true)
  sql.prepare('INSERT INTO metadata_legacy_documents VALUES(?,?)').run('rhine', 'published')
  sql
    .prepare('INSERT INTO metadata_legacy_albums VALUES(?,?,?,?)')
    .run('rhine', 'legacy', JSON.stringify({ description: 'Retained introduction' }), 'bound')
  sql
    .prepare('INSERT INTO metadata_legacy_bindings VALUES(?,?,?)')
    .run('rhine', 'legacy', 'release:one')
  assert.equal(values('one', 'management', 'release').includes('has_introduction'), true)
  sql.prepare("UPDATE metadata_legacy_documents SET state='staging'").run()
  assert.equal(values('one', 'management', 'release').includes('missing_introduction'), true)
})

test('context keys are opaque, authorization changes invalidate and only usable expiry is returned', (t) => {
  const { sql, source, link, fact } = fixture(t)
  source('one', 'ncm', 'recording:one', 'release:one')
  link('release:one')
  fact('release:one', 'country', 'JP', {
    sourceProvider: 'ncm',
    providerContext: 'account:private',
    usage: { display: true, cache: true, crossSource: false, expiresAt: 2000 }
  })
  const noContext = classificationDimensionsContext(sql, {}, 1000)
  assert.equal(noContext.expiresAt, null)
  const context = { platformContexts: { ncm: 'account:private' } }
  const first = classificationDimensionsContext(sql, context, 1000)
  assert.equal(first.expiresAt, 2000)
  assert.equal(first.contextKey.includes('account'), false)
  assert.notEqual(first.contextKey, noContext.contextKey)
  assert.equal(classificationDimensionsContext(sql, context, 1100).contextKey, first.contextKey)
  assert.equal(classificationDimensionsContext(sql, context, 2000).expiresAt, null)
  assert.notEqual(classificationDimensionsContext(sql, {}, 1000).contextKey, first.contextKey)
})

test('introduction presence uses the details page external-AI import preference and text boundary', (t) => {
  const { sql, source, values } = fixture(t)
  source('one', 'local', 'recording:one', 'release:one')
  source('cloud', 'ncm', 'recording:one', 'release:one')
  sql.prepare('INSERT INTO metadata_legacy_documents VALUES(?,?)').run('rhine', 'published')
  const imported = (id: string, description: string, method = 'historical') => {
    sql
      .prepare('INSERT INTO metadata_legacy_albums VALUES(?,?,?,?)')
      .run('rhine', id, JSON.stringify({ description, descriptionSource: { method } }), 'bound')
    sql
      .prepare('INSERT INTO metadata_legacy_bindings VALUES(?,?,?)')
      .run('rhine', id, 'release:one')
  }
  imported('historical', 'Historical text')
  imported('ai', 'Preferred external-AI text', 'external-ai')
  assert.equal(values('one', 'management', 'release').includes('has_introduction'), true)
  assert.equal(values('cloud', 'management', 'release').includes('missing_introduction'), true)
  imported('ai-conflict', 'A different external-AI text', 'external-ai')
  assert.equal(values('one', 'management', 'release').includes('missing_introduction'), true)
  sql
    .prepare('UPDATE metadata_legacy_albums SET payload=? WHERE legacy_id IN (?,?)')
    .run(
      JSON.stringify({
        description: 'X'.repeat(20000) + 'after display limit',
        descriptionSource: { method: 'external-ai' }
      }),
      'ai',
      'ai-conflict'
    )
  sql
    .prepare(
      "UPDATE metadata_legacy_albums SET payload=json_set(payload,'$.description',?) WHERE legacy_id='ai-conflict'"
    )
    .run('X'.repeat(20000) + 'different invisible suffix')
  assert.equal(values('one', 'management', 'release').includes('has_introduction'), true)
})

test('filter validation is finite, rejects unknown identifiers and leaves values parameterized', (t) => {
  const { source, matches } = fixture(t)
  source('one', 'local', 'r:one', null, { format: 'FLAC' })
  assert.equal(
    validClassificationFilters([{ dimension: 'format', values: ['FLAC', 'unknown'] }]),
    true
  )
  assert.equal(validClassificationFilters([{ dimension: 'title', values: ['FLAC'] }]), false)
  assert.equal(validClassificationFilters([{ dimension: 'format', values: [] }]), false)
  assert.equal(
    validClassificationFilters([{ dimension: 'format', values: ['FLAC'], sql: 'OR 1' }]),
    false
  )
  assert.equal(
    validClassificationFilters([
      { dimension: 'format', values: ['FLAC'] },
      { dimension: 'format', values: ['MP3'] }
    ]),
    false
  )
  assert.equal(
    validClassificationFilters([{ dimension: 'format', values: ['FLAC', 'FLAC'] }]),
    false
  )
  assert.equal(validClassificationFacetQuery({ dimension: 'format', limit: 201 }), false)
  assert.deepEqual(matches([{ dimension: 'format', values: ["FLAC') OR 1=1 --"] }]), [])
  assert.equal(classificationFacetLabel('bitDepth', '24'), '24-bit')
  assert.equal(classificationFacetLabel('sampleRate', '44100'), '44.1 kHz')
  assert.equal(classificationFacetLabel('management', 'release_pending'), '发行未确认')
})
