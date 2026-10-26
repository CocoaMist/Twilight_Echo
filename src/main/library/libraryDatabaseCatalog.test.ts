import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { LibraryDatabase } from './libraryDatabase.ts'
import { emptyMusicVersions } from '../../shared/musicVersions.ts'
import { versionSourceKey } from '../../shared/trackSourceIdentity.ts'
import { getAlbumIdentity } from '../../shared/libraryIdentity.ts'
import type { TrackData } from '../../shared/track.ts'
import { LEGACY_CATALOG_SCHEMA_SQL } from './legacyQueueSchema.fixture.ts'
import { CATALOG_MEMBERSHIP_ADDED_PREFIX } from './libraryDatabaseCatalog.ts'
import type { CatalogEntity, CatalogKind, CatalogPage, CatalogQuery } from '../../shared/musicCatalog.ts'

const track = (id: string, extra: Partial<TrackData> = {}): TrackData => ({
  id,
  title: 'Same title',
  artist: 'Same artist',
  album: 'Album',
  source: 'local',
  filePath: `D:/music/${id}.flac`,
  fileName: `${id}.flac`,
  duration: 200,
  size: 0,
  cover: null,
  lyrics: null,
  ...extra
})
const seed = (db: LibraryDatabase, tracks: TrackData[]) =>
  db.replaceDocument({
    version: 2,
    revision: 1,
    tracks,
    folders: ['D:/music'],
    exclusions: []
  })
function memory(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  return db
}
function drain(db: LibraryDatabase, limit = 200) {
  while (db.catalogStatus().localPending) db.catalogAdvance(limit)
}
function remote(db: LibraryDatabase, tracks: TrackData[], revision = 1) {
  let job = db.catalogSync({ kind: 'begin', revision })
  job = db.catalogSync({ kind: 'append', ...job, tracks })
  db.catalogSync({ kind: 'commit', ...job })
}

test('catalog shared count/page preserves kind counts, empty results and beyond-tail offsets', t => {
  const db = memory(t)
  seed(db, [track('local')]); drain(db)
  remote(db, [track('ncm:1', { source: 'ncm', filePath: '', albumId: 'remote' })])
  const page = db.catalogQuery({ kind: 'recording', limit: 1, offset: 99 })
  assert.equal(page.total, 2); assert.deepEqual(page.items, [])
  assert.equal(db.catalogQuery({ kind: 'release', limit: 1 }).total, 2)
  assert.equal(db.catalogQuery({ kind: 'album_project', limit: 1 }).total, 2)
  const empty = db.catalogQuery({ kind: 'recording', search: 'no such title' })
  assert.equal(empty.total, 0); assert.deepEqual(empty.items, [])
})

/** Independent oracle using the complete original effective-binding view. */
function bindingViewPage(db: LibraryDatabase, query: CatalogQuery): CatalogPage {
  const conditions = ['e.kind=?'], params: SQLInputValue[] = [query.kind]
  if (query.scope !== 'all')
    conditions.push('EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)')
  if (query.source) {
    conditions.push('s.provider=?')
    params.push(query.source)
  }
  if (query.search) {
    conditions.push("instr(lower(e.title || ' ' || e.artist),lower(?))>0")
    params.push(query.search)
  }
  const context = query.context
  if (context) {
    conditions.push("s.availability<>'missing'", `s.provider<>'local' OR (
      EXISTS(SELECT 1 FROM tracks t WHERE t.id=s.track_id) AND
      NOT EXISTS(SELECT 1 FROM catalog_pending p WHERE p.track_id=s.track_id))`)
    if (context.type === 'track') {
      conditions.push('s.provider=? AND s.track_id=?')
      params.push(context.provider, context.id)
    } else if (context.type === 'native') {
      if (query.kind === 'artist') {
        conditions.push("e.id IN (SELECT entity_id FROM catalog_aliases WHERE namespace='source.artist' AND key=?)")
        params.push(JSON.stringify([context.provider, context.id]))
      } else {
        conditions.push("s.release_id IN (SELECT entity_id FROM catalog_aliases WHERE namespace='source.release' AND key=?)")
        params.push(JSON.stringify(['album', context.provider, `id:${context.id}`]))
      }
    } else {
      throw new Error('Collection contexts are covered by CatalogReferences tests')
    }
  }
  const rows = db.sql.prepare(`SELECT e.*,count(*) source_count FROM catalog_entity_sources b
    JOIN catalog_sources s ON s.id=b.source_id JOIN catalog_entities e ON e.id=b.entity_id
    WHERE ${conditions.map(value => `(${value})`).join(' AND ')}
    GROUP BY e.id ORDER BY e.title COLLATE NOCASE,e.id`).all(...params)
  const offset = query.offset ?? 0
  return {
    revision: db.catalogStatus().revision, offset, total: rows.length,
    items: rows.slice(offset, offset + (query.limit ?? 200)).map(row => ({
      id: String(row.id), kind: row.kind as CatalogKind, title: String(row.title),
      artist: String(row.artist), identity: row.identity as CatalogEntity['identity'],
      sourceCount: Number(row.source_count)
    }))
  }
}

