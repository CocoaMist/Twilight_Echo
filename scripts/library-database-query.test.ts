import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../src/main/library/libraryDatabase.ts'
import type { LibraryQuery } from '../src/shared/libraryDatabase.ts'
import { normalizeLibraryPath } from '../src/shared/libraryIdentity.ts'
import type { Track } from '../src/renderer/src/types/music'
import { buildDerivedCollections } from '../src/renderer/src/stores/library/derivedCollections.ts'
import {
  applyLibraryView,
  createDefaultLibraryViewState
} from '../src/renderer/src/utils/libraryViewPreferences.ts'
import { filterLocalGridItems } from '../src/renderer/src/utils/localLibrarySearch.ts'
import {
  resolveLibraryArtistTracks,
  applyLibraryCollectionView,
  collectionIndexLetter
} from '../src/renderer/src/utils/libraryCollectionView.ts'

function fixture(t: test.TestContext, values: Partial<Track>[]) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const tracks: Track[] = values.map((value, index) => ({
    id: `${index}`,
    filePath: `C:\\Music\\Release\\${index}.flac`,
    fileName: `${index}.flac`,
    artist: 'Singer',
    title: `歌曲 ${index}`,
    album: 'Release',
    duration: 200,
    size: 1,
    cover: null,
    lyrics: null,
    ...value
  }))
  db.replaceDocument({ version: 2, revision: 0, tracks, folders: ['C:\\Music'], exclusions: [] })
  return { db, tracks }
}

test('database ordering matches legacy collation, numeric and stable album-track rules', (t) => {
  const { db, tracks } = fixture(t, [
    {
      title: '中文',
      duration: 0,
      sampleRate: 192000,
      fileName: '10.flac',
      discNumber: 2,
      trackNumber: 1
    },
    {
      title: 'A',
      duration: 300,
      sampleRate: 48000,
      fileName: '2.flac',
      discNumber: 1,
      trackNumber: 0
    },
    {
      title: '阿',
      duration: 100,
      sampleRate: 44100,
      fileName: '1.flac',
      discNumber: 1,
      trackNumber: 2
    },
    { title: 'A', duration: 300, sampleRate: 48000, fileName: '20.flac' }
  ])
  for (const sort of [
    'title',
    'artist',
    'album',
    'format',
    'duration',
    'sampleRate',
    'addedAt',
    'trackNumber',
    'playlist'
  ] as const) {
    for (const direction of ['asc', 'desc'] as const) {
      const expected = applyLibraryView(tracks, {
        ...createDefaultLibraryViewState('allSongs'),
        sortKey: sort,
        sortDirection: direction
      }).map((track) => track.id)
      assert.deepEqual(
        db.queryTracks({ sort, direction }).tracks.map((track) => track.id),
        expected,
        `${sort} ${direction}`
      )
    }
  }
})

test('insertion tail reads honor direction without changing the playlist compatibility sort', (t) => {
  const { db, tracks } = fixture(
    t,
    Array.from({ length: 405 }, () => ({}))
  )
  assert.deepEqual(
    db
      .queryTracks({ sort: 'insertion', direction: 'desc', limit: 6 })
      .tracks.map((track) => track.id),
    tracks
      .slice(-6)
      .reverse()
      .map((track) => track.id)
  )
  assert.deepEqual(
    db
      .queryTracks({ sort: 'playlist', direction: 'desc', limit: 6 })
      .tracks.map((track) => track.id),
    tracks.slice(0, 6).map((track) => track.id)
  )
  const queue = db.createLibraryQueue({ sort: 'insertion', direction: 'desc' }, '400')
  assert.equal(queue.total, 405)
  assert.equal(queue.index, 4)
})

