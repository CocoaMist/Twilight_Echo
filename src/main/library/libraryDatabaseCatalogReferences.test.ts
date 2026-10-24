import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from './libraryDatabase.ts'
import { LibraryDatabaseCatalogReferences } from './libraryDatabaseCatalogReferences.ts'
import { validCatalogPayload } from '../../shared/musicCatalog.ts'
import { emptyMusicVersions } from '../../shared/musicVersions.ts'
import { versionSourceKey } from '../../shared/trackSourceIdentity.ts'
import { getAlbumIdentity } from '../../shared/libraryIdentity.ts'
import type { TrackData } from '../../shared/track.ts'

const track = (id: string, extra: Partial<TrackData> = {}): TrackData => ({
  id,
  source: 'local',
  title: id,
  artist: 'Same name',
  album: 'Album',
  duration: 200,
  filePath: `D:/music/${id}.flac`,
  fileName: `${id}.flac`,
  size: 0,
  cover: null,
  lyrics: null,
  ...extra
})
function memory(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  return db
}
function seed(db: LibraryDatabase, tracks: TrackData[]) {
  db.replaceDocument({ version: 2, revision: 1, tracks, folders: ['D:/music'], exclusions: [] })
}
function drain(db: LibraryDatabase) {
  while (db.catalogStatus().localPending) db.catalogAdvance(200)
}
function remote(db: LibraryDatabase, tracks: TrackData[], revision = 1) {
  let job = db.catalogSync({ kind: 'begin', revision })
  job = db.catalogSync({ kind: 'append', ...job, tracks })
  db.catalogSync({ kind: 'commit', ...job })
}

test('page references align with repeated occurrences without entering TrackData or playback identities', (t) => {
  const db = memory(t)
  seed(db, [track('one'), track('two', { artist: '' })])
  assert.equal(db.getTracksByIds(['one']).catalog, undefined)
  drain(db)
  const page = db.getTracksByIds(['two', 'missing', 'one', 'two'])
  assert.deepEqual(
    page.tracks.map((t) => t.id),
    ['two', 'one', 'two']
  )
  assert.equal(page.catalog!.tracks.length, 3)
  assert.deepEqual(page.catalog!.tracks[0], page.catalog!.tracks[2])
  assert.notEqual(page.catalog!.tracks[0]!.sourceId, page.catalog!.tracks[1]!.sourceId)
  assert.equal(page.catalog!.tracks[1]!.items.find((i) => i.kind === 'artist')!.title, 'Same name')
  assert.equal(
    page.tracks.some((t) => 'catalog' in t),
    false
  )
  assert.equal(JSON.stringify(page.catalog).includes('D:/music'), false)
  const refs = page.catalog!.tracks[1]!
  const source = db.catalogSources({ entityId: refs.items.find((i) => i.kind === 'recording')!.id })
    .items[0]
  assert.equal(db.catalogResolve(source.id, refs.revision)!.id, 'one')
})

test('bounded track references seek exact provider IDs before expanding page-only bindings', t => {
  const db = memory(t), local = track('shared'), online = track('shared', {
    source: 'ncm', filePath: '', albumId: 'online-album', artist: 'Online artist'
  })
  seed(db, [local, ...Array.from({ length: 80 }, (_, i) => track(`unrelated-${i}`))])
  drain(db)
  remote(db, [online])
  const prepare = db.sql.prepare.bind(db.sql), plans: string[] = []
  t.mock.method(db.sql, 'prepare', (query: string) => {
    if (query.includes('WITH selected_sources AS MATERIALIZED')) {
      const inputs = JSON.stringify([
        { provider: 'local', id: 'shared' }, { provider: 'ncm', id: 'shared' },
        { provider: 'local', id: 'shared' }
      ])
      plans.push(...prepare(`EXPLAIN QUERY PLAN ${query}`).all(inputs).map(row => String(row.detail)))
    }
    return prepare(query)
  })
  const page = new LibraryDatabaseCatalogReferences(db.sql).tracks({
    revision: db.getMetadata().revision, offset: 0, total: 3, versions: {},
    tracks: [{ ...local }, { ...online }, { ...local }]
  })
  const refs = page.catalog!.tracks
  assert.deepEqual(refs[0], refs[2], 'repeated occurrences retain the same source references')
  assert.notEqual(refs[0]!.sourceId, refs[1]!.sourceId, 'equal IDs from different providers remain distinct')
  assert.equal(refs[0]!.items.find(item => item.kind === 'artist')!.title, 'Same name')
  assert.equal(refs[1]!.items.find(item => item.kind === 'artist')!.title, 'Online artist')
  assert.equal(refs[0]!.total, 4)
  assert.equal(refs[1]!.total, 4)
  assert.ok(plans.some(plan => /SEARCH .* USING INDEX catalog_source_track \(provider=\? AND track_id=\?\)/u.test(plan)),
    'page source lookup uses the existing exact provider/Track index')
  assert.equal(plans.some(plan => /MATERIALIZE catalog_entity_sources/u.test(plan)), false)
})