test('kind-specific catalog pages match the full binding view across membership and manual-version states', t => {
  const db = memory(t), local = track('shared', { title: 'alpha', album: 'First' }),
    tie = track('tie', { title: 'Alpha', album: 'Second' }),
    untagged = track('untagged', { title: '100% literal', artist: '', album: '' }),
    online = track('shared', {
      source: 'ncm', filePath: '', title: 'Alpha', albumId: 'native',
      artists: [{ id: 42, name: 'Same artist' }]
    }),
    other = track('other', {
      source: 'ncm', filePath: '', title: 'beta', albumId: 'other',
      artists: [{ id: 42, name: 'Same artist' }]
    }),
    cached = track('cached', { source: 'ncm', filePath: '', title: 'alpha cache', albumId: 'cached' })
  seed(db, [local, tie, untagged]); drain(db)
  remote(db, [online, other])
  let job = db.catalogSync({ kind: 'begin', revision: 2 })
  job = db.catalogSync({ kind: 'append', ...job, tracks: [cached] })
  db.catalogSync({ kind: 'abort', id: job.id })
  db.sql.prepare('INSERT INTO catalog_memberships VALUES(?,?)').run('another-owner', sourceId(db, local))
  const kinds: CatalogKind[] = ['recording', 'release', 'artist', 'album_project']
  function compare(state: string) {
    const changes = db.sql.prepare('SELECT total_changes() n').get()!.n
    for (const kind of kinds) {
      const queries: CatalogQuery[] = [
        { kind }, { kind, scope: 'all' }, { kind, scope: 'all', source: 'ncm' },
        { kind, source: 'local' }, { kind, source: 'unavailable' },
        { kind, search: 'alpha', limit: 1 }, { kind, search: 'ALPHA SAME ARTIST' },
        { kind, scope: 'all', search: '%' }, { kind, search: 'not present' },
        { kind, limit: 1 }, { kind, limit: 1, offset: 1 }, { kind, limit: 1, offset: 99 },
        { kind, context: { type: 'track', provider: 'local', id: local.id } },
        { kind, context: { type: 'track', provider: 'ncm', id: online.id } },
        { kind, scope: 'all', context: { type: 'track', provider: 'ncm', id: cached.id } }
      ]
      if (kind !== 'recording') queries.push(
        { kind, context: { type: 'native', provider: 'ncm', id: kind === 'artist' ? '42' : 'native' } },
        { kind, source: 'local', context: { type: 'native', provider: 'ncm', id: kind === 'artist' ? '42' : 'native' } }
      )
      for (const query of queries)
        assert.deepEqual(db.catalogQuery(query), bindingViewPage(db, query), `${state}: ${JSON.stringify(query)}`)
    }
    assert.equal(db.sql.prepare('SELECT total_changes() n').get()!.n, changes, 'queries are read-only')
  }
  compare('native sources, same-name ties and cache-only source')
  const versions = emptyMusicVersions()
  versions.tracks.versions = [{
    id: 'joined', label: 'Alpha', sources: [versionSourceKey(local), versionSourceKey(online)],
    preferredSource: versionSourceKey(online)
  }]
  versions.albums.versions = [{
    id: 'joined', label: 'Edition', sources: [local, online].map(value =>
      JSON.stringify(['album', value.source, getAlbumIdentity(value)])), preferredSource: null
  }]
  db.catalogProjectVersions(versions, 1)
  compare('manual track and album bindings')
  const joined = db.catalogQuery({ kind: 'recording' }).items.find(item => item.identity === 'manual')!
  assert.equal(joined.sourceCount, 2, 'multiple membership owners do not multiply sources')
  assert.equal(db.catalogQuery({ kind: 'recording', source: 'ncm' }).items.find(item => item.id === joined.id)!.sourceCount, 1)
  db.patchTracks([{ id: local.id, expectedVersion: 1, patch: { title: 'Pending edit' } }])
  compare('pending local projection')
  assert.equal(db.catalogQuery({ kind: 'recording', context: { type: 'track', provider: 'local', id: local.id } }).total, 0)
  assert.equal(db.catalogQuery({ kind: 'recording' }).items.find(item => item.id === joined.id)!.sourceCount, 2,
    'default membership browsing retains the original pending-source contract')
  db.sql.prepare("UPDATE catalog_sources SET availability='missing' WHERE source_key=?").run(versionSourceKey(online))
  compare('missing remote source retains membership')
  assert.equal(db.catalogQuery({ kind: 'recording', context: { type: 'track', provider: 'ncm', id: online.id } }).total, 0)
  assert.equal(db.catalogQuery({ kind: 'recording' }).items.find(item => item.id === joined.id)!.sourceCount, 2)
  seed(db, [tie, untagged])
  compare('removed local Track before maintenance')
  drain(db)
  compare('removed local projection published')
  db.catalogProjectVersions(emptyMusicVersions(), 2)
  compare('manual bindings reset')
})