test('recent activity keeps addedAt ties in reverse insertion order across pages, anchors and queues', (t) => {
  const { db, tracks } = fixture(
    t,
    Array.from({ length: 605 }, (_, i) => ({
      title: `Song ${i}`,
      addedAt: i % 3 === 0 ? 100 : 0
    }))
  )
  const expected = tracks
    .map((track, position) => ({ track, position }))
    .sort((a, b) => (b.track.addedAt ?? 0) - (a.track.addedAt ?? 0) || b.position - a.position)
    .map((item) => item.track.id)
  const query = { sort: 'recentlyAdded' as const }
  assert.deepEqual(
    Array.from({ length: 4 }, (_, i) => db.queryTracks({ ...query, offset: i * 200 }).tracks)
      .flat()
      .map((track) => track.id),
    expected
  )
  assert.deepEqual(
    db.queryTracks({ ...query, search: 'song', offset: 200 }).tracks.map((track) => track.id),
    expected.slice(200, 400)
  )
  const anchor = db.queryTracks({ ...query, anchorId: expected[400] })
  assert.equal(anchor.anchorIndex, 400)
  assert.equal(anchor.offset, 400)
  const queue = db.createLibraryQueue(query, expected[400])
  assert.equal(queue.index, 400)
  assert.deepEqual(
    db.readLibraryQueue(queue.id, 0, 605).items.map((item) => item.track?.id),
    expected
  )
  const build = db.beginLibraryQueueBuild(query, expected[400])
  let result = db.advanceLibraryQueueBuild(build)
  while (!result.ready) result = db.advanceLibraryQueueBuild(build)
  assert.equal(result.queue.index, 400)
  assert.deepEqual(
    db.readLibraryQueue(result.queue.id, 0, 605).items.map((item) => item.track?.id),
    expected
  )
  const plan = db.sql
    .prepare('EXPLAIN QUERY PLAN SELECT id FROM tracks ORDER BY added_at DESC,seq DESC LIMIT 30')
    .all()
  assert.match(plan.map((row) => row.detail).join(' '), /tracks_added/)
  assert.doesNotMatch(plan.map((row) => row.detail).join(' '), /TEMP B-TREE/)
  // Ordinary addedAt sort retains its original stable tie contract.
  const ordinary = db.queryTracks({ sort: 'addedAt', direction: 'desc', limit: 605 }).tracks
  assert.deepEqual(
    ordinary.filter((item) => item.addedAt === 100).map((item) => item.id),
    tracks.filter((item) => item.addedAt === 100).map((item) => item.id)
  )
  db.syncPlaylistView({ kind: 'begin', id: 'activity', versions: [], preserveSources: true })
  let sequence = 0
  for (let offset = 0; offset < tracks.length; offset += 200)
    db.syncPlaylistView({
      kind: 'append',
      id: 'activity',
      sequence: ++sequence,
      entries: tracks.slice(offset, offset + 200).map((track) => ({ id: track.id }))
    })
  db.syncPlaylistView({ kind: 'commit', id: 'activity', sequence: ++sequence })
  assert.deepEqual(
    db
      .queryTracks({ ...query, playlistView: 'activity', offset: 200 })
      .tracks.map((track) => track.id),
    expected.slice(200, 400)
  )
  const mixedQueue = db.createLibraryQueue({ ...query, playlistView: 'activity' }, expected[400])
  assert.equal(mixedQueue.index, 400)
  assert.deepEqual(
    db.readLibraryQueue(mixedQueue.id, 0, 605).items.map((item) => item.track?.id),
    expected
  )
})

test('collection count-only reads preserve raw artist labels and all scoped/search identity rules', (t) => {
  const { db } = fixture(t, [
    { artist: ' Singer ', genre: 'Rock', album: 'A' },
    { artist: 'Singer', genre: 'Pop', album: 'B' },
    { artist: 'Invalid credit data', artists: 'not an array' as never },
    { artist: '' },
    { artist: undefined },
    { artist: 5 as never },
    { artist: 0 as never },
    { artist: { unusual: true } as never }
  ])
  for (const kind of ['albums', 'artists', 'folders', 'genres'] as const)
    for (const query of [
      {},
      { search: 'Singer' },
      { search: 'Singer', collectionNamesOnly: true },
      { collectionGenre: 'rock' },
      { filters: { lossless: true } }
    ] satisfies LibraryQuery[]) {
      const expected = db.queryCollections(kind, query)
      const count = db.queryCollections(kind, {
        ...query,
        collectionCountOnly: true,
        offset: 100,
        limit: 1
      })
      assert.equal(count.total, expected.total, `${kind} ${JSON.stringify(query)}`)
      assert.deepEqual(count.items, [])
      assert.deepEqual(count.letterOffsets, {})
      assert.equal(count.offset, 0)
    }
  assert.equal(
    db.queryCollections('artists', {
      collectionCountOnly: true,
      collectionSearchMode: 'artistName',
      search: ''
    }).total,
    0
  )
  assert.throws(
    () => db.queryCollections('artists', { collectionCountOnly: 1 } as never),
    /Invalid/
  )
})