test('collections expose independent same-name and collaboration entities, with full exact pagination', (t) => {
  const db = memory(t)
  seed(
    db,
    Array.from({ length: 20 }, (_, i) => track(`t${i}`))
  )
  drain(db)
  const summary = db.queryCollections('artists').items[0]
  assert.equal(summary.id, 'Same name')
  assert.equal(summary.catalog!.total, 20)
  assert.equal(summary.catalog!.items.length, 8)
  const context = { type: 'collection' as const, collection: 'artists' as const, id: summary.id }
  const first = db.catalogQuery({ kind: 'artist', context, limit: 7 })
  const second = db.catalogQuery({
    kind: 'artist',
    context,
    offset: 7,
    limit: 13,
    revision: first.revision
  })
  assert.equal(first.total, 20)
  assert.equal(new Set([...first.items, ...second.items].map((i) => i.id)).size, 20)
  assert.equal(db.catalogQuery({ kind: 'artist', context, source: 'ncm' }).total, 0)
  assert.equal(db.catalogQuery({ kind: 'artist', context, search: 'not this name' }).total, 0)
  seed(db, [
    track('duet', { artist: 'Alice / Bob', artists: [{ name: 'Alice' }, { name: 'Bob' }] })
  ])
  drain(db)
  const duet = db.queryCollections('artists').items[0]
  assert.deepEqual(duet.catalog!.items.map((i) => i.title).sort(), ['Alice', 'Bob'])
  assert.deepEqual(
    db
      .catalogQuery({ kind: 'artist', context: { ...context, id: 'Alice' } })
      .items.map((i) => i.title)
      .sort(),
    ['Alice', 'Bob']
  )
})

test('large track credits have a bounded preview with accurate totals and exact expansion', (t) => {
  const db = memory(t)
  seed(db, [
    track('many', { artists: Array.from({ length: 30 }, (_, i) => ({ name: `Artist ${i}` })) })
  ])
  drain(db)
  const refs = db.queryTracks().catalog!.tracks[0]!
  assert.equal(refs.items.length, 16)
  assert.equal(refs.total, 33)
  assert.equal(
    db.catalogQuery({ kind: 'artist', context: { type: 'track', provider: 'local', id: 'many' } })
      .total,
    30
  )
})

test('playlist views keep repeated local and platform occurrences aligned, leaving unpublished entries null', (t) => {
  const db = memory(t),
    online = track('ncm:1', { source: 'ncm', filePath: '', albumId: 'a' })
  seed(db, [track('one')])
  drain(db)
  remote(db, [online])
  db.syncPlaylistView({ kind: 'begin', id: 'view', versions: [], preserveSources: true })
  db.syncPlaylistView({
    kind: 'append',
    id: 'view',
    sequence: 1,
    entries: [
      { id: 'one' },
      { id: online.id, snapshot: { ...online } },
      { id: 'one' },
      { id: 'ncm:missing', snapshot: { ...track('ncm:missing', { source: 'ncm', filePath: '' }) } }
    ]
  })
  db.syncPlaylistView({ kind: 'commit', id: 'view', sequence: 2 })
  const page = db.queryTracks({ playlistView: 'view', sort: 'playlist' })
  assert.equal(page.catalog!.tracks.length, 4)
  assert.deepEqual(page.catalog!.tracks[0], page.catalog!.tracks[2])
  assert.ok(page.catalog!.tracks[1])
  assert.equal(page.catalog!.tracks[3], null)
  assert.deepEqual(
    page.tracks.map((t) => t.id),
    ['one', 'ncm:1', 'one', 'ncm:missing']
  )
  assert.equal(page.entryIds!.length, 4)
})

