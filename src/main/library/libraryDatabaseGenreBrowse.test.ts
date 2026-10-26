import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { CATALOG_SCHEMA_SQL } from './libraryDatabaseCatalog.ts'
import { GENRE_SCHEMA_SQL, LibraryDatabaseGenres } from './libraryDatabaseGenres.ts'
import {
  GENRE_PLATFORM_ALBUM_TARGET_SQL,
  genreBrowseCtes,
  LibraryDatabaseGenreBrowse
} from './libraryDatabaseGenreBrowse.ts'
import { validGenreBrowsePayload, validGenreBrowseToken } from '../../shared/musicGenreBrowse.ts'

function fixture(t: test.TestContext) {
  const sql = new DatabaseSync(':memory:')
  t.after(() => sql.close())
  sql.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE tracks(seq INTEGER PRIMARY KEY,id TEXT UNIQUE,payload TEXT,album_key TEXT);`)
  sql.exec(CATALOG_SCHEMA_SQL)
  sql.exec(GENRE_SCHEMA_SQL)
  sql.exec(`CREATE TABLE catalog_release_projects(release_id TEXT,project_id TEXT);
    CREATE TABLE metadata_identity_links(entity_id TEXT,state TEXT,target_id TEXT);
    CREATE TABLE metadata_facts(target_id TEXT,field TEXT,payload TEXT);
    CREATE TABLE metadata_overrides(entity_id TEXT,payload TEXT);
    CREATE TABLE metadata_legacy_documents(plugin_id TEXT,state TEXT);
    CREATE TABLE metadata_legacy_albums(plugin_id TEXT,legacy_id TEXT,payload TEXT,disposition TEXT);
    CREATE TABLE metadata_legacy_bindings(plugin_id TEXT,legacy_id TEXT,entity_id TEXT);`)
  let contentRevision = 1,
    metadataRevision = 1,
    now = 1700000000000
  let clock = () => now
  const albums = new Map<string, string[]>()
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
  const genres = new LibraryDatabaseGenres({
    sql,
    transaction,
    collectionExists: (id) =>
      albums.has(id) ||
      !!sql
        .prepare(
          `SELECT 1 FROM catalog_sources s WHERE provider<>'local' AND album_key=?
        AND ${GENRE_PLATFORM_ALBUM_TARGET_SQL}
        AND EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)`
        )
        .get(id)
  })
  const browse = new LibraryDatabaseGenreBrowse({
    sql,
    albumAliases: () => albums,
    contentRevision: () => contentRevision,
    metadataRevision: () => metadataRevision,
    now: () => clock()
  })
  const source = (
    id: string,
    options: {
      provider?: string
      album?: string
      genre?: string
      member?: boolean
      title?: string
      artist?: string
      recording?: string
      availability?: string
      key?: string
      fields?: Record<string, unknown>
    } = {}
  ) => {
    const provider = options.provider ?? 'local',
      recording = options.recording ?? `rec:${id}`,
      album = options.album,
      hasAlbumId = typeof options.fields?.albumId === 'string' && !!options.fields.albumId.trim(),
      release = album ? `rel:${album}${provider !== 'local' && !hasAlbumId ? `:${id}` : ''}` : null,
      payload = JSON.stringify({
        title: options.title ?? id,
        artist: options.artist ?? 'Artist',
        genre: options.genre,
        ...options.fields
      })
    sql
      .prepare("INSERT OR IGNORE INTO catalog_entities VALUES(?,'recording',?,?,'source')")
      .run(recording, options.title ?? id, options.artist ?? 'Artist')
    if (release)
      sql
        .prepare("INSERT OR IGNORE INTO catalog_entities VALUES(?,'release',?,'Artist','source')")
        .run(release, album!)
    if (provider === 'local') {
      sql
        .prepare('INSERT INTO tracks(id,payload,album_key) VALUES(?,?,?)')
        .run(id, payload, options.key ?? album ?? '')
      sql.prepare('DELETE FROM catalog_pending WHERE track_id=?').run(id)
      if (album && !albums.has(album)) albums.set(album, [options.key ?? album])
    }
    sql
      .prepare('INSERT INTO catalog_sources VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        id,
        `key:${id}`,
        provider,
        id,
        recording,
        release,
        release ? `album:${provider}:${album}` : null,
        payload,
        options.availability ?? (provider === 'local' ? 'indexed' : 'unknown')
      )
    if (options.member !== false)
      sql.prepare('INSERT INTO catalog_memberships VALUES(?,?)').run(provider, id)
    return { kind: 'source', id } as const
  }
  const drain = () => {
    while (genres.advance(200).pending) {
      /* Bounded production advance, explicit in fixture. */
    }
  }
  const override = (kind: 'source' | 'collection', id: string, genreIds: string[] | null) =>
    genres.override({ target: { kind, id }, genreIds, revision: genres.revision() })
  return {
    sql,
    genres,
    browse,
    source,
    drain,
    override,
    albums,
    changeContent: () => contentRevision++,
    changeMetadata: () => metadataRevision++,
    setClock: (value: () => number) => {
      clock = value
    },
    setNow: (value: number) => {
      now = value
    }
  }
}

test('genre shared count/page preserves totals beyond the final page and an empty result', t => {
  const { browse, source, drain } = fixture(t)
  source('one', { genre: 'Jazz' }); source('two', { genre: 'Jazz' }); source('three', { genre: 'Rock' })
  drain()
  const page = browse.browse({ kind: 'recording', genreId: 'genre:jazz', offset: 99, limit: 1 })
  assert.equal(page.total, 2); assert.deepEqual(page.items, [])
  const first = browse.browse({ kind: 'recording', genreId: 'genre:jazz', limit: 1 })
  assert.equal(first.total, 2); assert.equal(first.items[0].classification, 'direct')
  assert.equal(first.items[0].genres.items[0].id, 'genre:jazz')
  const empty = browse.browse({ kind: 'recording', genreId: 'genre:classical', limit: 1 })
  assert.equal(empty.total, 0); assert.deepEqual(empty.items, [])
})

test('private playback scope keeps the frozen source filter, classifications and metadata fence', t => {
  const { sql, browse, source, drain, changeMetadata } = fixture(t)
  source('local', { genre: 'Jazz' })
  source('cloud', { provider: 'fixture', genre: 'Jazz' })
  source('cached', { provider: 'fixture', genre: 'Jazz', member: false })
  sql.exec(`INSERT INTO catalog_entities VALUES('manual','recording','Combined','Artist','manual');
    INSERT INTO catalog_versions VALUES('tracks','v','manual','V',NULL,NULL,NULL);
    INSERT INTO catalog_version_sources VALUES('tracks','key:local','v'),('tracks','key:cloud','v'),('tracks','key:cached','v');`)
  drain()
  const page = browse.browse({ kind: 'recording', source: 'local', genreId: 'genre:jazz' })
  const scope = { entityId: 'manual', source: 'local', genreId: 'genre:jazz', token: page.token }
  assert.deepEqual(browse.containsSources(scope, ['local', 'cloud', 'cached', 'unknown']), ['local'])
  changeMetadata()
  assert.throws(() => browse.containsSources(scope, ['local']), { code: 'STALE_REVISION' })
})

test('parent matches multiple child genres once, while exact genre IDs and old raw strings stay independent', (t) => {
  const { browse, source, drain } = fixture(t)
  source('metal-punk', { album: 'One', genre: 'Metal/Punk' })
  source('rock', { album: 'Two', genre: 'Rock' })
  drain()
  assert.equal(browse.browse({ kind: 'recording', genreId: 'genre:rock' }).total, 1)
  const parent = browse.browse({
    kind: 'recording',
    genreId: 'genre:rock',
    includeDescendants: true,
    limit: 1
  })
  assert.equal(parent.total, 2)
  assert.equal(parent.items.length, 1)
  const next = browse.browse({
    kind: 'recording',
    genreId: 'genre:rock',
    includeDescendants: true,
    token: parent.token,
    offset: 1,
    limit: 1
  })
  assert.notEqual(parent.items[0].id, next.items[0].id)
  assert.equal(
    browse.browse({ kind: 'recording', genreId: 'Rock', includeDescendants: true }).total,
    0
  )
})

test('manual playback-version bindings union only real library sources and honor provider filtering', (t) => {
  const { sql, browse, source, drain } = fixture(t)
  source('local', { genre: 'Jazz' })
  source('cloud', { provider: 'fixture', genre: 'Rock' })
  source('cached-only', { provider: 'fixture', genre: 'Classical', member: false })
  sql.exec(`INSERT INTO catalog_entities VALUES('manual','recording','Combined','Artist','manual');
    INSERT INTO catalog_versions VALUES('tracks','v','manual','V',NULL,NULL,NULL);
    INSERT INTO catalog_version_sources VALUES('tracks','key:local','v'),('tracks','key:cloud','v'),('tracks','key:cached-only','v');`)
  drain()
  const page = browse.browse({ kind: 'recording' })
  assert.equal(page.total, 1)
  assert.equal(page.items[0].sourceCount, 2)
  assert.deepEqual(page.items[0].genres.items.map((g) => g.id).sort(), ['genre:jazz', 'genre:rock'])
  assert.deepEqual(page.providers, ['fixture', 'local'])
  assert.equal(
    browse.browse({ kind: 'recording', source: 'local', genreId: 'genre:rock' }).total,
    0
  )
  const members = browse.members({ entityId: 'manual', source: 'fixture', token: page.token })
  assert.equal(members.total, 1)
  assert.deepEqual(
    members.items.map((s) => s.sourceId),
    ['cloud']
  )
  assert.deepEqual(members.items[0].sourceTarget, { kind: 'source', id: 'cloud' })
  assert.equal(members.items[0].collectionTarget, null)
})

test('release direct classification overrides track fallback and explicit empty collection blocks fallback', (t) => {
  const { browse, source, drain, override } = fixture(t)
  source('one', { album: 'Album', genre: 'Jazz' })
  source('two', { album: 'Album', genre: 'Rock' })
  drain()
  let result = browse.browse({ kind: 'release' }).items[0]
  assert.equal(result.classification, 'from-tracks')
  assert.equal(result.genres.total, 2)
  override('collection', 'Album', ['genre:classical'])
  result = browse.browse({ kind: 'release' }).items[0]
  assert.equal(result.classification, 'direct')
  assert.deepEqual(
    result.genres.items.map((g) => g.id),
    ['genre:classical']
  )
  assert.equal(browse.browse({ kind: 'recording', genreId: 'genre:classical' }).total, 0)
  const recordingMember = browse.members({ entityId: 'rec:one' }).items[0]
  assert.equal(recordingMember.sourceClassification.origin, 'source')
  assert.equal(recordingMember.collectionClassification!.origin, 'manual')
  assert.deepEqual(recordingMember.collectionClassification!.genres.items.map(g => g.id), ['genre:classical'])
  override('collection', 'Album', [])
  result = browse.browse({ kind: 'release' }).items[0]
  assert.equal(result.classification, 'direct')
  assert.equal(result.genres.total, 0)
  assert.equal(browse.browse({ kind: 'release', genreId: 'genre:jazz' }).total, 0)
  override('collection', 'Album', null)
  assert.equal(browse.browse({ kind: 'release' }).items[0].classification, 'from-tracks')
})

test('exact canonical collection mapping joins alias folders without guessing album titles', (t) => {
  const { browse, source, drain, override, albums } = fixture(t)
  source('disc-one', { album: 'First', key: 'directory:1', genre: 'Jazz' })
  source('disc-two', { album: 'Second', key: 'directory:2', genre: 'Rock' })
  albums.clear()
  albums.set('canonical', ['directory:1', 'directory:2'])
  drain()
  override('collection', 'canonical', ['genre:classical'])
  const members = browse.members({ entityId: 'rel:Second' })
  assert.deepEqual(members.items[0].collectionTarget, { kind: 'collection', id: 'canonical' })
  assert.deepEqual(
    members.items[0].collectionClassification!.genres.items.map((g) => g.id),
    ['genre:classical']
  )
  assert.deepEqual(
    members.items[0].sourceClassification.genres.items.map((g) => g.id),
    ['genre:rock']
  )
  assert.equal(browse.browse({ kind: 'release', genreId: 'genre:classical' }).total, 2)
})

test('source precedence matches evidence API, including scoped ignore and imported alias conflicts', (t) => {
  const { sql, genres, browse, source, drain } = fixture(t)
  const target = source('one', { genre: 'Jazz' })
  drain()
  genres.ingest({
    target,
    key: 'external',
    provider: 'approved',
    origin: 'external',
    provenance: 'approved fixture',
    raw: { format: 'array', values: ['Rock'] }
  })
  assert.deepEqual(
    browse.browse({ kind: 'recording' }).items[0].genres.items.map((g) => g.id),
    ['genre:jazz']
  )
  genres.map({
    revision: genres.revision(),
    provider: 'local',
    value: 'Jazz',
    genreId: null,
    ignored: true
  })
  assert.deepEqual(
    browse.browse({ kind: 'recording' }).items[0].genres.items.map((g) => g.id),
    ['genre:rock']
  )
  sql.prepare('DELETE FROM music_genre_aliases WHERE provider=?').run('local')
  sql.exec(`INSERT INTO music_genre_alias_bridges VALUES('a','local','jazz','Jazz','genre:folk',0),
    ('b','local','jazz','Jazz','genre:blues',0);`)
  assert.deepEqual(
    browse.browse({ kind: 'recording' }).items[0].genres.items.map((g) => g.id),
    genres.evidence({ target }).selection.genreIds
  )
})

test('recording effective genres preserve imported unions and explicit clears without materializing all target levels', t => {
  const { sql, genres, browse, source, drain, override } = fixture(t)
  for (const id of ['source', 'external', 'imported', 'clear', 'unknown'])
    source(id, { genre: id === 'unknown' ? 'Unmapped fixture genre' : 'Jazz' })
  drain()
  for (const id of ['source', 'external', 'imported', 'clear']) genres.ingest({
    target: { kind: 'source', id }, key: 'external', provider: 'approved', origin: 'external',
    provenance: 'approved fixture', raw: { format: 'array', values: ['Rock'] }
  })
  genres.map({ revision: genres.revision(), provider: 'local', value: 'Jazz', genreId: null, ignored: true })
  genres.ingest({ target: { kind: 'source', id: 'source' }, key: 'valid-source', provider: 'approved', origin: 'source',
    provenance: 'source fixture', raw: { format: 'array', values: ['Blues'] } })
  sql.exec(`INSERT INTO music_genre_import_overrides VALUES
    ('source','imported','a','["genre:folk"]'),('source','imported','b','["genre:folk","genre:classical"]'),
    ('source','clear','a','["genre:folk"]');`)
  override('source', 'clear', [])
  const page = browse.browse({ kind: 'recording' })
  for (const row of page.items) {
    const id = row.id.slice('rec:'.length)
    assert.deepEqual(row.genres.items.map(g => g.id).sort(), genres.evidence({ target: { kind: 'source', id } }).selection.genreIds.sort())
  }
  assert.equal(page.items.find(row => row.id === 'rec:clear')!.genres.total, 0)
  assert.equal(page.items.find(row => row.id === 'rec:unknown')!.classification, 'none')
  const members = browse.members({ entityId: 'rec:clear' })
  assert.equal(members.items[0].sourceClassification.origin, 'manual')
  assert.equal(members.items[0].sourceClassification.genres.total, 0)
  const plan = sql.prepare(`EXPLAIN QUERY PLAN WITH RECURSIVE ${genreBrowseCtes({ kind: 'recording' })}
    SELECT * FROM selected_entities`).all(null, 0, null, '', 'recording', null)
  assert.equal(plan.some(row => String(row.detail).includes('MATERIALIZE target_levels')), false)
})

test('summaries stay bounded while totals and matching include every genre', (t) => {
  const { genres, browse, source, drain, override } = fixture(t)
  source('one')
  drain()
  const ids: string[] = []
  for (let i = 0; i < 40; i++)
    ids.push(
      genres.edit({
        action: 'create',
        revision: genres.revision(),
        name: `流派${i}`,
        nameEn: `Style ${i}`
      }).genreId!
    )
  override('source', 'one', ids)
  const page = browse.browse({ kind: 'recording', genreId: ids[39] })
  assert.equal(page.total, 1)
  assert.equal(page.items[0].genres.total, 40)
  assert.equal(page.items[0].genres.items.length, 32)
  assert.equal(page.items[0].genres.truncated, true)
  const members = browse.members({ entityId: 'rec:one', token: page.token })
  assert.equal(members.items[0].sourceClassification.genres.items.length, 32)
  assert.equal(members.items[0].sourceClassification.genres.total, 40)
})

test('every snapshot revision fences both pages and members without changing data on read', (t) => {
  const { sql, browse, source, drain, genres, changeContent, changeMetadata } = fixture(t)
  source('one', { genre: 'Jazz' })
  drain()
  const before = sql.prepare('SELECT total_changes() n').get()!.n
  let page = browse.browse({ kind: 'recording' })
  browse.members({ entityId: 'rec:one', token: page.token })
  assert.equal(sql.prepare('SELECT total_changes() n').get()!.n, before)
  const check = () => {
    assert.throws(() => browse.browse({ kind: 'recording', token: page.token }), {
      code: 'STALE_REVISION'
    })
    assert.throws(() => browse.members({ entityId: 'rec:one', token: page.token }), {
      code: 'STALE_REVISION'
    })
    page = browse.browse({ kind: 'recording' })
  }
  genres.edit({
    action: 'update',
    genreId: 'genre:jazz',
    name: '新爵士',
    revision: genres.revision()
  })
  check()
  sql.exec("UPDATE catalog_state SET value=CAST(value AS INTEGER)+1 WHERE key='revision'")
  check()
  changeContent()
  check()
  changeMetadata()
  check()
})

test('stale local projections disappear, missing in-library sources remain inspectable, and no title guessing occurs', (t) => {
  const { sql, browse, source, drain } = fixture(t)
  source('stale', { title: 'Same' })
  source('live', { title: 'Same' })
  source('offline', { provider: 'fixture', title: 'Same', availability: 'missing' })
  drain()
  sql.prepare('INSERT INTO catalog_pending VALUES(?)').run('stale')
  const page = browse.browse({ kind: 'recording', search: 'Same' })
  assert.equal(page.total, 2)
  assert.deepEqual(browse.members({ entityId: 'rec:stale' }).items, [])
  assert.equal(browse.members({ entityId: 'rec:offline' }).items[0].availability, 'missing')
})

test('public browse and members validation rejects arbitrary parameters, huge pages and incomplete tokens', () => {
  assert.equal(validGenreBrowsePayload('genres.browse', { kind: 'recording', limit: 200 }), true)
  assert.equal(
    validGenreBrowsePayload('genres.members', { entityId: 'exact', source: 'local' }),
    true
  )
  assert.equal(
    validGenreBrowsePayload('genres.browse', { kind: 'recording', genre: 'Jazz' }),
    false
  )
  assert.equal(validGenreBrowsePayload('genres.browse', { kind: 'recording', limit: 201 }), false)
  assert.equal(
    validGenreBrowsePayload('genres.members', { entityId: 'exact', platformContexts: {} }),
    false
  )
  assert.equal(
    validGenreBrowseToken({ genresRevision: 1, catalogRevision: 1, contentRevision: 1 }),
    false
  )
  assert.equal(
    validGenreBrowsePayload('genres.facets', { kind: 'recording', dimension: 'format' }),
    true
  )
  assert.equal(
    validGenreBrowsePayload('genres.facets', { kind: 'recording', dimension: 'qualityStars' }),
    false
  )
  assert.equal(
    validGenreBrowsePayload('genres.facets', {
      kind: 'recording',
      dimension: 'format',
      filters: [
        { dimension: 'format', values: ['FLAC'] },
        { dimension: 'format', values: ['MP3'] }
      ]
    }),
    false
  )
})

test('facets and member pages retain the same source-row filters, genre scope, entity search and distinct entity counts', (t) => {
  const { sql, browse, source, drain } = fixture(t)
  source('local16', {
    genre: 'Jazz',
    recording: 'combined',
    title: 'Target',
    fields: { format: 'FLAC', bitDepth: 16, sampleRate: 44100 }
  })
  source('cloud24', {
    genre: 'Rock',
    recording: 'combined',
    title: 'Target',
    provider: 'fixture',
    fields: { format: 'FLAC', bitDepth: 24, sampleRate: 96000 }
  })
  source('other', { genre: 'Jazz', title: 'Other', fields: { format: 'ALAC', bitDepth: 24 } })
  sql.exec(`INSERT INTO catalog_memberships VALUES('second-owner','local16');`)
  drain()
  const noCrossSource = browse.browse({
    kind: 'recording',
    source: 'local',
    filters: [{ dimension: 'bitDepth', values: ['24'] }],
    search: 'Target'
  })
  assert.equal(noCrossSource.total, 0)
  const query = {
    kind: 'recording' as const,
    search: 'Target',
    genreId: 'genre:rock',
    filters: [{ dimension: 'bitDepth' as const, values: ['24'] }]
  }
  const page = browse.browse(query)
  assert.equal(page.total, 1)
  assert.equal(page.items[0].sourceCount, 1)
  const facet = browse.facets({ ...query, dimension: 'format', token: page.token })
  assert.equal(facet.total, 1)
  assert.deepEqual(facet.items, [{ value: 'FLAC', label: 'FLAC', count: 1 }])
  const pastFacets = browse.facets({ ...query, dimension: 'format', token: page.token, offset: 10 })
  assert.equal(pastFacets.total, 1)
  assert.deepEqual(pastFacets.items, [])
  const emptyFacets = browse.facets({ kind: 'recording', genreId: 'absent', dimension: 'format' })
  assert.equal(emptyFacets.total, 0)
  assert.deepEqual(emptyFacets.items, [])
  const { kind: _kind, ...memberQuery } = query
  const members = browse.members({ ...memberQuery, entityId: 'combined', token: page.token })
  assert.deepEqual(
    members.items.map((s) => s.sourceId),
    ['cloud24']
  )
  assert.deepEqual(browse.facets({ kind: 'recording', dimension: 'format' }).items, [
    { value: 'ALAC', label: 'ALAC', count: 1 },
    { value: 'FLAC', label: 'FLAC', count: 1 }
  ])
  const unavailable = browse.facets({ kind: 'recording', dimension: 'language' })
  assert.equal(unavailable.available, false)
  assert.deepEqual(unavailable.items, [{ value: 'unknown', label: '未知', count: 2 }])
})

test('recording plans resolve album bindings only for requested release dimensions', t => {
  const { sql, browse, source, drain } = fixture(t)
  source('one', { album: 'Album', genre: 'Jazz', fields: { format: 'FLAC', releaseDate: '2020' } })
  sql.exec(`INSERT INTO catalog_entities VALUES('manual-release','release','Bound album','Artist','manual');
    INSERT INTO catalog_versions VALUES('albums','v','manual-release','V',NULL,NULL,NULL);
    INSERT INTO catalog_version_sources VALUES('albums','album:local:Album','v');
    INSERT INTO catalog_release_projects VALUES('manual-release','manual-project');
    INSERT INTO metadata_identity_links VALUES('manual-release','confirmed','target:release'),
      ('manual-project','confirmed','target:project');
    INSERT INTO metadata_facts VALUES('target:release','country','{"value":"GB"}'),
      ('target:release','releaseDate','{"value":"2011"}'),
      ('target:project','firstReleaseDate','{"value":"1973"}'),
      ('target:project','primaryType','{"value":"Album"}');`)
  drain()
  const prepare = sql.prepare.bind(sql)
  let captured: { text: string; params: SQLInputValue[] } | undefined
  sql.prepare = text => {
    const statement = prepare(text)
    if (text.includes('selected_entities AS MATERIALIZED')) {
      const all = statement.all.bind(statement)
      Object.defineProperty(statement, 'all', { value: (...params: SQLInputValue[]) => {
        captured = { text, params }
        return all(...params)
      } })
    }
    return statement
  }
  t.after(() => { sql.prepare = prepare })
  const planDetails = () => prepare(`EXPLAIN QUERY PLAN ${captured!.text}`).all(...captured!.params)
    .map(row => String(row.detail))
  browse.facets({ kind: 'recording', genreId: 'genre:jazz', dimension: 'format' })
  assert.equal(planDetails().some(detail => /SEARCH (als|av) USING INDEX/.test(detail)), false)
  assert.ok(planDetails().some(detail => detail.includes('SEARCH tv USING INDEX')))
  for (const [dimension, value] of [
    ['region', 'GB'], ['releaseYear', '2011'], ['projectYear', '1973'], ['albumType', 'album'],
    ['management', 'release_confirmed']
  ] as const) {
    const page = browse.facets({ kind: 'recording', dimension })
    assert.ok(page.items.some(item => item.value === value), dimension)
    assert.ok(planDetails().some(detail => detail.includes('SEARCH av USING INDEX')), dimension)
    const filtered = browse.facets({ kind: 'recording', dimension: 'format', filters: [{ dimension, values: [value] }] })
    assert.deepEqual(filtered.items.map(item => item.value), ['FLAC'], dimension)
    assert.ok(planDetails().some(detail => detail.includes('SEARCH av USING INDEX')), dimension)
  }
})

test('facets use every filtered source of manual bindings, not only genre evidence or a result page', t => {
  const { sql, browse, source, drain, override } = fixture(t)
  source('jazz', { genre: 'Jazz', fields: { format: ' flac ', bitDepth: 16 } })
  source('flac-copy', { genre: 'Rock', fields: { format: 'FLAC', bitDepth: 24 } })
  source('rock', { provider: 'fixture', genre: 'Rock', fields: { format: 'AAC', bitDepth: 24 } })
  source('unknown', { fields: { format: '', bitDepth: 24 } })
  source('invalid-format', { fields: { format: 42, bitDepth: 24 } })
  source('long-format', { fields: { format: 'x'.repeat(65), bitDepth: 24 } })
  source('cached', { provider: 'fixture', genre: 'Jazz', member: false, fields: { format: 'MP3' } })
  source('other-jazz', { title: 'Target extra', genre: 'Jazz', fields: { format: 'ALAC', bitDepth: 16 } })
  source('other-rock', { title: 'Target excluded', genre: 'Rock', fields: { format: 'MP3' } })
  sql.exec(`INSERT INTO catalog_entities VALUES('manual','recording','Target combined','Artist','manual');
    INSERT INTO catalog_versions VALUES('tracks','v','manual','V',NULL,NULL,NULL);
    INSERT INTO catalog_version_sources VALUES('tracks','key:jazz','v'),('tracks','key:flac-copy','v'),
      ('tracks','key:rock','v'),('tracks','key:unknown','v'),('tracks','key:invalid-format','v'),
      ('tracks','key:long-format','v'),('tracks','key:cached','v');
    INSERT INTO catalog_memberships VALUES('second-owner','jazz');`)
  drain()
  const query = { kind: 'recording' as const, genreId: 'genre:jazz', search: 'Target', dimension: 'format' as const }
  const first = browse.facets({ ...query, limit: 1 })
  assert.equal(first.total, 4)
  assert.deepEqual(first.items.map(row => [row.value, row.count]), [['AAC', 1]])
  const rest = browse.facets({ ...query, token: first.token, limit: 3, offset: 1 })
  assert.equal(rest.total, 4)
  assert.deepEqual(rest.items.map(row => [row.value, row.count]), [['ALAC', 1], ['FLAC', 1], ['unknown', 1]])
  const local = browse.facets({ ...query, search: 'Target combined', source: 'local' })
  assert.deepEqual(local.items.map(row => [row.value, row.count]), [['FLAC', 1], ['unknown', 1]])
  assert.deepEqual(browse.facets({ ...query, search: 'Target combined', source: 'fixture' }).items, [])
  assert.deepEqual(browse.facets({ ...query, search: 'Target combined', filters: [
    { dimension: 'bitDepth', values: ['24'] }
  ] }).items, [])
  const filtered = browse.facets({ ...query, genreId: 'genre:rock', search: 'Target combined', filters: [
    { dimension: 'bitDepth', values: ['24'] }
  ] })
  assert.deepEqual(filtered.items.map(row => [row.value, row.count]), [['AAC', 1], ['FLAC', 1], ['unknown', 1]])
  const reused = browse.facets({ ...query, search: 'Target combined', filters: [
    { dimension: 'format', values: ['FLAC'] }
  ] })
  assert.deepEqual(reused.items.map(row => [row.value, row.count]), [['FLAC', 1]])
  assert.deepEqual(browse.facets({ ...query, search: 'Target combined', filters: [
    { dimension: 'format', values: ['unknown'] }
  ] }).items, [])
  assert.deepEqual(browse.facets({ ...query, genreId: undefined, search: 'Target combined', filters: [
    { dimension: 'format', values: ['unknown'] }
  ] }).items.map(row => [row.value, row.count]), [['unknown', 1]])
  override('source', 'jazz', [])
  assert.deepEqual(browse.facets({ ...query, search: 'Target combined' }).items, [])
})

test('release facets retain direct collection values and explicit clears across bound providers', t => {
  const { sql, browse, source, drain, override } = fixture(t)
  source('local', { album: 'Local', genre: 'Jazz', fields: { format: 'FLAC' } })
  source('unknown', { album: 'Local' })
  source('cloud', { provider: 'fixture', album: 'Cloud', genre: 'Rock', fields: { albumId: 'cloud-id', format: 'AAC' } })
  sql.exec(`INSERT INTO catalog_entities VALUES('manual-album','release','Combined','Artist','manual');
    INSERT INTO catalog_versions VALUES('albums','v','manual-album','V',NULL,NULL,NULL);
    INSERT INTO catalog_version_sources VALUES('albums','album:local:Local','v'),('albums','album:fixture:Cloud','v');`)
  drain()
  const query = { kind: 'release' as const, dimension: 'format' as const },
    formats = [['AAC', 1], ['FLAC', 1], ['unknown', 1]]
  assert.deepEqual(browse.facets({ ...query, genreId: 'genre:jazz' }).items.map(row => [row.value, row.count]), formats)
  override('collection', 'Local', ['genre:classical'])
  assert.deepEqual(browse.facets({ ...query, genreId: 'genre:classical' }).items.map(row => [row.value, row.count]), formats)
  assert.deepEqual(browse.facets({ ...query, genreId: 'genre:jazz' }).items, [])
  override('collection', 'Local', [])
  assert.deepEqual(browse.facets({ ...query, genreId: 'genre:jazz' }).items, [])
  assert.deepEqual(browse.facets({ ...query, genreId: 'genre:classical' }).items, [])
  assert.deepEqual(browse.facets(query).items.map(row => [row.value, row.count]), formats)
  assert.deepEqual(browse.facets({ ...query, source: 'fixture', genreId: 'genre:rock' }).items.map(row => [row.value, row.count]), [['AAC', 1]])
  override('collection', 'Local', null)
  assert.deepEqual(browse.facets({ ...query, genreId: 'genre:jazz' }).items.map(row => [row.value, row.count]), formats)
})

test('facets expose only currently licensed account facts and retain source-local metadata filters', t => {
  const { sql, browse, source, drain, setNow } = fixture(t)
  source('local', { album: 'Album', genre: 'Jazz', fields: { format: 'FLAC' } })
  source('cloud', { provider: 'fixture', album: 'Album', genre: 'Jazz', fields: { albumId: 'album-id', format: 'AAC' } })
  drain()
  sql.exec(`INSERT INTO metadata_identity_links VALUES('rel:Album','confirmed','target:album');
    INSERT INTO metadata_facts VALUES('target:album','country','{}');`)
  const expiresAt = 1700000001000,
    context = { platformContexts: { fixture: 'account-one' } },
    query = { kind: 'recording' as const, genreId: 'genre:jazz', dimension: 'region' as const }
  const fact = (usage: { display?: boolean; cache?: boolean; crossSource?: boolean } = {}) => sql.prepare(
    "UPDATE metadata_facts SET payload=? WHERE target_id='target:album' AND field='country'"
  ).run(JSON.stringify({ value: 'CN', sourceProvider: 'fixture', providerContext: 'account-one',
    usage: { display: true, cache: true, crossSource: false, expiresAt, ...usage } }))
  const values = (page: ReturnType<typeof browse.facets>) => page.items.map(row => [row.value, row.count])
  fact()
  assert.deepEqual(values(browse.facets(query)), [['unknown', 2]])
  assert.deepEqual(values(browse.facets(query, context)), [['CN', 1], ['unknown', 1]])
  assert.deepEqual(values(browse.facets({ ...query, source: 'local' }, context)), [['unknown', 1]])
  assert.deepEqual(values(browse.facets({ ...query, source: 'fixture' }, context)), [['CN', 1]])
  assert.deepEqual(values(browse.facets(query, { platformContexts: { fixture: 'account-two' } })), [['unknown', 2]])
  const formatQuery = { ...query, dimension: 'format' as const, filters: [
    { dimension: 'region' as const, values: ['CN'] }
  ] }
  assert.deepEqual(values(browse.facets(formatQuery, context)), [['AAC', 1]])
  fact({ crossSource: true })
  assert.deepEqual(values(browse.facets(query, context)), [['CN', 2]])
  assert.deepEqual(values(browse.facets(formatQuery, context)), [['AAC', 1], ['FLAC', 1]])
  for (const denied of [{ display: false }, { cache: false }]) {
    fact(denied)
    assert.deepEqual(values(browse.facets(query, context)), [['unknown', 2]])
    assert.deepEqual(browse.facets(formatQuery, context).items, [])
  }
  fact()
  const beforeExpiry = browse.facets(query, context)
  assert.equal(beforeExpiry.token.expiresAt, expiresAt)
  setNow(expiresAt)
  assert.throws(() => browse.facets({ ...query, token: beforeExpiry.token }, context), { code: 'STALE_REVISION' })
  const expired = browse.facets(query, context)
  assert.deepEqual(values(expired), [['unknown', 2]])
  assert.deepEqual(browse.facets(formatQuery, context).items, [])
  assert.deepEqual(values(browse.facets({ ...query, token: { ...expired.token, asOf: 1700000000000 } }, context)), [['unknown', 2]])
})

test('metadata expiry and account context invalidate every read path and cannot revive expired facts with a forged clock', (t) => {
  const { sql, browse, source, drain, setNow } = fixture(t)
  source('one', { provider: 'fixture', album: 'Album', fields: { albumId: 'album-identity' } })
  drain()
  sql.exec(`INSERT INTO metadata_identity_links VALUES('rel:Album','confirmed','target:album');`)
  const expiresAt = 1700000001000
  sql.prepare('INSERT INTO metadata_facts VALUES(?,?,?)').run(
    'target:album',
    'country',
    JSON.stringify({
      value: 'CN',
      sourceProvider: 'fixture',
      providerContext: 'account-one',
      usage: { display: true, cache: true, crossSource: false, expiresAt }
    })
  )
  const context = { platformContexts: { fixture: 'account-one' } }
  const query = {
    kind: 'release' as const,
    filters: [{ dimension: 'region' as const, values: ['CN'] }]
  }
  const page = browse.browse(query, context)
  assert.equal(page.total, 1)
  assert.equal(page.token.expiresAt, expiresAt)
  assert.equal(JSON.stringify(page.token).includes('account-one'), false)
  setNow(1700000000500)
  assert.deepEqual(browse.browse({ ...query, token: page.token }, context).token, page.token)
  assert.equal(
    browse.facets({ ...query, dimension: 'region', token: page.token }, context).items[0].value,
    'CN'
  )
  assert.throws(
    () =>
      browse.members(
        { entityId: 'rel:Album', token: page.token },
        { platformContexts: { fixture: 'account-two' } }
      ),
    { code: 'STALE_REVISION' }
  )
  const next = browse.browse(query, context)
  setNow(expiresAt)
  assert.throws(() => browse.browse({ ...query, token: next.token }, context), {
    code: 'STALE_REVISION'
  })
  assert.throws(
    () => browse.facets({ ...query, dimension: 'region', token: next.token }, context),
    { code: 'STALE_REVISION' }
  )
  assert.throws(() => browse.members({ entityId: 'rel:Album', token: next.token }, context), {
    code: 'STALE_REVISION'
  })
  const fresh = browse.browse(query, context)
  assert.equal(fresh.total, 0)
  assert.equal(
    browse.browse({ ...query, token: { ...fresh.token, asOf: 1700000000000 } }, context).total,
    0
  )
})

test('manual collection direct values are scoped to the selected provider, not copied into cloud tracks', (t) => {
  const { sql, browse, source, drain, override } = fixture(t)
  source('local', { album: 'Local', genre: 'Jazz' })
  source('cloud', {
    provider: 'fixture',
    album: 'Cloud',
    genre: 'Rock',
    fields: { albumId: 'cloud-id' }
  })
  sql.exec(`INSERT INTO catalog_entities VALUES('manual-album','release','Combined','Artist','manual');
    INSERT INTO catalog_versions VALUES('albums','v','manual-album','V',NULL,NULL,NULL);
    INSERT INTO catalog_version_sources VALUES('albums','album:local:Local','v'),('albums','album:fixture:Cloud','v');`)
  drain()
  override('collection', 'Local', [])
  assert.equal(browse.browse({ kind: 'release' }).items[0].genres.total, 0)
  const cloud = browse.browse({ kind: 'release', source: 'fixture' }).items[0]
  assert.equal(cloud.classification, 'from-tracks')
  assert.deepEqual(
    cloud.genres.items.map((g) => g.id),
    ['genre:rock']
  )
  assert.equal(
    browse.browse({ kind: 'recording', source: 'fixture', genreId: 'genre:rock' }).total,
    1
  )
})

test('platform album keys expose one direct collection target across real tracks, including clear and reset', (t) => {
  const { browse, genres, source, drain, override } = fixture(t)
  source('cloud-one', {
    provider: 'fixture',
    album: 'Cloud',
    genre: 'Jazz',
    fields: { albumId: 'cloud-id' }
  })
  source('cloud-two', {
    provider: 'fixture',
    album: 'Cloud',
    genre: 'Rock',
    fields: { albumId: 'cloud-id' }
  })
  source('cached-only', {
    provider: 'fixture',
    album: 'Cached',
    genre: 'Classical',
    member: false,
    fields: { albumId: 'cached-id' }
  })
  drain()
  const targetId = 'album:fixture:Cloud'
  let members = browse.members({ entityId: 'rel:Cloud' })
  assert.equal(members.total, 2)
  assert.deepEqual(
    members.items.map((item) => item.collectionTarget),
    [
      { kind: 'collection', id: targetId },
      { kind: 'collection', id: targetId }
    ]
  )
  override('collection', targetId, ['genre:classical', 'genre:folk'])
  let album = browse.browse({ kind: 'release', source: 'fixture' }).items[0]
  assert.equal(album.classification, 'direct')
  assert.deepEqual(album.genres.items.map((item) => item.id).sort(), [
    'genre:classical',
    'genre:folk'
  ])
  members = browse.members({ entityId: 'rel:Cloud' })
  assert.ok(members.items.every((item) => item.collectionClassification?.origin === 'manual'))
  assert.ok(members.items.every((item) => item.collectionClassification?.genres.total === 2))
  assert.equal(browse.browse({ kind: 'recording', genreId: 'genre:classical' }).total, 0)
  override('collection', targetId, [])
  album = browse.browse({ kind: 'release', source: 'fixture' }).items[0]
  assert.equal(album.classification, 'direct')
  assert.equal(album.genres.total, 0)
  override('collection', targetId, null)
  album = browse.browse({ kind: 'release', source: 'fixture' }).items[0]
  assert.equal(album.classification, 'from-tracks')
  assert.deepEqual(album.genres.items.map((item) => item.id).sort(), ['genre:jazz', 'genre:rock'])
  assert.equal(browse.members({ entityId: 'rel:Cached' }).total, 0)
  assert.equal(browse.browse({ kind: 'release', source: 'fixture' }).total, 1)
  assert.throws(
    () =>
      genres.override({
        target: { kind: 'collection', id: 'album:fixture:Cached' },
        genreIds: [],
        revision: genres.revision()
      }),
    /专辑集合不存在/
  )
})

test('platform album names without real album IDs retain isolated releases and no direct collection target', (t) => {
  const { browse, source, drain, sql, override } = fixture(t)
  source('one', { provider: 'fixture', album: 'Same title', genre: 'Jazz' })
  source('two', {
    provider: 'fixture',
    album: 'Same title',
    genre: 'Rock',
    fields: { albumId: '   ' }
  })
  source('three', {
    provider: 'fixture',
    album: 'Same title',
    genre: 'Folk',
    fields: { albumId: 123 }
  })
  source('four', {
    provider: 'fixture',
    album: 'Same title',
    genre: 'Blues',
    fields: { albumId: '\t\r\n' }
  })
  source('five', {
    provider: 'fixture',
    album: 'Same title',
    genre: 'Metal',
    fields: { albumId: '\u3000\uFEFF' }
  })
  drain()
  const page = browse.browse({ kind: 'release', source: 'fixture' })
  assert.equal(page.total, 5)
  assert.ok(
    page.items.every((item) => item.sourceCount === 1 && item.classification === 'from-tracks')
  )
  for (const item of page.items) {
    const members = browse.members({ entityId: item.id, token: page.token })
    assert.equal(members.total, 1)
    assert.equal(members.items[0].collectionTarget, null)
    assert.equal(members.items[0].collectionClassification, null)
  }
  assert.throws(() => override('collection', 'album:fixture:Same title', []), /专辑集合不存在/)
  // Even an old retained collection override cannot promote a name-derived key.
  sql
    .prepare('INSERT INTO music_genre_overrides VALUES(?,?,?)')
    .run('collection', 'album:fixture:Same title', '["genre:classical"]')
  assert.equal(browse.browse({ kind: 'release', genreId: 'genre:classical' }).total, 0)
  assert.equal(browse.browse({ kind: 'release', genreId: 'genre:jazz' }).total, 1)
})

test('each read freezes one SQL clock and rejects the whole result if a fact expires before delivery', (t) => {
  const { sql, browse, source, drain, setClock } = fixture(t)
  source('one', { album: 'Album' })
  drain()
  sql.exec(`INSERT INTO metadata_identity_links VALUES('rel:Album','confirmed','target:album');`)
  const start = 1700000000000,
    expiry = start + 100
  sql
    .prepare('INSERT INTO metadata_facts VALUES(?,?,?)')
    .run(
      'target:album',
      'country',
      JSON.stringify({ value: 'CN', usage: { display: true, cache: true, expiresAt: expiry } })
    )
  let calls = 0
  setClock(() => (++calls === 1 ? start : expiry))
  assert.throws(() => browse.browse({ kind: 'release' }), { code: 'STALE_REVISION' })
  assert.equal(calls, 2)
  assert.equal(sql.isTransaction, false)
  calls = 0
  assert.throws(() => browse.facets({ kind: 'release', dimension: 'region' }), {
    code: 'STALE_REVISION'
  })
  assert.equal(calls, 2)
  calls = 0
  assert.throws(() => browse.members({ entityId: 'rel:Album' }), { code: 'STALE_REVISION' })
  assert.equal(calls, 2)
})