test('collection order-window eviction does not repeat aggregation for label-only catalog searches', (t) => {
  const { db } = fixture(t, [{ album: 'First' }, { album: 'Second' }])
  const prepare = db.sql.prepare.bind(db.sql)
  let aggregates = 0
  t.mock.method(db.sql, 'prepare', (sql: string) => {
    const statement = prepare(sql)
    if (sql.startsWith('WITH groups')) {
      const all = statement.all.bind(statement)
      t.mock.method(statement, 'all', (...args: Parameters<typeof all>) => {
        aggregates++
        return all(...args)
      })
    }
    return statement
  })
  for (let i = 0; i < 5; i++) {
    db.queryCollections('albums', { collectionSort: 'trackCount', direction: 'desc' })
    db.queryCollections('artists', { collectionSearchMode: 'artistName', search: 'Singer' })
    db.queryCollections('albums', { collectionSearchMode: 'albumTerms', search: 'First' })
    db.queryCollections('albums', { sort: 'addedAt' })
    db.queryCollections('albums', { collectionNamesOnly: true, search: 'Second' })
  }
  assert.equal(aggregates, 2, 'different sort/search windows share album and artist aggregates')
  db.patchTracks([{ id: '0', expectedVersion: 1, patch: { title: 'changed' } }])
  db.queryCollections('albums')
  assert.equal(aggregates, 3, 'content changes invalidate the aggregate cache')
})

test('home album ranking preserves legacy label and ID tie breaks before pagination', (t) => {
  const { db, tracks } = fixture(t, [
    { albumId: 'id:a', album: '同名' },
    { albumId: 'id:z', album: '同名' },
    { albumId: 'id:a', album: '同名' },
    { albumId: 'id:z', album: '同名' },
    { albumId: 'id:alpha', album: 'Alpha 10' },
    { albumId: 'id:two', album: 'Alpha 2' }
  ])
  const legacy = buildDerivedCollections(tracks, [], '').albums
  for (const direction of ['asc', 'desc'] as const) {
    const expected = [...legacy].sort(
      (a, b) => (a.trackCount - b.trackCount) * (direction === 'desc' ? -1 : 1)
    )
    const actual: string[] = []
    for (let offset = 0; offset < expected.length; offset += 2) {
      const page = db.queryCollections('albums', {
        collectionSort: 'trackCount',
        direction,
        limit: 2,
        offset
      })
      assert.equal(page.total, expected.length)
      actual.push(...page.items.map((item) => item.id))
    }
    assert.deepEqual(
      actual,
      expected.map((item) => item.id)
    )
  }
  assert.throws(() => db.queryCollections('albums', { collectionSort: 'bad' } as never), /Invalid/)
})

test('album summaries and ID-based detail queries preserve directory and shared-artwork release identity', (t) => {
  const { db, tracks } = fixture(t, [
    { album: 'Same title', artist: 'Guest', albumArtist: 'Guest' },
    { album: 'Same title', artist: 'Owner', albumArtist: 'Owner' },
    { filePath: 'C:\\Other\\one.flac', album: 'Same title' },
    { filePath: 'C:\\Split1\\one.flac', album: 'Split', cover: 'cover://shared.jpg' },
    { filePath: 'C:\\Split2\\two.flac', album: 'Split', cover: 'cover://shared.jpg' },
    { filePath: 'C:\\Explicit\\one.flac', album: 'Same title', albumId: 'explicit' }
  ])
  const old = buildDerivedCollections(tracks, [], ',').albums
  const summaries = db.queryCollections('albums')
  assert.equal(summaries.total, old.length)
  for (const album of old) {
    const summary = summaries.items.find((item) => item.id === album.id)
    assert.equal(summary?.trackCount, album.trackCount)
    assert.deepEqual(
      new Set(db.queryTracks({ albumId: album.id }).tracks.map((track) => track.id)),
      new Set(album.tracks.map((track) => track.id))
    )
    assert.equal('tracks' in summary!, false)
  }
})