test('pending edits and removal hide stale references; reindex keeps source IDs and refreshes entity membership', (t) => {
  const db = memory(t)
  seed(db, [track('one'), track('two')])
  drain(db)
  const old = db.getTracksByIds(['one', 'two'])
  db.patchTracks([{ id: 'one', expectedVersion: 1, patch: { artist: 'Renamed' } }])
  const pending = db.getTracksByIds(['one', 'two'])
  assert.equal(pending.catalog!.tracks[0], null)
  assert.ok(pending.catalog!.tracks[1])
  assert.equal(
    db.catalogQuery({ kind: 'artist', context: { type: 'track', provider: 'local', id: 'one' } })
      .total,
    0
  )
  drain(db)
  const next = db.getTracksByIds(['one']).catalog!.tracks[0]!
  assert.equal(next.sourceId, old.catalog!.tracks[0]!.sourceId)
  assert.equal(next.items.find((i) => i.kind === 'artist')!.title, 'Renamed')
  assert.throws(
    () => db.catalogQuery({ kind: 'artist', revision: old.catalog!.revision }),
    /已变化/
  )
  seed(db, [track('two')])
  assert.equal(
    db.catalogQuery({
      kind: 'artist',
      context: { type: 'track', provider: 'local', id: 'one' },
      scope: 'all'
    }).total,
    0
  )
})

test('native IDs select actual platform aliases, not title matches; reads do not create rows or jobs', (t) => {
  const db = memory(t)
  seed(db, [track('local')])
  drain(db)
  remote(db, [
    track('ncm:1', {
      source: 'ncm',
      filePath: '',
      albumId: 'a',
      artists: [{ id: 42, name: 'Same name' }]
    }),
    track('ncm:2', {
      source: 'ncm',
      filePath: '',
      albumId: 'b',
      artists: [{ id: 43, name: 'Same name' }]
    })
  ])
  const context = { type: 'native' as const, provider: 'ncm', id: '42' }
  assert.equal(db.catalogQuery({ kind: 'artist', context }).total, 1)
  assert.equal(db.catalogQuery({ kind: 'artist', context, source: 'local' }).total, 0)
  assert.equal(db.catalogQuery({ kind: 'release', context: { ...context, id: 'a' } }).total, 1)
  assert.equal(
    db.catalogQuery({ kind: 'album_project', context: { ...context, id: 'a' } }).total,
    1
  )
  const before = db.sql.prepare('SELECT count(*) n FROM catalog_entities').get()!.n
  assert.equal(db.catalogQuery({ kind: 'artist', context: { ...context, id: 'missing' } }).total, 0)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM catalog_entities').get()!.n, before)
  assert.equal(db.metadataJobs({}).total, 0)
  remote(db, [], 2)
  assert.equal(db.catalogQuery({ kind: 'artist', context }).total, 0)
})