test('catalog query plans use one source relation and materialize only paging fields before the page', t => {
  const db = memory(t)
  seed(db, [track('one'), track('two')]); drain(db)
  const prepare = db.sql.prepare.bind(db.sql), captured: string[] = []
  t.mock.method(db.sql, 'prepare', (query: string) => {
    if (query.startsWith('WITH candidates')) captured.push(query)
    return prepare(query)
  })
  for (const kind of ['recording', 'release', 'artist', 'album_project'] as const) {
    db.catalogQuery({ kind, limit: 2 })
    const query = captured.at(-1)!
    const plan = prepare(`EXPLAIN QUERY PLAN ${query}`).all(kind, 2, 0).map(row => String(row.detail))
    assert.equal((query.match(/\bcatalog_sources\b/gu) ?? []).length, 1)
    assert.equal(query.includes('catalog_bindings'), false)
    assert.match(query, /matched AS MATERIALIZED \(SELECT e\.id,e\.title,c\.source_count/u)
    assert.match(query, /LEFT JOIN page p ON 1 LEFT JOIN catalog_entities e ON e\.id=p\.id/u)
    assert.ok(plan.some(detail => detail === 'MATERIALIZE matched'))
    if (kind === 'artist') {
      assert.equal(query.includes('catalog_versions'), false)
    } else {
      assert.match(query, new RegExp(`b.scope='${kind === 'recording' ? 'tracks' : 'albums'}'`, 'u'))
      assert.equal(query.includes(`b.scope='${kind === 'recording' ? 'albums' : 'tracks'}'`), false)
      assert.equal(plan.filter(detail => /SEARCH v USING INDEX/u.test(detail)).length, 1)
    }
  }
})

test('catalog incrementally preserves IDs across metadata edits, removal, reimport and selector changes', (t) => {
  const db = memory(t),
    a = track('old')
  seed(db, [a])
  drain(db, 1)
  const revision = db.getContentRevision()
  const first = db.catalogQuery({ kind: 'recording' }).items[0]
  const source = db.catalogSources({ entityId: first.id }).items[0]
  assert.equal(db.catalogResolve(source.id, db.catalogStatus().revision)?.filePath, a.filePath)
  seed(db, [track('new', { filePath: a.filePath, title: 'Renamed', album: 'Retagged' })])
  drain(db, 1)
  assert.equal(db.catalogQuery({ kind: 'recording' }).items[0].id, first.id)
  assert.equal(db.catalogSources({ entityId: first.id }).items[0].id, source.id)
  assert.equal(db.catalogQuery({ kind: 'recording' }).items[0].title, 'Renamed')
  assert.equal(
    db.getContentRevision(),
    revision + 1,
    'derived writes do not touch scan/content revision'
  )
  seed(db, [])
  drain(db)
  assert.equal(db.catalogQuery({ kind: 'recording' }).total, 0)
  assert.equal(db.catalogSources({ entityId: first.id }).items[0].availability, 'missing')
  assert.equal(db.catalogResolve(source.id, db.catalogStatus().revision), null)
  seed(db, [a])
  drain(db)
  assert.equal(db.catalogQuery({ kind: 'recording' }).items[0].id, first.id)
  seed(db, [track('old', { filePath: 'D:/other.flac' })])
  drain(db)
  assert.equal(db.catalogQuery({ kind: 'recording' }).total, 1)
  assert.equal(db.catalogSources({ entityId: first.id }).items[0].inLibrary, false)
})

test('same names stay independent; manual versions join sources reversibly without joining version families', (t) => {
  const db = memory(t),
    local = track('local'),
    online = track('ncm:7', {
      source: 'ncm',
      ncmSongId: 7,
      filePath: '',
      albumId: 'remote-album',
      streamUrl: 'https://secret.invalid/?token=private',
      lyrics: 'private',
      artists: [{ id: 9, name: 'Same artist' }]
    })
  seed(db, [local, track('live', { title: 'Same title (Live)' })])
  drain(db)
  remote(db, [online, online])
  const original = db
    .catalogQuery({ kind: 'recording' })
    .items.map((i) => i.id)
    .sort()
  assert.equal(original.length, 3)
  const doc = emptyMusicVersions()
  doc.tracks.versions = [
    {
      id: 'studio',
      label: 'Studio',
      sources: [versionSourceKey(local), versionSourceKey(online)],
      preferredSource: versionSourceKey(online)
    },
    { id: 'live', label: 'Live', sources: [versionSourceKey(track('live'))], preferredSource: null }
  ]
  doc.tracks.families = [{ id: 'family', versions: ['studio', 'live'], preferredVersion: 'studio' }]
  const localAlbumKey = JSON.stringify(['album', 'local', getAlbumIdentity(local)])
  doc.albums.versions = [
    {
      id: 'album',
      label: 'Album version',
      sources: [localAlbumKey, JSON.stringify(['album', 'ncm', getAlbumIdentity(online)])],
      preferredSource: localAlbumKey
    }
  ]
  db.catalogProjectVersions(doc, 5)
  const grouped = db.catalogQuery({ kind: 'recording' })
  assert.equal(grouped.total, 2)
  const studio = grouped.items.find((i) => i.title === 'Studio')!
  const sources = db.catalogSources({ entityId: studio.id })
  assert.equal(sources.total, 2)
  assert.equal(sources.items.filter((s) => s.preferred).length, 1)
  assert.equal(sources.items.find((s) => s.preferred)?.provider, 'ncm')
  const album = db.catalogQuery({ kind: 'release' }).items[0]
  const albumSources = db.catalogSources({ entityId: album.id }).items
  assert.equal(albumSources.length, 3)
  assert.equal(
    albumSources.filter((s) => s.preferred).every((s) => s.provider === 'local'),
    true
  )
  assert.equal(
    db.sql
      .prepare("SELECT preferred_version FROM catalog_versions WHERE scope='tracks' AND id='live'")
      .get()!.preferred_version,
    'studio'
  )
  assert.equal(
    db.catalogDetail(studio.id).facts.some((f) => f.origin === 'provider'),
    true
  )
  assert.equal(db.catalogQuery({ kind: 'recording', source: 'ncm' }).items[0].sourceCount, 1)
  const serialized = JSON.stringify(sources)
  assert.equal(serialized.includes('filePath'), false)
  assert.equal(serialized.includes('streamUrl'), false)
  assert.equal(serialized.includes('secret.invalid'), false)
  const ref = db.catalogResolve(
    sources.items.find((s) => s.provider === 'ncm')!.id,
    sources.revision
  )!
  assert.equal(ref.ncmSongId, 7)
  assert.equal(ref.streamUrl, undefined)
  assert.equal(ref.lyrics, null)
  db.catalogProjectVersions(emptyMusicVersions(), 6)
  assert.deepEqual(
    db
      .catalogQuery({ kind: 'recording' })
      .items.map((i) => i.id)
      .sort(),
    original
  )
  assert.throws(
    () => db.catalogSources({ entityId: studio.id, revision: sources.revision }),
    /已变化/
  )
})

test('playlist publication is atomic, deduplicated and fenced; aborted staging does not add members', (t) => {
  const db = memory(t),
    a = track('ncm:1', { source: 'ncm', filePath: '' }),
    b = track('ncm:2', { source: 'ncm', filePath: '' })
  remote(db, [a])
  let job = db.catalogSync({ kind: 'begin', revision: 2 })
  const staleJob = job
  job = db.catalogSync({ kind: 'append', ...job, tracks: [b, b] })
  assert.equal(db.catalogQuery({ kind: 'recording' }).total, 1)
  assert.equal(db.catalogQuery({ kind: 'recording', scope: 'all' }).total, 2)
  assert.throws(() => db.catalogSync({ kind: 'commit', ...staleJob }), /已变化/)
  db.catalogSync({ kind: 'abort', id: job.id })
  assert.equal(db.catalogStatus().playlistsRevision, 1)
  remote(db, [b], 3)
  assert.equal(db.catalogQuery({ kind: 'recording' }).total, 1)
  assert.equal(db.catalogStatus().playlistsRevision, 3)
  remote(db, [], 4)
  assert.equal(db.catalogQuery({ kind: 'recording' }).total, 0)
})

test('CUE ranges remain independent and resolve to the original selectors', (t) => {
  const db = memory(t)
  const first = track('cue:1', {
    filePath: 'D:/music/disc.flac',
    cueRange: { startSeconds: 0, endSeconds: 10, pregapSeconds: 0 }
  })
  const second = track('cue:2', {
    filePath: first.filePath,
    cueRange: { startSeconds: 10, endSeconds: 20, pregapSeconds: 0 }
  })
  seed(db, [first, second])
  drain(db)
  assert.equal(db.catalogQuery({ kind: 'recording' }).total, 2)
  const sources = db
    .catalogQuery({ kind: 'recording' })
    .items.flatMap((i) => db.catalogSources({ entityId: i.id }).items)
  assert.equal(new Set(sources.map((s) => s.id)).size, 2)
  for (const source of sources) {
    const resolved = db.catalogResolve(source.id, db.catalogStatus().revision)!
    assert.deepEqual(resolved.cueRange, resolved.id === first.id ? first.cueRange : second.cueRange)
  }
})

test('legacy colon-delimited Track IDs without source remain local and missing display tags use existing fallbacks', (t) => {
  const db = memory(t)
  db.replaceDocument({
    version: 2,
    revision: 0,
    tracks: [{ id: 'track:10:2', filePath: 'D:/music/legacy.flac' }],
    folders: [],
    exclusions: []
  })
  drain(db)
  const entity = db.catalogQuery({ kind: 'recording' }).items[0]
  assert.equal(entity.title, 'legacy.flac')
  const source = db.catalogSources({ entityId: entity.id }).items[0]
  assert.equal(source.provider, 'local')
  assert.equal(db.catalogResolve(source.id, db.catalogStatus().revision)?.source, 'local')
  assert.deepEqual(
    db.catalogDetail(entity.id).facts,
    [],
    'display fallbacks must not masquerade as file tags'
  )
  assert.equal(
    db.catalogQuery({ kind: 'release' }).total,
    0,
    'missing album tags do not invent a release'
  )
  assert.equal(
    db.catalogQuery({ kind: 'artist' }).total,
    0,
    'missing artist tags do not invent a person'
  )
})

test('public source views omit path-shaped legacy IDs and SACD selectors while private playback retains them', (t) => {
  const db = memory(t)
  const filePath = 'D:/private/disc.iso',
    subTrack = filePath + '?area=stereo&track=2'
  seed(db, [track(filePath, { filePath, subTrack, title: 'SACD track' })])
  drain(db)
  const entity = db.catalogQuery({ kind: 'recording' }).items[0]
  const sources = db.catalogSources({ entityId: entity.id })
  assert.equal(JSON.stringify(sources).includes('D:/private'), false)
  assert.equal(db.catalogResolve(sources.items[0].id, sources.revision)?.subTrack, subTrack)
})

test('v11 upgrade is backed up and backfill resumes across reopen without altering queues', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-upgrade-')),
    path = join(root, 'library.sqlite')
  let db = new LibraryDatabase(path)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  seed(db, [track('one'), track('two'), track('three')])
  const queue = db.createLibraryQueue({ ids: ['one', 'two', 'one'], sort: 'playlist' }, 'two')
  const queued = db.readLibraryQueue(queue.id)
  const metadata = db.getMetadata()
  // Actual v11 queue schema retained; remove only the new derived catalog.
  db.sql.exec(LEGACY_CATALOG_SCHEMA_SQL + 'PRAGMA user_version=11;')
  db.close()
  db = new LibraryDatabase(path)
  assert.equal(
    readdirSync(root).some((name) => name.includes('.v11-backup-')),
    true
  )
  assert.equal(db.catalogStatus().localHorizon, 3)
  db.catalogAdvance(1)
  assert.deepEqual(db.readLibraryQueue(queue.id), queued)
  assert.deepEqual(db.getMetadata(), metadata)
  const one = db.catalogQuery({ kind: 'recording' }).items[0].id
  db.close()
  db = new LibraryDatabase(path)
  assert.equal(db.catalogStatus().localCursor, 1)
  drain(db, 1)
  assert.equal(db.catalogQuery({ kind: 'recording' }).total, 3)
  assert.equal(
    db.catalogQuery({ kind: 'recording' }).items.some((i) => i.id === one),
    true
  )
  const backup = new DatabaseSync(
    join(root, readdirSync(root).find((name) => name.includes('.v11-backup-'))!)
  )
  assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 11)
  backup.close()
})