test('genre summaries share configurable splitting, de-duplication and unknown labels', (t) => {
  const { db, tracks } = fixture(t, [
    { genre: 'Pop / 华语,POP' },
    { genre: '华语;Rock' },
    { genre: null }
  ])
  for (const genreSeparators of [',;/', ';']) {
    const old = buildDerivedCollections(tracks, [], genreSeparators).genres
    const summaries = db.queryCollections('genres', { genreSeparators })
    assert.equal(summaries.total, old.length)
    for (const genre of old) {
      assert.equal(
        summaries.items.find((item) => item.id === genre.name)?.trackCount,
        genre.trackCount
      )
      assert.equal(db.queryTracks({ genre: genre.name, genreSeparators }).total, genre.trackCount)
    }
  }
})

test('queue snapshots preserve repeated members and give each occurrence a distinct stable entry ID', (t) => {
  const { db } = fixture(t, [{}, {}])
  const query: LibraryQuery = { ids: ['1', '0', '1'], sort: 'playlist', direction: 'desc' }
  assert.deepEqual(
    db.queryTracks(query).tracks.map((track) => track.id),
    ['1', '0', '1']
  )
  const queue = db.createLibraryQueue(query),
    page = db.readLibraryQueue(queue.id)
  assert.equal(queue.total, 3)
  assert.deepEqual(
    page.items.map((item) => item.track?.id),
    ['1', '0', '1']
  )
  assert.equal(new Set(page.items.map((item) => item.queueEntryId)).size, 3)
  assert.deepEqual(
    db.readLibraryQueue(queue.id).items.map((item) => item.queueEntryId),
    page.items.map((item) => item.queueEntryId)
  )
})

test('IDs outside the current page remain authoritative and malformed query bounds are rejected', (t) => {
  const { db } = fixture(
    t,
    Array.from({ length: 260 }, () => ({}))
  )
  assert.equal(db.queryTracks().tracks.length, 200)
  assert.equal(db.getTracksByIds(['250']).tracks[0].id, '250')
  for (const query of [
    { limit: 0 },
    { limit: 1001 },
    { offset: -1 },
    { offset: NaN },
    { sort: 'constructor' },
    { filters: { bitDepth: Infinity } },
    null
  ])
    assert.throws(() => db.queryTracks(query as LibraryQuery))
  assert.throws(() => db.queryCollections('constructor' as 'albums'))
  assert.throws(() => db.getTracksByIds(Array(1001).fill('one')))
  assert.equal(db.queryTracks({ search: '歌曲', sort: 'duration' }).total, 260)
  const version = db.getTracksByIds(['250']).versions['250']
  db.patchTracks([{ id: '250', expectedVersion: version, patch: { title: 'Different' } }])
  assert.equal(db.queryTracks({ search: '歌曲', sort: 'duration' }).total, 259)
})

test('folder summaries and detail scopes retain ancestor groups, nested roots and path boundaries', (t) => {
  const { db, tracks } = fixture(t, [
    {
      filePath: 'C:\\Music\\disc\\part1\\one.flac',
      dir: 'C:\\Music\\disc\\part1',
      cover: 'cover://first.jpg'
    },
    {
      filePath: 'C:\\Music\\disc\\part2\\two.flac',
      dir: 'C:\\Music\\disc\\part2',
      cover: 'cover://second.jpg'
    },
    { filePath: 'C:\\Music\\other\\three.flac', dir: 'C:\\Unrelated' },
    { filePath: 'C:\\Music-other\\four.flac' },
    { filePath: 'C:\\Outside\\five.flac' }
  ])
  for (const folders of [['C:\\Music'], ['C:\\Music', 'c:/music/disc/'], []]) {
    db.updateConfiguration({ folders, exclusions: [] })
    const expected = buildDerivedCollections(tracks, folders, ',').folders
    const actual = db.queryCollections('folders')
    assert.equal(actual.total, expected.length)
    for (const folder of expected) {
      const summary = actual.items.find((row) => row.id === normalizeLibraryPath(folder.path!))!
      assert.equal(summary.name, folder.name)
      assert.equal(summary.trackCount, folder.trackCount)
      assert.equal(summary.cover, folder.cover)
      assert.equal(normalizeLibraryPath(summary.path!), normalizeLibraryPath(folder.path!))
      assert.deepEqual(
        new Set(
          db
            .queryTracks({ folder: summary.path, recursive: folders.length > 0 })
            .tracks.map((track) => track.id)
        ),
        new Set(folder.tracks.map((track) => track.id))
      )
    }
  }
})

