import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type { LibraryCollectionKind, LibraryQuery } from '../../../../shared/libraryDatabase.ts'
import type { Track } from '../../types/music.ts'
import { createLibraryUnifiedSearch } from './libraryUnifiedSearch.ts'
import { buildDerivedCollections } from './derivedCollections.ts'
import {
  searchLocalStreamingAlbums,
  searchLocalStreamingArtists
} from '../../utils/localStreamingSearch.ts'
import { createAlbumSearch } from '../../components/streaming-page/albumSearch.ts'
import {
  artistSearchKey,
  createArtistSearch
} from '../../components/streaming-page/artistSearch.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function fixture(t: TestContext) {
  const db = new LibraryDatabase(':memory:')
  const tracks: Track[] = Array.from({ length: 405 }, (_, i) => ({
    id: `local:${i}`,
    filePath: `D:/Music/Release-${i}/${i}.flac`,
    fileName: `${i}.flac`,
    title: `仅歌曲标题 ${i}`,
    artist: `周杰伦 ${i}`,
    album: `范特西 ${i}`,
    albumId: `release:${i}`,
    source: 'local',
    format: 'flac',
    cover: null,
    lyrics: null,
    duration: 180,
    size: 1
  }))
  tracks.push({
    ...tracks[0],
    id: 'local:extra',
    filePath: 'D:/Music/Release-0/extra.flac',
    fileName: 'extra.flac',
    trackNumber: 2,
    artist: '合作艺人',
    albumArtist: '周杰伦 0',
    cover: 'cover://stable',
    coverSource: 'https://example.test/cover.jpg'
  })
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks })
  const collections = buildDerivedCollections(tracks, [], '')
  const queries: Array<{ kind: LibraryCollectionKind; query: LibraryQuery }> = []
  const options: Parameters<typeof createLibraryUnifiedSearch>[0] = {
    getStorageMode: async () => 'sqlite',
    getJsonTracks: () => assert.fail('full renderer tracks access'),
    getJsonAlbums: () => assert.fail('full renderer albums access'),
    getJsonArtists: () => assert.fail('full renderer artists access'),
    getPreferences: () => ({ revision: 0, sources: [] }),
    api: {
      queryTracks: async (query) => db.queryTracks(query),
      getMetadata: async () => db.getMetadata(),
      queryCollections: async (kind, query = {}) => {
        queries.push({ kind, query })
        return db.queryCollections(kind, query)
      }
    }
  }
  const source = createLibraryUnifiedSearch(options)
  t.after(() => {
    source.dispose()
    db.close()
  })
  const album = createAlbumSearch({
    localAlbums: () => assert.fail('full renderer albums access'),
    localSource: source,
    providers: () => [],
    searchProvider: async () => ({ items: [], total: 0 }),
    getProvider: () => null,
    reportError: (message) => assert.fail(message)
  })
  const artist = createArtistSearch({
    localArtists: () => assert.fail('full renderer artists access'),
    localSource: source,
    providers: () => [],
    searchProvider: async () => ({ items: [], total: 0 }),
    reportError: (message) => assert.fail(message)
  })
  return { db, tracks, collections, options, source, queries, album, artist }
}

test('catalog SQL search matches every legacy album/artist page and identity without searching member metadata', async (t) => {
  const f = fixture(t)
  for (const query of [
    '范特西',
    'zjl ftx',
    '周杰伦 2',
    '范特西周杰伦',
    '范特西 周杰伦',
    '周杰伦范特西',
    '仅歌曲标题',
    '!!!'
  ]) {
    for (const offset of [0, 30, 300, 400, 500]) {
      const expected = searchLocalStreamingAlbums(f.collections.albums, query, 30, offset)
      const page = await f.source.searchAlbums(query, 30, offset)
      assert.equal(page.total, expected.total, `${query} album count`)
      assert.deepEqual(page.items, expected.albums, `${query} albums at ${offset}`)
      assert.ok(page.items.every((item) => !('tracks' in item)))
    }
  }
  for (const query of ['周杰伦', 'zjl', '周杰伦 2', '合作', '仅歌曲标题', '!!!']) {
    for (const offset of [0, 30, 300, 400, 500]) {
      const expected = searchLocalStreamingArtists(f.collections.artists, query, 30, offset)
      const page = await f.source.searchArtists(query, 30, offset)
      assert.equal(page.total, expected.total, `${query} artist count`)
      assert.deepEqual(page.items, expected.artists, `${query} artists at ${offset}`)
    }
  }
  // Same normalized concatenation but different tokenization must not hit the
  // previous query's order/filter cache.
  assert.equal((await f.source.searchAlbums('周杰伦 范特西')).total, 405)
  assert.equal((await f.source.searchAlbums('周杰伦范特西')).total, 0)
  await assert.rejects(f.source.searchAlbums('范特西', 101), /页码/)
  assert.throws(
    () => f.db.queryCollections('albums', { collectionSearchMode: 'wrong' } as never),
    /search mode/
  )
  assert.throws(
    () => f.db.queryCollections('artists', { collectionSearchMode: 'albumTerms' }),
    /does not match/
  )
  assert.throws(
    () => f.db.queryCollections('genres', { collectionSearchMode: 'artistName' }),
    /does not match/
  )
  assert.equal(
    f.db.queryCollections('albums', { search: '仅歌曲标题' }).total,
    405,
    'normal collection search retains member matching'
  )
})