test('v11 catalog DDL failure rolls back partially created tables; backup failure prevents the upgrade', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-failure-')),
    path = join(root, 'library.sqlite')
  const old = new LibraryDatabase(path)
  t.after(() => {
    old.close()
    rmSync(root, { recursive: true, force: true })
  })
  seed(old, [track('retained')])
  old.sql.exec(LEGACY_CATALOG_SCHEMA_SQL + 'PRAGMA user_version=11;')
  const exec = DatabaseSync.prototype.exec
  const partial = t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      if (sql.includes('CREATE TABLE catalog_state')) {
        exec.call(this, sql.slice(0, sql.indexOf('CREATE TABLE catalog_sources')))
        throw new Error('Injected catalog DDL failure')
      }
      return exec.call(this, sql)
    }
  )
  assert.throws(() => new LibraryDatabase(path), /Injected catalog DDL/)
  partial.mock.restore()
  assert.equal(old.sql.prepare('PRAGMA user_version').get()!.user_version, 11)
  assert.equal(
    old.sql.prepare("SELECT name FROM sqlite_master WHERE name='catalog_state'").get(),
    undefined
  )
  assert.equal(old.getMetadata().trackCount, 1)
  const prepare = DatabaseSync.prototype.prepare
  const failure = t.mock.method(
    DatabaseSync.prototype,
    'prepare',
    function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('VACUUM INTO')) throw new Error('Injected backup failure')
      return prepare.call(this, sql)
    }
  )
  assert.throws(() => new LibraryDatabase(path), /Injected backup failure/)
  failure.mock.restore()
  assert.equal(old.sql.prepare('PRAGMA user_version').get()!.user_version, 11)
  const upgraded = new LibraryDatabase(path)
  assert.equal(upgraded.catalogStatus().localPending, true)
  drain(upgraded)
  assert.equal(upgraded.catalogQuery({ kind: 'recording' }).total, 1)
  upgraded.close()
})