test('invalid metadata directories cannot escape or bypass a containing nested scan root', (t) => {
  const { db } = fixture(t, [{ filePath: 'C:\\Music\\disc\\one.flac', dir: 'C:\\Music\\wrong' }])
  db.updateConfiguration({ folders: ['C:\\Music', 'C:\\Music\\disc'], exclusions: [] })
  assert.deepEqual(
    db
      .queryCollections('folders')
      .items.map((item) => item.id)
      .sort(),
    ['c:\\music', 'c:\\music\\disc']
  )
  assert.equal(db.queryTracks({ folder: 'C:\\Music\\disc', recursive: true }).total, 1)
})

test('collection search chooses whole collections and preserves counts, covers and paged members', (t) => {
  const { db, tracks } = fixture(t, [
    { title: 'Needle song', genre: 'Pop', fileName: 'unique.flac', addedAt: 1 },
    { title: 'Other song', genre: 'Pop', cover: 'cover://z-first.jpg', addedAt: 2 },
    { title: 'Third song', genre: 'Pop', cover: 'cover://a-later.jpg', addedAt: 3 },
    { filePath: 'C:\\Elsewhere\\four.flac', album: 'Unrelated', artist: 'Different', genre: 'Rock' }
  ])
  const collections = buildDerivedCollections(tracks, ['C:\\Music'], ',')
  for (const kind of ['albums', 'artists', 'genres', 'folders'] as const) {
    for (const search of ['Needle', 'unique', 'Singer', 'Release']) {
      const expected = filterLocalGridItems(collections[kind], search)
      const page = db.queryCollections(kind, { search, limit: 1 })
      assert.equal(page.total, expected.length, `${kind}: ${search}`)
      for (const result of page.items) {
        const original = expected.find((item) =>
          kind === 'albums' ? item.id === result.id : item.name === result.name
        )!
        assert.equal(result.trackCount, original.trackCount)
        assert.equal(result.cover, original.cover)
        assert.equal('tracks' in result, false)
      }
    }
  }
  const before = db.queryCollections('albums', { search: 'Needle' })
  const version = db.getTracksByIds(['0']).versions['0']
  db.patchTracks([{ id: '0', expectedVersion: version, patch: { title: 'Changed' } }])
  assert.equal(db.queryCollections('albums', { search: 'Needle' }).total, 0)
  assert.ok(db.getMetadata().revision > before.revision)
})

test('album page summaries match ordered covers, durable sources, release dates and compilation artists', (t) => {
  const { db, tracks } = fixture(t, [
    {
      album: 'Release',
      trackNumber: 3,
      releaseDate: '1999',
      artist: 'Guest A',
      albumArtist: 'Guest A',
      cover: 'cover://late.jpg',
      coverSource: 'late-source'
    },
    {
      album: 'RELEASE',
      trackNumber: 2,
      releaseDate: '2020-03-01',
      artist: 'Guest B',
      albumArtist: 'Guest B'
    },
    {
      album: 'Release',
      trackNumber: 1,
      releaseDate: '2020',
      artist: 'Guest C',
      albumArtist: 'Guest C',
      cover: 'cover://early.jpg',
      coverSource: 'early-source'
    },
    {
      filePath: 'C:\\Other\\one.flac',
      album: 'Other',
      albumArtist: 'Owner',
      cover: null,
      coverSource: 'durable-only',
      releaseDate: 'bad'
    }
  ])
  const expected = buildDerivedCollections(tracks, ['C:\\Music'], ',').albums
  for (const original of expected) {
    const summary = db.queryCollections('albums').items.find((item) => item.id === original.id)!
    for (const field of [
      'name',
      'artist',
      'cover',
      'coverSource',
      'releaseDate',
      'trackCount'
    ] as const)
      assert.equal(summary[field], original[field], field)
  }
  assert.equal(db.queryCollections('albums', { search: '群星' }).items[0]?.trackCount, 3)
})