test('manual versions change effective references and native lookup reversibly', (t) => {
  const db = memory(t),
    local = track('one'),
    online = track('ncm:1', { source: 'ncm', albumId: 'native', filePath: '' })
  seed(db, [local])
  drain(db)
  remote(db, [online])
  const original = db.getTracksByIds(['one']).catalog!.tracks[0]!
  const document = emptyMusicVersions()
  document.tracks.versions = [
    {
      id: 'v',
      label: 'Studio',
      sources: [versionSourceKey(local), versionSourceKey(online)],
      preferredSource: null
    }
  ]
  document.albums.versions = [
    {
      id: 'a',
      label: 'Edition',
      sources: [
        JSON.stringify(['album', 'local', getAlbumIdentity(local)]),
        JSON.stringify(['album', 'ncm', getAlbumIdentity(online)])
      ],
      preferredSource: null
    }
  ]
  db.catalogProjectVersions(document, 1)
  const effective = db.getTracksByIds(['one']).catalog!.tracks[0]!
  assert.notEqual(
    effective.items.find((i) => i.kind === 'recording')!.id,
    original.items.find((i) => i.kind === 'recording')!.id
  )
  const release = effective.items.find((i) => i.kind === 'release')!
  assert.equal(release.title, 'Edition')
  assert.equal(
    db.catalogQuery({ kind: 'release', context: { type: 'native', provider: 'ncm', id: 'native' } })
      .items[0].id,
    release.id
  )
  const album = db.queryCollections('albums').items[0]
  assert.equal(album.catalog!.items.find((i) => i.kind === 'release')!.id, release.id)
  assert.equal(
    db.catalogQuery({
      kind: 'release',
      context: { type: 'collection', collection: 'albums', id: album.id }
    }).items[0].id,
    release.id
  )
  db.catalogProjectVersions(emptyMusicVersions(), 2)
  assert.deepEqual(db.getTracksByIds(['one']).catalog!.tracks[0]!.items, original.items)
})

test('collection search does not narrow members; scope and legacy album aliases stay authoritative', (t) => {
  const db = memory(t)
  seed(db, [
    track('one', {
      title: 'First song',
      filePath: 'D:/music/disc1/one.flac',
      cover: 'shared-cover',
      albumArtist: 'Artist'
    }),
    track('two', {
      title: 'Second song',
      filePath: 'D:/music/disc2/two.flac',
      cover: 'shared-cover',
      albumArtist: 'Artist'
    })
  ])
  drain(db)
  const albums = db.queryCollections('albums')
  for (const album of albums.items) {
    const members = db.queryTracks({ albumId: album.id })
    const releases = new Set(
      members.catalog!.tracks.flatMap((r) =>
        r!.items.filter((i) => i.kind === 'release').map((i) => i.id)
      )
    )
    const context = { type: 'collection' as const, collection: 'albums' as const, id: album.id }
    assert.deepEqual(
      new Set(db.catalogQuery({ kind: 'release', context }).items.map((i) => i.id)),
      releases
    )
    assert.deepEqual(
      new Set(album.catalog!.items.filter((i) => i.kind === 'release').map((i) => i.id)),
      releases
    )
  }
  assert.equal(db.queryCollections('artists', { search: 'Same name' }).items[0].catalog!.total, 2)
  assert.equal(db.queryCollections('artists', { ids: ['one'] }).items[0].catalog!.total, 1)
})

test('context input fence accepts legacy IDs and rejects malformed selectors without interpreting SQL or URLs', () => {
  const valid = (context: unknown, kind = 'artist') =>
    validCatalogPayload('catalog.query', { kind, context })
  assert.ok(
    valid({ type: 'collection', collection: 'albums', id: 'D:/music/album|Artist' }, 'release')
  )
  assert.ok(valid({ type: 'native', provider: 'ncm', id: '42' }))
  for (const context of [
    null,
    [],
    { type: 'native', provider: 'local', id: '42' },
    { type: 'native', provider: 'https://evil.test', id: '42' },
    { type: 'native', provider: "x' OR 1=1--", id: '42' },
    { type: 'native', provider: 'ncm', id: 'a'.repeat(129) },
    { type: 'track', provider: 'local', id: 'x\0y' },
    { type: 'track', provider: 'local', id: 'one', sql: '1=1' },
    { type: 'collection', collection: ['artists'], id: 'Name' },
    { type: 'collection', collection: 'artists', id: 'x'.repeat(32769) }
  ])
    assert.equal(valid(context), false)
  assert.equal(valid({ type: 'native', provider: 'ncm', id: '42' }, 'recording'), false)
  assert.equal(validCatalogPayload('catalog.query', { kind: ['artist'], context: { type: 'native', provider: 'ncm', id: '42' } }), false)
})