test('catalog pages are bounded and revision fenced; albums without provider IDs do not merge on a title', (t) => {
  const db = memory(t)
  let job = db.catalogSync({ kind: 'begin', revision: 1 })
  for (let page = 0; page < 3; page++)
    job = db.catalogSync({
      kind: 'append',
      ...job,
      tracks: Array.from({ length: 200 }, (_, i) =>
        track(`ncm:${page * 200 + i}`, { source: 'ncm', filePath: '' })
      )
    })
  db.catalogSync({ kind: 'commit', ...job })
  const first = db.catalogQuery({ kind: 'recording', limit: 200 })
  const next = db.catalogQuery({ kind: 'recording', revision: first.revision, offset: 200 })
  assert.equal(first.total, 600)
  assert.equal(next.items.length, 200)
  assert.equal(new Set([...first.items, ...next.items].map((i) => i.id)).size, 400)
  assert.equal(db.catalogQuery({ kind: 'release' }).total, 600)
  assert.throws(() => db.catalogQuery({ kind: 'recording', limit: 201 }), /Invalid/)
  remote(db, [], 2)
  assert.throws(() => db.catalogQuery({ kind: 'recording', revision: first.revision }), /已变化/)
})

function sourceId(db: LibraryDatabase, value: TrackData): string {
  return String(db.sql.prepare('SELECT id FROM catalog_sources WHERE source_key=?')
    .get(versionSourceKey(value))!.id)
}
function membershipTime(db: LibraryDatabase, id: string): string | null {
  return db.sql.prepare('SELECT value FROM catalog_state WHERE key=?')
    .get(CATALOG_MEMBERSHIP_ADDED_PREFIX + id)?.value as string | undefined ?? null
}