test('artist links use structured credits, exact split names and the unknown artist fallback', (t) => {
  const { db, tracks } = fixture(t, [
    { artist: 'A / B' },
    { artist: 'B' },
    { artist: 'AB' },
    { artist: 'Literal / Slash', artists: [{ name: 'Literal / Slash', id: 'literal' }] },
    { artist: '', artists: [{ name: 'Alias', id: 'alias' }] }
  ])
  for (const artist of [
    'A',
    'B',
    'AB',
    'A / B',
    'Literal',
    'Literal / Slash',
    'Alias',
    '未知艺术家'
  ])
    assert.deepEqual(
      db.queryTracks({ artist, sort: 'playlist' }).tracks.map((track) => track.id),
      resolveLibraryArtistTracks(tracks, artist).map((track) => track.id),
      artist
    )
})

test('artist cards merge solo and collaboration membership before counting, filtering and paging', (t) => {
  const { db } = fixture(t, [
    { artist: 'Alice', title: 'Solo', album: 'Solo album', duration: 100 },
    { artist: 'Alice/Bob', artists: [{ name: 'Alice' }, { name: 'Bob' }], title: 'Duet', album: 'Shared album', duration: 200 },
    { artist: 'Bob / Alice', artists: [{ name: 'Bob' }, { name: 'Alice' }, { name: ' Alice ' }], title: 'Again', album: 'Shared album', duration: 300 },
    { artist: 'Bob / Carol', title: 'Legacy duet', album: 'Other album', duration: 400 },
    { artist: 'AC/DC', title: 'Band', duration: 500 },
    { artist: 'Literal / Slash', artists: [{ name: 'Literal / Slash' }], duration: 600 }
  ])
  const all = db.queryCollections('artists', { collectionSort: 'label' })
  assert.deepEqual(all.items.map(item => item.name).sort(), ['AC/DC', 'Alice', 'Bob', 'Carol', 'Literal / Slash'])
  assert.equal(db.queryCollections('artists', { collectionCountOnly: true }).total, all.total)
  for (const [name, ids, duration] of [
    ['Alice', ['0', '1', '2'], 600],
    ['Bob', ['1', '2', '3'], 900],
    ['Carol', ['3'], 400]
  ] as const) {
    const summary = all.items.find(item => item.name === name)!
    assert.equal(summary.trackCount, ids.length)
    assert.equal(summary.duration, duration)
    const query = { artist: name, sort: 'playlist' as const }
    assert.deepEqual(db.queryTracks(query).tracks.map(track => track.id), ids)
    const queue = db.createLibraryQueue(query)
    assert.deepEqual(db.readLibraryQueue(queue.id, 0, 20).items.map(item => item.track!.id), ids)
  }
  assert.equal(db.queryCollections('albums', { artist: 'Alice' }).total, 2)
  assert.equal(db.queryTracks({ artist: 'Alice', search: 'Duet' }).total, 1)
  assert.deepEqual(db.queryTracks({ artist: 'Alice/Bob' }).tracks.map(track => track.id), ['1'], 'old full-credit links still work')
  const search = { search: 'Alice', collectionSearchMode: 'artistName' as const }
  assert.deepEqual(db.queryCollections('artists', search).items.map(item => item.name), ['Alice'])
  assert.equal(db.queryCollections('artists', { search: 'Duet' }).items.find(item => item.name === 'Alice')!.trackCount, 3)
  const first = db.queryCollections('artists', { limit: 2 }), second = db.queryCollections('artists', { offset: 2, limit: 3 })
  assert.deepEqual([...first.items, ...second.items].map(item => item.id), db.queryCollections('artists').items.map(item => item.id))
  db.patchTracks([{ id: '1', expectedVersion: db.getTracksByIds(['1']).versions['1'], patch: { artists: [{ name: 'Carol' }] } }])
  assert.equal(db.queryCollections('artists').items.find(item => item.name === 'Carol')!.trackCount, 2)
  assert.equal(db.queryCollections('artists', { collectionCountOnly: true }).total, 5)
})

test('collection added-at ordering uses complete member dates and stable natural-name ties', (t) => {
  const { db } = fixture(t, [
    { album: 'Album 10', artist: 'Ten', addedAt: 10 },
    { album: 'Album 2', artist: 'Two', addedAt: 20 },
    { album: 'Album 3', artist: 'Three', addedAt: 20 },
    { album: 'Album 1', artist: 'One', addedAt: 1 }
  ])
  assert.deepEqual(
    db
      .queryCollections('albums', { sort: 'addedAt', direction: 'desc' })
      .items.map((item) => item.name),
    ['Album 2', 'Album 3', 'Album 10', 'Album 1']
  )
  assert.deepEqual(
    db
      .queryCollections('albums', { sort: 'addedAt', direction: 'asc', offset: 1, limit: 2 })
      .items.map((item) => item.name),
    ['Album 10', 'Album 2']
  )
})