test('authoritative adapters preserve deep totals and retain library aliases and remote artwork', async (t) => {
  const f = fixture(t)
  const album = await f.album.searchLocalAlbums('范特西', 30, 300)
  const artist = await f.artist.searchLocalArtists('周杰伦', 30, 300)
  assert.equal(album.total, 405)
  assert.equal(album.albums.length, 30)
  assert.equal(artist.total, 405)
  assert.equal(artist.artists.length, 30)
  assert.ok(album.albums.every((item) => item.providerId === 'local'))
  assert.ok(artist.artists.every((item) => item.providerId === 'local'))
  const first = await f.source.searchAlbums('周杰伦 0')
  assert.equal(first.items[0].coverSource, 'https://example.test/cover.jpg')
  const target = await f.source.resolveAlbum({ trackId: 'local:extra' })
  assert.equal(target.mode, 'sqlite')
  assert.equal(target.albumId, first.items[0].id)
  assert.equal((await f.source.resolveAlbum({ albumId: target.albumId })).albumId, target.albumId)
  await assert.rejects(f.source.resolveAlbum({ trackId: 'missing' }), /已不在/)
  await assert.rejects(f.source.resolveAlbum({ albumId: 'missing' }), /已不在/)
  await assert.rejects(f.source.resolveAlbum({ albumId: '' }), /标识/)
  await assert.rejects(f.source.resolveAlbum({ trackId: '' }), /标识/)
  assert.ok(
    f.queries.every(({ query }) => (query.limit ?? 200) <= 100),
    'only summary windows cross RPC'
  )
})

test('album summary queries preserve merged release aliases and canonical navigation identity', async (t) => {
  const f = fixture(t)
  const tracks: Track[] = ['one', 'two'].map((name) => ({
    ...f.tracks[0],
    id: name,
    albumId: undefined,
    filePath: `D:/Music/${name}/song.flac`,
    dir: `D:/Music/${name}`,
    album: '共同专辑',
    albumArtist: '周杰伦',
    cover: 'cover://same-release'
  }))
  f.db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks })
  const expected = buildDerivedCollections(tracks, [], '').albums
  assert.equal(expected.length, 1)
  const page = await f.source.searchAlbums('zjl 共同')
  assert.equal(page.total, 1)
  assert.equal(page.items[0].id, expected[0].id)
  assert.equal(page.items[0].trackCount, 2)
  for (const track of tracks)
    assert.equal((await f.source.resolveAlbum({ trackId: track.id })).albumId, expected[0].id)
})

test('explicit JSON mode alone uses original collection arrays; SQL and mode failures never downgrade', async (t) => {
  const f = fixture(t)
  f.options.getStorageMode = async () => 'json'
  f.options.getJsonAlbums = () => f.collections.albums
  f.options.getJsonArtists = () => f.collections.artists
  const expected = searchLocalStreamingAlbums(f.collections.albums, 'zjl ftx', 30, 300)
  assert.deepEqual((await f.source.searchAlbums('zjl ftx', 30, 300)).items, expected.albums)
  assert.equal((await f.source.searchArtists('周杰伦', 30, 300)).total, 405)
  assert.equal((await f.source.resolveAlbum({ trackId: 'local:extra' })).mode, 'json')
  assert.equal(f.queries.length, 0)
  f.options.getJsonAlbums = () => assert.fail('JSON downgrade')
  f.options.getJsonArtists = () => assert.fail('JSON downgrade')
  f.options.getStorageMode = async () => {
    throw new Error('discovery failed')
  }
  await assert.rejects(f.source.searchAlbums('范特西'), /discovery failed/)
  await assert.rejects(f.source.searchArtists('周杰伦'), /discovery failed/)
  await assert.rejects(f.source.resolveAlbum({ trackId: 'local:extra' }), /discovery failed/)
  f.options.getStorageMode = async () => 'sqlite'
  f.options.api.queryCollections = async () => {
    throw new Error('database offline')
  }
  await assert.rejects(f.album.searchAlbums('范特西'), /database offline/)
  await assert.rejects(f.artist.searchArtists('周杰伦'), /database offline/)
})

