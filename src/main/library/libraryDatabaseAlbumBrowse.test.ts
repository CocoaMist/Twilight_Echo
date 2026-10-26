import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { CATALOG_PROJECT_SCHEMA_SQL, CATALOG_SCHEMA_SQL } from './libraryDatabaseCatalog.ts'
import { LibraryDatabaseAlbumBrowse } from './libraryDatabaseAlbumBrowse.ts'
import { validAlbumBrowsePayload, validAlbumBrowseScope } from '../../shared/musicAlbumBrowse.ts'

function fixture(t: test.TestContext) {
  const sql = new DatabaseSync(':memory:')
  t.after(() => sql.close())
  sql.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE tracks(seq INTEGER PRIMARY KEY,id TEXT UNIQUE,payload TEXT,album_key TEXT);`)
  sql.exec(CATALOG_SCHEMA_SQL)
  sql.exec(CATALOG_PROJECT_SCHEMA_SQL)
  sql.exec(`CREATE TABLE music_genre_state(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO music_genre_state VALUES('revision','1');
    CREATE TABLE metadata_identity_links(entity_id TEXT,kind TEXT,state TEXT,target_id TEXT,
      UNIQUE(entity_id,kind));
    CREATE TABLE metadata_facts(target_id TEXT,field TEXT,payload TEXT);`)
  let contentRevision = 1,
    metadataRevision = 1,
    now = 1700000000000
  let clock = () => now
  const browse = new LibraryDatabaseAlbumBrowse({
    sql,
    contentRevision: () => contentRevision,
    metadataRevision: () => metadataRevision,
    now: () => clock()
  })
  const album = (id: string, title = 'Same album') => {
    sql
      .prepare("INSERT INTO catalog_entities VALUES(?,'release',?,'Artist','source')")
      .run(id, title)
    sql
      .prepare("INSERT INTO catalog_entities VALUES(?,'album_project',?,'Artist','source')")
      .run(`project:${id}`, title)
    sql.prepare('INSERT INTO catalog_release_projects VALUES(?,?)').run(id, `project:${id}`)
  }
  const source = (
    id: string,
    release: string,
    options: {
      provider?: string
      member?: boolean
      availability?: string
      disc?: number
      track?: number
    } = {}
  ) => {
    const provider = options.provider ?? 'local'
    const track = JSON.stringify({
      id: `D:/private/${id}.flac`,
      filePath: `D:/private/${id}.flac`,
      title: id,
      artist: 'Artist',
      album: 'Same album',
      discNumber: options.disc,
      trackNumber: options.track
    })
    sql
      .prepare("INSERT INTO catalog_entities VALUES(?,'recording',?,'Artist','source')")
      .run(`recording:${id}`, id)
    if (provider === 'local') {
      sql.prepare('INSERT INTO tracks(id,payload,album_key) VALUES(?,?,?)').run(id, track, release)
      sql.prepare('DELETE FROM catalog_pending WHERE track_id=?').run(id)
    }
    sql
      .prepare('INSERT INTO catalog_sources VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        id,
        `source-key:${id}`,
        provider,
        id,
        `recording:${id}`,
        release,
        `album-key:${release}`,
        track,
        options.availability ?? (provider === 'local' ? 'indexed' : 'unknown')
      )
    if (options.member !== false)
      sql.prepare('INSERT INTO catalog_memberships VALUES(?,?)').run(provider, id)
  }
  const identify = (
    id: string,
    kind: 'release' | 'album_project',
    target: string,
    state = 'confirmed'
  ) => {
    sql
      .prepare('INSERT OR REPLACE INTO metadata_identity_links VALUES(?,?,?,?)')
      .run(id, kind, state, target)
    metadataRevision++
  }
  const manual = (
    id: string,
    releases: string[],
    family: string | null = null,
    preferredVersion: string | null = null
  ) => {
    album(`manual:${id}`, `Version ${id}`)
    sql.prepare("UPDATE catalog_entities SET identity='manual' WHERE id=?").run(`manual:${id}`)
    sql
      .prepare("INSERT INTO catalog_versions VALUES('albums',?,?,?,?,?,?)")
      .run(
        id,
        `manual:${id}`,
        `Version ${id}`,
        `album-key:${releases[0]}`,
        family,
        preferredVersion
      )
    for (const release of releases)
      sql
        .prepare("INSERT INTO catalog_version_sources VALUES('albums',?,?)")
        .run(`album-key:${release}`, id)
  }
  const stale = (action: () => unknown) =>
    assert.throws(
      action,
      (error: unknown) =>
        !!error && typeof error === 'object' && 'code' in error && error.code === 'STALE_REVISION'
    )
  return {
    sql,
    browse,
    album,
    source,
    identify,
    manual,
    stale,
    metadata: () => metadataRevision++,
    content: () => contentRevision++,
    catalog: () =>
      sql.exec("UPDATE catalog_state SET value=CAST(value AS INTEGER)+1 WHERE key='revision'"),
    genres: () =>
      sql.exec("UPDATE music_genre_state SET value=CAST(value AS INTEGER)+1 WHERE key='revision'"),
    setNow: (value: number) => {
      now = value
    },
    setClock: (value: () => number) => {
      clock = value
    }
  }
}

test('unidentified same-name albums stay independent and reads never add cached catalog sources', (t) => {
  const { sql, browse, album, source } = fixture(t)
  album('one')
  album('two')
  album('cached')
  source('local-one', 'one')
  source('platform-two', 'two', { provider: 'ncm' })
  source('search-only', 'cached', { provider: 'ncm', member: false })
  const before = sql.prepare('SELECT total_changes() n').get()!.n
  const page = browse.browse({ entityId: 'one' })
  assert.equal(page.total, 1)
  assert.equal(page.currentRelease?.identity, 'unidentified')
  assert.equal(page.currentRelease?.id, 'catalog:one')
  assert.equal(page.project?.entityId, 'project:one')
  assert.equal(page.externalCatalog, 'unavailable')
  assert.equal(browse.browse({ entityId: 'two' }).total, 1)
  assert.equal(browse.browse({ entityId: 'cached' }).total, 0)
  assert.equal(browse.browse({ entityId: 'Same album' }).currentRelease, null)
  assert.equal(sql.prepare('SELECT total_changes() n').get()!.n, before)
})

test('only confirmed project identity links related releases; exact metadata release is distinct from a playback version', (t) => {
  const { browse, album, source, identify, manual } = fixture(t)
  for (const release of ['original', 'stream', 'remaster', 'unrelated']) album(release)
  source('original-track', 'original')
  source('stream-track', 'stream', { provider: 'ncm' })
  source('remaster-track', 'remaster')
  source('unrelated-track', 'unrelated')
  for (const release of ['original', 'stream', 'remaster'])
    identify(`project:${release}`, 'album_project', 'confirmed-project')
  identify('original', 'release', 'original-pressing')
  identify('stream', 'release', 'original-pressing')
  identify('remaster', 'release', 'remaster-pressing')
  // The source-scoped project relation is intentionally independent of family membership.
  manual('unrelated', ['unrelated'], 'same-family', 'unrelated')
  const page = browse.browse({ entityId: 'stream', limit: 1 })
  assert.equal(page.project?.metadataTargetId, 'confirmed-project')
  assert.equal(page.total, 2)
  assert.equal(page.currentRelease?.entityId, 'stream')
  assert.equal(page.currentRelease?.id, 'metadata:original-pressing')
  assert.equal(page.currentRelease?.sourceCount, 2)
  assert.equal(page.currentRelease?.playbackVersionCount, 2)
  assert.equal(page.items[0].current, true)
  const second = browse.browse({ entityId: 'stream', token: page.token, offset: 1, limit: 1 })
  assert.equal(second.items[0].id, 'metadata:remaster-pressing')
  const sources = browse.sources({
    entityId: 'stream',
    releaseId: page.items[0].id,
    token: page.token
  })
  assert.deepEqual(
    sources.items.map((s) => s.sourceId),
    ['original-track', 'stream-track']
  )
  assert.equal(sources.items[0].playbackVersion, null)
  assert.equal(
    browse.browse({ entityId: 'project:stream' }).currentRelease?.id,
    page.currentRelease?.id
  )
})

test('manual album equivalence and family are projected separately without cross-family release guessing or path exposure', (t) => {
  const { browse, album, source, manual, identify } = fixture(t)
  for (const release of ['local', 'platform', 'live']) album(release)
  source('local-1', 'local', { track: 1 })
  source('platform-1', 'platform', { provider: 'ncm', track: 1 })
  source('live-1', 'live')
  manual('studio', ['local', 'platform'], 'family', 'live')
  manual('live', ['live'], 'family', 'live')
  for (const release of ['local', 'platform']) {
    identify(release, 'release', 'studio-release')
    identify(`project:${release}`, 'album_project', 'studio-project')
  }
  identify('manual:studio', 'release', 'studio-release')
  identify('project:manual:studio', 'album_project', 'studio-project')
  const page = browse.browse({ entityId: 'manual:studio' })
  assert.equal(page.total, 1)
  assert.equal(page.currentRelease?.identity, 'confirmed')
  assert.equal(page.currentRelease?.playbackVersionCount, 1)
  const sources = browse.sources({
    entityId: 'manual:studio',
    releaseId: page.currentRelease!.id,
    token: page.token
  })
  assert.equal(sources.total, 2)
  assert.equal(sources.items[0].sourceId, 'local-1')
  assert.equal(sources.items[0].preferred, true)
  assert.deepEqual(sources.items[0].playbackVersion, {
    id: 'studio',
    entityId: 'manual:studio',
    label: 'Version studio',
    familyId: 'family',
    preferredVersionId: 'live',
    metadataTargetId: 'studio-release',
    projectMetadataTargetId: 'studio-project'
  })
  assert.equal(sources.items[0].recordingId, 'recording:local-1')
  assert.equal(JSON.stringify({ page, sources }).includes('D:/private'), false)
  // An older catalog release reference resolves through its actual current binding.
  assert.equal(browse.browse({ entityId: 'local' }).currentRelease?.entityId, 'local')
})

test('manual playback equivalence never folds confirmed physical editions or overwrites their metadata identity', (t) => {
  const { browse, album, source, manual, identify } = fixture(t)
  for (const release of ['original', 'remaster']) album(release)
  source('original-track', 'original')
  source('remaster-track', 'remaster', { provider: 'ncm' })
  identify('original', 'release', 'original-pressing')
  identify('remaster', 'release', 'remaster-pressing')
  for (const release of ['original', 'remaster'])
    identify(`project:${release}`, 'album_project', 'same-project')
  manual('equivalent', ['original', 'remaster'])
  identify('manual:equivalent', 'release', 'manual-different-release')
  identify('project:manual:equivalent', 'album_project', 'manual-different-project')
  const page = browse.browse({ entityId: 'manual:equivalent' })
  assert.equal(page.projectCount, 1)
  assert.equal(page.project?.metadataTargetId, 'same-project')
  assert.equal(page.total, 2)
  assert.deepEqual(
    page.items.map((r) => r.metadataTargetId),
    ['original-pressing', 'remaster-pressing']
  )
  for (const release of page.items) {
    assert.equal(release.sourceCount, 1)
    const sources = browse.sources({
      entityId: 'manual:equivalent',
      releaseId: release.id,
      token: page.token
    })
    assert.equal(sources.items.length, 1)
    assert.equal(sources.items[0].playbackVersion?.id, 'equivalent')
    assert.equal(sources.items[0].playbackVersion?.metadataTargetId, 'manual-different-release')
    assert.equal(
      sources.items[0].playbackVersion?.projectMetadataTargetId,
      'manual-different-project'
    )
    assert.equal(sources.items[0].identityConflict, true)
    assert.equal(
      browse.containsSource(
        {
          entityId: 'manual:equivalent',
          releaseId: release.id,
          token: page.token
        },
        release.entityId === 'original' ? 'remaster-track' : 'original-track'
      ),
      false
    )
  }
})

test('unidentified physical albums remain separate inside one manual version and multiple projects have no invented common heading', (t) => {
  const { browse, album, source, manual, identify } = fixture(t)
  album('one')
  album('two')
  source('one-track', 'one')
  source('two-track', 'two')
  manual('both', ['one', 'two'])
  identify('manual:both', 'release', 'manual-only-confirmation')
  identify('project:manual:both', 'album_project', 'manual-only-project')
  const page = browse.browse({ entityId: 'manual:both' })
  assert.equal(page.projectCount, 2)
  assert.equal(page.project, null)
  assert.equal(page.total, 2)
  assert.deepEqual(
    page.items.map((r) => r.id),
    ['catalog:one', 'catalog:two']
  )
  assert.equal(
    page.items.every((r) => r.identity === 'unidentified'),
    true
  )
  assert.equal(
    page.items.every((r) => r.metadataTargetId === null),
    true
  )
  const projected = browse.browse({ entityId: 'project:manual:both' })
  assert.equal(projected.total, 2)
  assert.equal(projected.project, null)
})

test('current physical release wins when explicit; a manual-only entry defaults to its preferred album source', (t) => {
  const { browse, album, source, manual } = fixture(t)
  album('a-source')
  album('z-preferred')
  source('a-track', 'a-source')
  source('z-track', 'z-preferred')
  manual('both', ['z-preferred', 'a-source'])
  assert.equal(browse.browse({ entityId: 'manual:both' }).currentRelease?.entityId, 'z-preferred')
  assert.equal(browse.browse({ entityId: 'a-source' }).currentRelease?.entityId, 'a-source')
})

test('member counts are distinct and source pagination follows deterministic album preference and track positions', (t) => {
  const { sql, browse, album, source } = fixture(t)
  album('one')
  source('z-2', 'one', { disc: 1, track: 2 })
  source('a-1', 'one', { disc: 1, track: 1 })
  source('remote', 'one', { provider: 'ncm', availability: 'missing', disc: 2, track: 1 })
  source('cached', 'one', { provider: 'ncm', member: false })
  source('dirty', 'one')
  sql.prepare('INSERT INTO catalog_pending VALUES(?)').run('dirty')
  source('absent', 'one')
  sql.prepare('DELETE FROM tracks WHERE id=?').run('absent')
  sql.prepare('INSERT INTO catalog_memberships VALUES(?,?)').run('playlist:second', 'a-1')
  const page = browse.browse({ entityId: 'one' })
  assert.equal(page.currentRelease?.sourceCount, 3)
  const scope = { entityId: 'one', releaseId: page.currentRelease!.id, token: page.token }
  const first = browse.sources({ ...scope, limit: 1 })
  assert.equal(first.total, 3)
  assert.equal(first.items[0].sourceId, 'a-1')
  assert.deepEqual(first.providers, ['local', 'ncm'])
  assert.equal(first.providerCount, 2)
  assert.equal(browse.sources({ ...scope, offset: 1, limit: 1 }).items[0].sourceId, 'z-2')
  assert.equal(browse.sources({ ...scope, offset: 2, limit: 1 }).items[0].availability, 'missing')
  assert.equal(browse.containsSource(scope, 'a-1'), true)
  for (const id of ['cached', 'dirty', 'absent', 'not-real'])
    assert.equal(browse.containsSource(scope, id), false)
  assert.equal(browse.containsSource({ ...scope, releaseId: 'catalog:other' }, 'a-1'), false)
  assert.equal(browse.sources({ ...scope, releaseId: 'catalog:other' }).release, null)
  assert.deepEqual(browse.sources({ ...scope, releaseId: 'catalog:other' }).providers, [])
})

test('provider ordering inputs cover the whole release rather than the source page and remain bounded', (t) => {
  const { browse, album, source } = fixture(t)
  album('one')
  for (let i = 0; i < 130; i++)
    source(`source-${i}`, 'one', {
      provider: `platform-${String(i).padStart(3, '0')}`
    })
  const page = browse.browse({ entityId: 'one' })
  const sources = browse.sources({
    entityId: 'one',
    releaseId: page.currentRelease!.id,
    token: page.token,
    limit: 1
  })
  assert.equal(sources.total, 130)
  assert.equal(sources.items.length, 1)
  assert.equal(sources.providers.length, 128)
  assert.equal(sources.providerCount, 130)
  assert.equal(sources.providers[0], 'platform-000')
  assert.equal(sources.providers.at(-1), 'platform-127')
})

test('empty and past-end pages retain the exact heading, current release and full counts', (t) => {
  const { browse, album, source, identify } = fixture(t)
  album('one')
  album('two')
  album('empty')
  source('local-track', 'one')
  source('remote-track', 'one', { provider: 'ncm' })
  source('other-track', 'two')
  for (const id of ['one', 'two']) identify(`project:${id}`, 'album_project', 'same-project')
  const first = browse.browse({ entityId: 'one', limit: 1 })
  const pastEnd = browse.browse({ entityId: 'one', offset: 50, limit: 1, token: first.token })
  assert.deepEqual(pastEnd.items, [])
  assert.equal(pastEnd.offset, 50)
  assert.equal(pastEnd.total, 2)
  assert.equal(pastEnd.projectCount, 1)
  assert.deepEqual(pastEnd.project, first.project)
  assert.deepEqual(pastEnd.currentRelease, first.currentRelease)
  const sources = browse.sources({
    entityId: 'one',
    releaseId: first.currentRelease!.id,
    token: first.token,
    offset: 50,
    limit: 1
  })
  assert.deepEqual(sources.items, [])
  assert.equal(sources.offset, 50)
  assert.equal(sources.total, 2)
  assert.deepEqual(sources.release, first.currentRelease)
  assert.deepEqual(sources.providers, ['local', 'ncm'])
  assert.equal(sources.providerCount, 2)
  for (const entityId of ['empty', 'missing']) {
    const page = browse.browse({ entityId })
    assert.equal(page.project, null)
    assert.equal(page.projectCount, 0)
    assert.equal(page.currentRelease, null)
    assert.equal(page.total, 0)
    assert.deepEqual(page.items, [])
    const empty = browse.sources({ entityId, releaseId: 'catalog:one', token: page.token })
    assert.equal(empty.release, null)
    assert.equal(empty.total, 0)
    assert.equal(empty.providerCount, 0)
    assert.deepEqual(empty.providers, [])
    assert.deepEqual(empty.items, [])
  }
})

test('one graph query supplies each album page and source page including exact counts', (t) => {
  const { sql, browse, album, source } = fixture(t)
  album('one')
  source('local-track', 'one')
  source('remote-track', 'one', { provider: 'ncm' })
  const graphQueries: string[] = []
  const prepare = sql.prepare.bind(sql)
  t.mock.method(sql, 'prepare', (statement: string) => {
    if (/^WITH\s+album_args\b/.test(statement)) graphQueries.push(statement)
    return prepare(statement)
  })
  const page = browse.browse({ entityId: 'one' })
  assert.equal(graphQueries.length, 1)
  assert.equal(page.total, 1)
  assert.equal(page.currentRelease?.sourceCount, 2)
  graphQueries.length = 0
  const sources = browse.sources({
    entityId: 'one',
    releaseId: page.currentRelease!.id,
    token: page.token,
    limit: 1
  })
  assert.equal(graphQueries.length, 1)
  assert.equal(sources.items.length, 1)
  assert.equal(sources.total, 2)
  assert.equal(sources.providerCount, 2)
})

test('display fields have the same finite text bound as existing public track projections', (t) => {
  const { sql, browse, album, source } = fixture(t)
  album('one')
  source('track', 'one')
  const long = 'x'.repeat(40000)
  sql
    .prepare('UPDATE catalog_entities SET title=?,artist=? WHERE id IN (?,?)')
    .run(long, long, 'one', 'project:one')
  sql
    .prepare('UPDATE catalog_sources SET payload=? WHERE id=?')
    .run(
      JSON.stringify({ title: long, artist: long, album: long, filePath: 'D:/private/track.flac' }),
      'track'
    )
  const page = browse.browse({ entityId: 'one' })
  const sources = browse.sources({
    entityId: 'one',
    releaseId: page.currentRelease!.id,
    token: page.token
  })
  assert.equal(page.currentRelease!.title.length, 32768)
  assert.equal(page.project!.artist.length, 32768)
  assert.equal(sources.items[0].album.length, 32768)
  assert.equal(JSON.stringify(sources).includes('D:/private'), false)
})

test('metadata confirmation or detach, catalog, content and genre changes invalidate the complete frozen read scope', (t) => {
  const f = fixture(t)
  f.album('one')
  f.source('track', 'one')
  for (const mutate of [f.metadata, f.content, f.catalog, f.genres]) {
    const page = f.browse.browse({ entityId: 'one' })
    const scope = { entityId: 'one', releaseId: page.currentRelease!.id, token: page.token }
    mutate()
    f.stale(() => f.browse.browse({ entityId: 'one', token: page.token }))
    f.stale(() => f.browse.sources(scope))
    f.stale(() => f.browse.containsSource(scope, 'track'))
  }
  const initial = f.browse.browse({ entityId: 'one' })
  f.identify('one', 'release', 'confirmed-release')
  f.stale(() =>
    f.browse.sources({
      entityId: 'one',
      releaseId: initial.currentRelease!.id,
      token: initial.token
    })
  )
  assert.equal(f.browse.browse({ entityId: 'one' }).currentRelease?.identity, 'confirmed')
  f.identify('one', 'release', 'confirmed-release', 'detached')
  assert.equal(f.browse.browse({ entityId: 'one' }).currentRelease?.identity, 'unidentified')
})

test('private provider context is opaque and context changes or expiry withdraw snapshots', (t) => {
  const { sql, browse, album, source, stale, setNow } = fixture(t)
  album('one')
  source('track', 'one')
  const expiresAt = 1700000000100
  sql.prepare('INSERT INTO metadata_facts VALUES(?,?,?)').run(
    'target',
    'releaseDate',
    JSON.stringify({
      value: '2000',
      sourceProvider: 'ncm',
      providerContext: 'private-account',
      usage: { display: true, cache: true, crossSource: true, expiresAt }
    })
  )
  const context = { platformContexts: { ncm: 'private-account' } }
  const page = browse.browse({ entityId: 'one' }, context)
  assert.equal(page.token.expiresAt, expiresAt)
  assert.equal(JSON.stringify(page).includes('private-account'), false)
  const scope = { entityId: 'one', releaseId: page.currentRelease!.id, token: page.token }
  stale(() => browse.sources(scope, { platformContexts: { ncm: 'other-account' } }))
  // Return to the original account still needs a fresh explicit read.
  stale(() => browse.sources(scope, context))
  const fresh = browse.browse({ entityId: 'one' }, context)
  setNow(expiresAt)
  stale(() => browse.sources({ ...scope, token: fresh.token }, context))
  assert.equal(browse.browse({ entityId: 'one' }, context).token.expiresAt, null)
})

test('expiry reached during read rejects the entire response and leaves no open transaction', (t) => {
  const { sql, browse, album, source, setClock, stale } = fixture(t)
  album('one')
  source('track', 'one')
  sql.prepare('INSERT INTO metadata_facts VALUES(?,?,?)').run(
    'target',
    'releaseDate',
    JSON.stringify({
      value: '2000',
      usage: { display: true, cache: true, expiresAt: 1700000000001 }
    })
  )
  let calls = 0
  setClock(() => (calls++ === 0 ? 1700000000000 : 1700000000001))
  stale(() => browse.browse({ entityId: 'one' }))
  assert.equal(sql.isTransaction, false)
})

test('public validation is bounded and source scope requires a valid snapshot without private inputs', (t) => {
  const { browse, album, source } = fixture(t)
  album('one')
  source('track', 'one')
  const page = browse.browse({ entityId: 'one' })
  const scope = { entityId: 'one', releaseId: page.currentRelease!.id, token: page.token }
  assert.equal(validAlbumBrowsePayload('albums.browse', { entityId: 'one', limit: 200 }), true)
  assert.equal(validAlbumBrowsePayload('albums.sources', { ...scope, limit: 200 }), true)
  assert.equal(validAlbumBrowseScope(scope), true)
  for (const invalid of [
    { entityId: 'one', limit: 201 },
    { entityId: 'one', offset: -1 },
    { entityId: 'one', platformContexts: { ncm: 'secret' } },
    { entityId: 'one', filePath: 'private' }
  ])
    assert.equal(validAlbumBrowsePayload('albums.browse', invalid), false)
  assert.equal(
    validAlbumBrowsePayload('albums.sources', { entityId: 'one', releaseId: scope.releaseId }),
    false
  )
  assert.equal(validAlbumBrowseScope({ ...scope, sourceId: 'track' }), false)
  assert.throws(() => browse.browse({ entityId: 'one', limit: 201 }), /参数无效/)
  assert.throws(
    () => browse.sources({ entityId: 'one', releaseId: scope.releaseId } as never),
    /参数无效/
  )
})