test('collection genre filters choose complete groups, retaining unmatched members, covers, dates and durations', (t) => {
  const { db, tracks } = fixture(t, [
    { album: 'One', artist: 'Singer A', genre: 'Pop/Rock', duration: 60, addedAt: 1 },
    {
      album: 'One',
      artist: 'Singer A',
      genre: 'Jazz',
      duration: 90,
      addedAt: 99,
      cover: 'cover://other.jpg'
    },
    { album: 'Two', artist: 'Singer B', genre: 'Rock', duration: 120, addedAt: 50 },
    { album: 'Three', artist: 'Singer C', genre: 'Jazz', duration: 50 }
  ])
  const old = buildDerivedCollections(tracks, ['C:\\Music'], '/')
  for (const kind of ['albums', 'artists'] as const) {
    for (const sort of ['name-asc', 'name-desc', 'added-newest', 'added-oldest'] as const) {
      const expected = applyLibraryCollectionView(old[kind], { sort, genre: ' rock ' }, '/')
      const actual = db.queryCollections(kind, {
        collectionGenre: ' rock ',
        genreSeparators: '/',
        sort: sort.startsWith('added-') ? 'addedAt' : 'title',
        direction: ['name-desc', 'added-newest'].includes(sort) ? 'desc' : 'asc',
        limit: 1
      })
      assert.equal(actual.total, expected.length)
      assert.equal(actual.items[0].name, expected[0].name)
      assert.equal(actual.items[0].trackCount, expected[0].trackCount)
      assert.equal(
        actual.items[0].duration,
        expected[0].tracks.reduce((sum, track) => sum + track.duration, 0)
      )
      assert.equal(actual.items[0].cover, expected[0].cover)
    }
  }
  const summary = db.queryCollections('albums', { collectionGenre: 'Pop', genreSeparators: '/' })
    .items[0]
  assert.equal(summary.addedAt, 99)
  assert.equal(summary.duration, 150)
  assert.equal(db.queryTracks({ albumId: summary.id }).total, 2)
  assert.equal(db.queryCollections('albums', { collectionGenre: 'Rock', search: 'Jazz' }).total, 0)
  const changed = db.getTracksByIds(['0'])
  db.patchTracks([{ id: '0', expectedVersion: changed.versions['0'], patch: { genre: 'Blues' } }])
  assert.equal(
    db.queryCollections('albums', { collectionGenre: 'Pop', genreSeparators: '/' }).total,
    0
  )
})

test('A-Z positions cover the complete filtered order beyond page boundaries for every sort', (t) => {
  const { db } = fixture(
    t,
    Array.from({ length: 620 }, (_, i) => ({
      artist: i < 410 ? `A name ${i}` : i < 615 ? `周 name ${i}` : `B name ${i}`,
      genre: i % 2 ? 'Rock' : 'Pop',
      addedAt: i % 17
    }))
  )
  for (const sort of ['title', 'addedAt'] as const)
    for (const direction of ['asc', 'desc'] as const) {
      const query = { sort, direction, collectionGenre: 'Rock' }
      const all = db.queryCollections('artists', { ...query, limit: 1000 })
      const expected: Record<string, number> = {}
      all.items.forEach((item, index) => {
        const letter = collectionIndexLetter(item.name)
        if (letter && expected[letter] === undefined) expected[letter] = index
      })
      const page = db.queryCollections('artists', { ...query, offset: 200 })
      assert.deepEqual(page.letterOffsets, expected)
      assert.equal(page.offset, 200)
      assert.equal(page.total, 310)
      for (const index of Object.values(expected)) {
        const target = db.queryCollections('artists', {
          ...query,
          offset: Math.floor(index / 200) * 200
        })
        assert.equal(target.items[index % 200].id, all.items[index].id)
      }
    }
})