test('catalog membership time records actual local publication once, independent of Track.addedAt, rescan and re-add', (t) => {
  let now = 1700000000000
  t.mock.method(Date, 'now', () => now)
  const db = memory(t), original = track('local-member', { addedAt: 42 })
  seed(db, [original])
  assert.equal(db.sql.prepare('SELECT count(*) n FROM catalog_state WHERE key LIKE ?')
    .get(CATALOG_MEMBERSHIP_ADDED_PREFIX + '%')!.n, 0)
  drain(db)
  const id = sourceId(db, original)
  assert.equal(membershipTime(db, id), String(now))
  now += 1000
  seed(db, [track(original.id, { addedAt: 9999999999999, title: 'Retagged' })])
  drain(db)
  assert.equal(membershipTime(db, id), '1700000000000')
  now += 1000
  seed(db, []); drain(db)
  assert.equal(membershipTime(db, id), '1700000000000')
  seed(db, [original]); drain(db)
  assert.equal(sourceId(db, original), id)
  assert.equal(membershipTime(db, id), '1700000000000')
  now += 1000
  const changed = track(original.id, { filePath: 'D:/music/different.flac' })
  seed(db, [changed]); drain(db)
  assert.equal(membershipTime(db, sourceId(db, changed)), String(now))
  assert.equal(membershipTime(db, id), '1700000000000')
})