test('all-source artist pages retain origins across equal IDs and only read the requested source windows', async (t) => {
  const f = fixture(t)
  const remote = Array.from({ length: 40 }, (_, i) => ({
    id: f.collections.artists[i].name,
    name: '周杰伦',
    picUrl: null
  }))
  const calls: number[] = []
  const search = createArtistSearch({
    localArtists: () => assert.fail('renderer array'),
    localSource: f.source,
    providers: () => [{ id: 'remote', name: 'Remote', supportedMethods: ['searchArtists'] }],
    searchProvider: async (_id, _query, limit, offset, options) => {
      assert.ok(options?.signal)
      calls.push(offset)
      return { items: remote.slice(offset, offset + limit), total: remote.length }
    },
    reportError: (message) => assert.fail(message)
  })
  const signal = new AbortController().signal
  const crossing = await search.searchArtists('周杰伦', 30, 400, { signal })
  assert.equal(crossing.total, 445)
  assert.equal(crossing.artists.length, 30)
  assert.equal(crossing.artists[4].providerId, 'local')
  assert.equal(crossing.artists[5].providerId, 'remote')
  const first = await search.searchArtists('周杰伦', 30, 0, { signal })
  const provider = await search.searchProviderArtists('remote', '周杰伦', 30, 0, { signal })
  assert.notEqual(artistSearchKey(first.artists[0]), artistSearchKey(provider.artists[0]))
  assert.deepEqual(calls, [0, 0, 0])
})

for (const kind of ['albums', 'artists'] as const)
  test(`${kind}: a slow provider cannot publish local totals or pages from an older library`, async (t) => {
    const f = fixture(t)
    let release!: () => void, started!: () => void
    const wait = new Promise<void>((resolve) => {
        release = resolve
      }),
      ready = new Promise<void>((resolve) => {
        started = resolve
      })
    const base = {
      localSource: f.source,
      providers: () => [
        {
          id: 'remote',
          name: 'Remote',
          capabilities: ['search'],
          supportedMethods: ['searchAlbums', 'searchArtists']
        }
      ],
      reportError: (message: string) => assert.fail(message)
    }
    const album = createAlbumSearch({
      ...base,
      localAlbums: () => assert.fail('renderer arrays'),
      getProvider: () => null,
      searchProvider: async () => {
        started()
        await wait
        return { items: [], total: 0 }
      }
    })
    const artist = createArtistSearch({
      ...base,
      localArtists: () => assert.fail('renderer arrays'),
      searchProvider: async () => {
        started()
        await wait
        return { items: [], total: 0 }
      }
    })
    const request =
      kind === 'albums' ? album.searchAlbums('范特西') : artist.searchArtists('周杰伦')
    await ready
    f.db.patchTracks([
      { id: 'local:400', expectedVersion: 1, patch: { album: 'New Album', artist: 'New Artist' } }
    ])
    release()
    await assert.rejects(request, /发生变化/)
  })

test('collection reads share the song source concurrency bound and cancelled/disposed queries never publish', async (t) => {
  const f = fixture(t),
    releases: Array<() => void> = []
  const read = f.options.api.queryCollections!
  f.options.api.queryCollections = async (kind, query) => {
    await new Promise<void>((resolve) => {
      releases.push(resolve)
    })
    return read(kind, query)
  }
  const requests = Array.from({ length: 30 }, (_, i) =>
    f.source.searchAlbums('范特西', 10, i * 10).catch((error: unknown) => error)
  )
  await tick()
  assert.deepEqual(f.source.state, { active: 2, pending: 1 })
  releases[0]()
  releases[1]()
  await tick()
  releases[2]()
  const results = await Promise.all(requests)
  assert.equal(
    results.filter((value) => value instanceof DOMException && value.name === 'AbortError').length,
    27
  )
  assert.deepEqual(
    f.queries.map(({ query }) => query.offset),
    [0, 10, 290]
  )
  const abort = new AbortController()
  const pending = f.source.searchArtists('周杰伦', 30, 0, abort.signal)
  await tick()
  abort.abort()
  releases[3]()
  await assert.rejects(pending, { name: 'AbortError' })
  f.source.dispose()
  await assert.rejects(f.source.searchAlbums('范特西'), { name: 'AbortError' })
})