test('genre suggestions search all names without matching unrelated members and remain paged', (t) => {
  const { db } = fixture(
    t,
    Array.from({ length: 260 }, (_, i) => ({
      genre: `流派 ${i}`,
      title: 'Needle',
      artist: '周杰伦'
    }))
  )
  assert.equal(db.queryCollections('genres', { search: 'Needle' }).total, 260)
  assert.equal(
    db.queryCollections('genres', { search: 'Needle', collectionNamesOnly: true }).total,
    0
  )
  assert.equal(
    db.queryCollections('genres', { search: '流派259', collectionNamesOnly: true }).items[0].name,
    '流派 259'
  )
  assert.equal(db.queryCollections('artists', { search: 'zjl' }).total, 1)
  const page = db.queryCollections('genres', { collectionNamesOnly: true })
  assert.equal(page.total, 260)
  assert.equal(page.items.length, 200)
  assert.throws(() => db.queryCollections('genres', { collectionNamesOnly: 1 } as never))
  assert.throws(() => db.queryCollections('artists', { collectionGenre: [] } as never))
})

test('track query duration describes the whole scope and duplicate playlist occurrences, never the loaded page', (t) => {
  const { db } = fixture(t, [{ duration: 60 }, { duration: 90 }, { duration: -1 }, { duration: 0 }])
  for (const sort of ['title', 'duration', 'trackNumber'] as const) {
    const page = db.queryTracks({ sort, limit: 1, offset: 1 })
    assert.equal(page.totalDuration, 150)
    assert.equal(page.total, 4)
    assert.equal(db.queryTracks({ sort, search: '不存在', limit: 1 }).totalDuration, 0)
    assert.equal(db.queryTracks({ sort, anchorId: '1', limit: 1 }).totalDuration, 150)
  }
  const query: LibraryQuery = { sort: 'playlist', ids: ['1', '0', '1'], limit: 1 }
  assert.equal(db.queryTracks(query).totalDuration, 240)
  assert.equal(db.queryTracks({ ...query, anchorId: '0' }).totalDuration, 240)
})

test('genres and folders retain their existing default text order while artist and album controls use natural order', (t) => {
  const { db, tracks } = fixture(
    t,
    ['10', '2', '1'].map((number) => ({
      filePath: `C:\\Music\\Folder ${number}\\one.flac`,
      genre: `Genre ${number}`,
      artist: `Artist ${number}`,
      album: `Album ${number}`
    }))
  )
  const old = buildDerivedCollections(tracks, ['C:\\Music'], ',')
  for (const kind of ['genres', 'folders'] as const)
    assert.deepEqual(
      db.queryCollections(kind).items.map((item) => item.name),
      old[kind].map((item) => item.name)
    )
  for (const kind of ['albums', 'artists'] as const)
    assert.deepEqual(
      db.queryCollections(kind).items.map((item) => item.name),
      applyLibraryCollectionView(old[kind], { sort: 'name-asc', genre: null }).map(
        (item) => item.name
      )
    )
})

test('genre collection summaries resolve cover and durable coverSource from member tracks and support Roon trackCount sorting', (t) => {
  const { db, tracks } = fixture(t, [
    { title: 'One', genre: 'Jazz / Electronic', cover: null, coverSource: 'durable-jazz-cover' },
    { title: 'Two', genre: 'Pop/Rock', cover: 'cover://pop-rock-1.jpg', coverSource: 'pop-source-1' },
    { title: 'Three', genre: 'Pop/Rock', cover: 'cover://pop-rock-2.jpg' },
    { title: 'Four', genre: 'Classical', cover: null }
  ])
  const derived = buildDerivedCollections(tracks, ['C:\\Music'], '/')
  const page = db.queryCollections('genres', {
    genreSeparators: '/',
    collectionSort: 'trackCount',
    direction: 'desc'
  })
  assert.deepEqual(
    page.items.map((item) => [item.name, item.trackCount, item.cover, item.coverSource ?? null]),
    [
      ['Pop', 2, 'cover://pop-rock-1.jpg', 'pop-source-1'],
      ['Rock', 2, 'cover://pop-rock-1.jpg', 'pop-source-1'],
      ['Classical', 1, null, null],
      ['Electronic', 1, null, 'durable-jazz-cover'],
      ['Jazz', 1, null, 'durable-jazz-cover']
    ]
  )
  for (const item of page.items) {
    const match = derived.genres.find((g) => g.name === item.name)!
    assert.equal(item.cover, match.cover)
    assert.equal(item.coverSource, match.coverSource)
  }
})