test('platform append and abort never invent membership time; successful publication and re-add preserve first time', (t) => {
  let now = 1700000000000
  t.mock.method(Date, 'now', () => now)
  const db = memory(t), a = track('ncm:1001', { source: 'ncm', filePath: '', addedAt: 1 }),
    b = track('ncm:1002', { source: 'ncm', filePath: '', addedAt: 9999999999999 })
  remote(db, [a])
  const aId = sourceId(db, a)
  assert.equal(membershipTime(db, aId), String(now))
  now += 1000
  let job = db.catalogSync({ kind: 'begin', revision: 2 })
  job = db.catalogSync({ kind: 'append', ...job, tracks: [b] })
  const bId = sourceId(db, b)
  assert.equal(membershipTime(db, bId), null)
  db.catalogSync({ kind: 'abort', id: job.id })
  assert.equal(membershipTime(db, bId), null)
  assert.equal(membershipTime(db, aId), '1700000000000')
  now += 1000
  remote(db, [b], 3)
  assert.equal(membershipTime(db, bId), String(now))
  assert.equal(membershipTime(db, aId), '1700000000000')
  now += 1000
  remote(db, [a, b], 4)
  assert.equal(membershipTime(db, aId), '1700000000000')
  assert.equal(membershipTime(db, bId), '1700000002000')
  remote(db, [a, b], 5)
  assert.equal(membershipTime(db, bId), '1700000002000')
})

test('existing local membership without historical time remains unknown after reprojection, removal and selector changes', (t) => {
  let now = 1700000000000
  t.mock.method(Date, 'now', () => now)
  const db = memory(t), a = track('legacy-a'), b = track('legacy-b'), c = track('legacy-c')
  seed(db, [a, b, c]); drain(db)
  const ids = [a, b, c].map(value => sourceId(db, value))
  for (const id of ids) db.sql.prepare('DELETE FROM catalog_state WHERE key=?')
    .run(CATALOG_MEMBERSHIP_ADDED_PREFIX + id)
  now += 1000
  // Retag one existing member, remove a second and change the third source key.
  const changed = track(c.id, { filePath: 'D:/music/new-selector.flac' })
  seed(db, [track(a.id, { title: 'Retagged' }), changed]); drain(db)
  assert.deepEqual(ids.map(id => membershipTime(db, id)), ['unknown', 'unknown', 'unknown'])
  assert.equal(membershipTime(db, sourceId(db, changed)), String(now))
  now += 1000
  seed(db, [a, b, c]); drain(db)
  assert.deepEqual(ids.map(id => membershipTime(db, id)), ['unknown', 'unknown', 'unknown'])
})

test('legacy platform members stay unknown rather than receiving upgrade or reprojection time', (t) => {
  let now = 1700000000000
  t.mock.method(Date, 'now', () => now)
  const db = memory(t), a = track('ncm:legacy', { source: 'ncm', filePath: '' }),
    b = track('ncm:new', { source: 'ncm', filePath: '' })
  remote(db, [a])
  const aId = sourceId(db, a)
  db.sql.prepare('DELETE FROM catalog_state WHERE key=?').run(CATALOG_MEMBERSHIP_ADDED_PREFIX + aId)
  now += 1000
  let job = db.catalogSync({ kind: 'begin', revision: 2 })
  job = db.catalogSync({ kind: 'append', ...job, tracks: [a, b] })
  const bId = sourceId(db, b)
  assert.equal(membershipTime(db, aId), null)
  assert.equal(membershipTime(db, bId), null)
  db.catalogSync({ kind: 'abort', id: job.id })
  remote(db, [a, b], 3)
  assert.equal(membershipTime(db, aId), 'unknown')
  assert.equal(membershipTime(db, bId), String(now))
  now += 1000
  remote(db, [], 4)
  remote(db, [a, b], 5)
  assert.equal(membershipTime(db, aId), 'unknown')
  assert.equal(membershipTime(db, bId), '1700000001000')
})

test('membership time and actual membership publication roll back together on commit failure', (t) => {
  let now = 1700000000000
  t.mock.method(Date, 'now', () => now)
  const db = memory(t), a = track('ncm:existing', { source: 'ncm', filePath: '' }),
    b = track('ncm:staged', { source: 'ncm', filePath: '' })
  remote(db, [a])
  const aId = sourceId(db, a)
  let job = db.catalogSync({ kind: 'begin', revision: 2 })
  job = db.catalogSync({ kind: 'append', ...job, tracks: [b] })
  const bId = sourceId(db, b)
  db.sql.exec(`CREATE TEMP TRIGGER fail_membership BEFORE INSERT ON catalog_memberships
    WHEN new.owner='playlists' BEGIN SELECT RAISE(ABORT,'Injected membership publication failure'); END;`)
  now += 1000
  assert.throws(() => db.catalogSync({ kind: 'commit', ...job }), /Injected membership publication/)
  assert.equal(membershipTime(db, bId), null)
  assert.equal(membershipTime(db, aId), '1700000000000')
  assert.equal(db.sql.prepare('SELECT source_id FROM catalog_memberships').get()!.source_id, aId)
  db.sql.exec('DROP TRIGGER fail_membership')
  now += 1000
  db.catalogSync({ kind: 'commit', ...job })
  assert.equal(membershipTime(db, bId), String(now))
})

test('membership history survives database reopen and opening an older catalog does not fabricate missing times', (t) => {
  let now = 1700000000000
  t.mock.method(Date, 'now', () => now)
  const root = mkdtempSync(join(tmpdir(), 'catalog-membership-history-')),
    path = join(root, 'library.sqlite')
  let db = new LibraryDatabase(path)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  const a = track('persisted'), b = track('legacy-unknown')
  seed(db, [a, b]); drain(db)
  const aId = sourceId(db, a), bId = sourceId(db, b)
  db.sql.prepare('DELETE FROM catalog_state WHERE key=?').run(CATALOG_MEMBERSHIP_ADDED_PREFIX + bId)
  const version = db.sql.prepare('PRAGMA user_version').get()!.user_version
  db.close()
  now += 1000
  db = new LibraryDatabase(path)
  assert.equal(db.sql.prepare('PRAGMA user_version').get()!.user_version, version)
  assert.equal(membershipTime(db, aId), '1700000000000')
  assert.equal(membershipTime(db, bId), null)
  seed(db, []); drain(db)
  db.close()
  now += 1000
  db = new LibraryDatabase(path)
  seed(db, [a, b]); drain(db)
  assert.equal(membershipTime(db, aId), '1700000000000')
  assert.equal(membershipTime(db, bId), 'unknown')
})
