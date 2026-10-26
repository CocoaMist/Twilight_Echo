import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreMusicSearchService } from './service.ts'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { CoreStateDatabase } from '../../main/library/coreStateDatabase.ts'
import { CoreRecordingVersions } from '../playlists/recordingVersions.ts'
import { emptyCoreStateCounts } from '../../shared/coreState.ts'
import { versionSourceKey } from '../../shared/trackSourceIdentity.ts'
import type { TrackData } from '../../shared/track.ts'

function track(id: string, title = 'Moon', extra: Partial<TrackData> = {}): TrackData {
  return {
    id,
    source: 'local',
    filePath: `D:/Music/${id}.flac`,
    fileName: `${id}.flac`,
    title,
    artist: 'Artist',
    album: 'Album',
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null,
    ...extra
  }
}
function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => (release = resolve))
  return { promise, release }
}
async function fixture(t: test.TestContext, json = false) {
  const database = new LibraryDatabase(':memory:')
  const state = new CoreStateDatabase(':memory:')
  state.begin('upgrade', { version: 1, counts: emptyCoreStateCounts() })
  state.commit('upgrade')
  const versions = new CoreRecordingVersions({
    coreStateRead: async (...args) => state.read(...args),
    coreVersionsReplace: async (...args) => state.replaceVersions(...args)
  })
  await versions.initialize()
  let library = { revision: 1, tracks: [] as TrackData[] },
    networkRevision = 0
  const providerCalls: string[] = []
  const options: ConstructorParameters<typeof CoreMusicSearchService>[0] = {
    database: {
      queryTracks: async (query) => database.queryTracks(query),
      getMetadata: async () => database.getMetadata(),
      queryCollections: async (...args) => database.queryCollections(...args)
    },
    versions,
    playlists: { getRevision: () => 0, searchLocal: () => ({ items: [], total: 0, revision: 0 }) },
    searchCollectionProvider: async () => ({ items: [], total: 0 }),
    ...(json ? { loadJsonLibrary: async () => library } : {}),
    providers: () => [{ id: 'remote', name: 'Remote', capabilities: ['search'], available: true }],
    searchProvider: async (id) => {
      providerCalls.push(id)
      return { items: [], total: 0 }
    },
    network: { revision: () => networkRevision, search: async () => [] }
  }
  const service = new CoreMusicSearchService(options)
  t.after(async () => {
    await service.shutdown()
    database.close()
    state.close()
  })
  return {
    service,
    options,
    database,
    versions,
    providerCalls,
    library: () => library,
    setTracks(tracks: TrackData[]) {
      database.replaceDocument({ version: 2, revision: 0, tracks, folders: [], exclusions: [] })
      library = { revision: database.getMetadata().revision, tracks }
    },
    networkChanged() {
      networkRevision++
    }
  }
}

test('Core SQL and development JSON use the same preferred/lossless ordering before bounded pagination', async (t) => {
  const sql = await fixture(t),
    json = await fixture(t, true)
  const tracks = Array.from({ length: 413 }, (_, i) =>
    track(String(i), `晴天 ${i}`, {
      artist: i % 4 ? '周杰伦' : '阿歌手',
      format: i % 3 ? 'flac' : 'mp3',
      fileName: `文件-${i}.flac`
    })
  )
  tracks[1] = track('cue:1', '晴天 CUE', {
    filePath: 'D:/Music/disc.flac',
    subTrack: '1',
    cueRange: { startSeconds: 0, endSeconds: 60, pregapSeconds: 0 }
  })
  tracks[2] = track('cue:2', '晴天 CUE', {
    filePath: 'D:/Music/disc.flac',
    subTrack: '2',
    cueRange: { startSeconds: 60, endSeconds: 120, pregapSeconds: 0 }
  })
  sql.setTracks(tracks)
  json.setTracks(tracks)
  for (const f of [sql, json])
    await f.versions.edit({
      revision: f.versions.getRevision(),
      scope: 'tracks',
      operation: 'prefer-source',
      label: '',
      keys: [versionSourceKey(tracks[399])]
    })
  for (const query of ['晴天', 'qt', 'zjl', '文件-412', 'CUE', 'nonexistent']) {
    for (const offset of [0, 100, 400, 800]) {
      const actual = await sql.service.songs({ query, limit: 100, offset })
      const expected = await json.service.songs({ query, limit: 100, offset })
      assert.deepEqual(
        actual.items.map((item) => item.track.id),
        expected.items.map((item) => item.track.id),
        `${query}@${offset}`
      )
      assert.equal(actual.total, expected.total)
      assert.equal(actual.hasMore, expected.hasMore)
    }
  }
  assert.equal((await sql.service.songs({ query: '晴天', limit: 1 })).items[0].track.id, '399')
  // A changed version preference invalidates the same immutable JSON array's cached index.
  await json.versions.edit({
    revision: json.versions.getRevision(),
    scope: 'tracks',
    operation: 'prefer-source',
    label: '',
    keys: [versionSourceKey(tracks[2])]
  })
  assert.equal((await json.service.songs({ query: 'CUE', limit: 1 })).items[0].track.id, 'cue:2')
})

for (const json of [false, true])
  test(`local-only ${json ? 'JSON' : 'SQL'} search keeps insertion order, excludes filenames and never calls providers/network`, async (t) => {
    const f = await fixture(t, json)
    f.setTracks([
      track('z', 'Moon', { format: 'mp3' }),
      track('a', 'Moon', { format: 'flac' }),
      track('file', 'Other', { fileName: 'Moon.flac' })
    ])
    f.options.network.search = async () => {
      throw Error('Network must not be used')
    }
    const result = await f.service.page({ query: 'Moon', scope: 'local', limit: 1, offset: 1 })
    assert.deepEqual(
      result.items.map((item) => item.track.id),
      ['a']
    )
    assert.equal(result.total, 2)
    assert.equal(result.hasMore, false)
    if (json) assert.equal(result.playbackQuery, undefined)
    else {
      assert.equal(result.playbackQuery?.sort, 'playlist')
      assert.equal(result.playbackQuery?.contentRevision, f.library().revision)
    }
    assert.deepEqual(f.providerCalls, [])
    const empty = await f.service.page({ query: '!!!', scope: 'local' })
    assert.equal(empty.total, 0)
  })

test('Core merges network and providers, retains grouping/reliability and projects every nested identity', async (t) => {
  const f = await fixture(t)
  f.setTracks([track('one', 'Moon', { format: 'flac' })])
  f.options.network.search = async () => [
    {
      profileName: 'NAS',
      entry: {
        id: 'network:one',
        profileId: 'nas',
        path: '/private/Moon.flac',
        name: 'Moon.flac',
        kind: 'audio',
        metadata: { title: 'Moon', artist: 'Artist', duration: 181 }
      }
    }
  ]
  f.options.providers = () => [
    {
      id: 'remote',
      name: 'Remote',
      capabilities: ['search'],
      health: {
        methodStats: {
          getPlaybackUrl: {
            successRate: 0.2,
            lastError: 'https://user:secret@host.test/source?token=secret'
          }
        }
      }
    },
    { id: 'healthy', name: 'Healthy', capabilities: ['search'] },
    { id: 'disabled', name: 'Disabled', capabilities: ['search'], available: false },
    { id: 'failed', name: 'Failed', capabilities: ['search'] }
  ]
  f.options.searchProvider = async (id, _query, limit, offset) => {
    assert.equal(limit, 2)
    assert.equal(offset, 0)
    assert.notEqual(id, 'disabled')
    if (id === 'failed') throw Error('https://user:secret@host.test/source?token=secret')
    return {
      items: [
        track(`${id}:one`, 'Moon', {
          source: id,
          streamUrl: 'https://secret.test/token',
          lyrics: 'private-lyrics'
        })
      ],
      total: 1
    }
  }
  const result = await f.service.page({ query: 'Moon', limit: 2 })
  assert.deepEqual(
    result.items.map((item) => item.track.id),
    ['one', 'healthy:one', 'network:one', 'remote:one']
  )
  assert.equal(result.total, 4)
  assert.equal(result.hasMore, false)
  assert.equal(result.health.failed.available, false)
  assert.equal(result.logicalItems.length, 1)
  assert.equal(result.logicalItems[0].preferredTrack.id, 'one')
  assert.doesNotMatch(
    JSON.stringify(result),
    /filePath|streamUrl|networkSource|private-lyrics|secret|\/private/
  )
  const raw = await f.service.songs({ query: 'Moon', limit: 2 })
  assert.equal(
    raw.items.find((item) => item.source === 'network')!.track.networkSource!.entry.path,
    '/private/Moon.flac'
  )
})

for (const change of ['library', 'versions', 'network'] as const)
  test(`slow provider cannot publish a stale ${change} search page`, async (t) => {
    const f = await fixture(t),
      entered = gate(),
      finish = gate()
    f.setTracks([track('one')])
    f.options.searchProvider = async () => {
      entered.release()
      await finish.promise
      return { items: [], total: 0 }
    }
    const rejected = assert.rejects(
      f.service.page({ query: 'Moon' }),
      (error: { code: string }) => error.code === 'STALE_REVISION'
    )
    await entered.promise
    if (change === 'library') f.setTracks([track('changed')])
    else if (change === 'network') f.networkChanged()
    else
      await f.versions.edit({
        revision: f.versions.getRevision(),
        scope: 'tracks',
        operation: 'prefer-source',
        label: '',
        keys: [versionSourceKey(track('one'))]
      })
    finish.release()
    await rejected
  })

test('pagination fences reject an obsolete library/version/network before publishing', async (t) => {
  const f = await fixture(t)
  f.setTracks([track('one')])
  for (const request of [
    { contentRevision: 999 },
    { versionsRevision: 999 },
    { networkRevision: 999 }
  ]) {
    await assert.rejects(f.service.page({ query: 'Moon', ...request }), /变化|changed/i)
  }
})

test('search cancellation and shutdown join providers and do not turn cancellation into partial success', async (t) => {
  const f = await fixture(t),
    entered = gate()
  let calls = 0,
    aborted = 0
  f.options.searchProvider = async (_id, _query, _limit, _offset, signal) => {
    calls++
    entered.release()
    return new Promise((_resolve, reject) =>
      signal.addEventListener(
        'abort',
        () => {
          aborted++
          reject(signal.reason)
        },
        { once: true }
      )
    )
  }
  const cancel = new AbortController()
  const first = assert.rejects(f.service.page({ query: 'Moon' }, cancel.signal), /cancelled/)
  await entered.promise
  cancel.abort(Error('cancelled'))
  await first
  const second = assert.rejects(f.service.page({ query: 'Moon' }), /shutting down/)
  while (calls < 2) await new Promise<void>((resolve) => setImmediate(resolve))
  await f.service.shutdown()
  await second
  assert.equal(aborted, 2)
  await assert.rejects(f.service.page({ query: 'Moon' }), /shutting down/)
})

test('independent clients do not share a newest-request gate or cancel each other', async (t) => {
  const f = await fixture(t),
    firstEntered = gate(),
    finishFirst = gate()
  f.options.searchProvider = async (_id, query) => {
    if (query === 'first') {
      firstEntered.release()
      await finishFirst.promise
    }
    return { items: [track(`remote:${query}`, query, { source: 'remote' })], total: 1 }
  }
  const first = f.service.page({ query: 'first' })
  await firstEntered.promise
  assert.equal((await f.service.page({ query: 'second' })).items[0].track.id, 'remote:second')
  finishFirst.release()
  assert.equal((await first).items[0].track.id, 'remote:first')
})

test('Core album/artist searches retain SQL and explicit JSON catalog identities and matching', async (t) => {
  const sql = await fixture(t),
    json = await fixture(t, true)
  const tracks = Array.from({ length: 68 }, (_, i) =>
    track(String(i), `Song ${i}`, {
      album: `范特西 ${Math.floor(i / 2)}`,
      albumId: `release:${Math.floor(i / 2)}`,
      artist: i % 3 ? '周杰伦' : '另一位歌手',
      albumArtist: '周杰伦'
    })
  )
  for (const f of [sql, json]) {
    f.setTracks(tracks)
    f.options.searchCollectionProvider = async () => {
      throw Error('Local search must not use a provider')
    }
  }
  for (const kind of ['albums', 'artists'] as const) {
    for (const query of ['范特西', 'zjl ftx', '周杰伦', 'zjl', '!!!']) {
      for (const offset of [0, 20, 80]) {
        const actual = await sql.service.collections({
          kind,
          query,
          scope: 'local',
          limit: 20,
          offset
        })
        const expected = await json.service.collections({
          kind,
          query,
          scope: 'local',
          limit: 20,
          offset
        })
        assert.deepEqual(actual.items, expected.items, `${kind}:${query}@${offset}`)
        assert.equal(actual.total, expected.total)
        assert.equal(actual.hasMore, expected.hasMore)
      }
    }
  }
})

test('collection prefix pagination retains local-first source order and equal IDs across providers', async (t) => {
  const f = await fixture(t),
    calls: Array<[string, number, number]> = []
  const summary = (name: string) => ({ id: 'same', name, cover: '/private/cover', trackCount: 1 })
  const local = Array.from({ length: 3 }, (_, i) => summary(`Local ${i}`))
  const providers = {
    first: Array.from({ length: 2 }, (_, i) => summary(`First ${i}`)),
    second: Array.from({ length: 5 }, (_, i) => summary(`Second ${i}`))
  }
  f.options.playlists = {
    getRevision: () => 7,
    searchLocal: (_text, limit, offset) => ({
      items: local.slice(offset, offset + limit),
      total: local.length,
      revision: 7
    })
  }
  f.options.providers = () =>
    Object.keys(providers).map((id) => ({
      id,
      name: id,
      capabilities: ['search'],
      supportedMethods: ['searchPlaylists']
    }))
  f.options.searchCollectionProvider = async (id, method, query, limit, offset) => {
    assert.equal(method, 'searchPlaylists')
    assert.equal(query, 'list')
    calls.push([id, limit, offset])
    const items = providers[id as keyof typeof providers]
    return { items: items.slice(offset, offset + limit), total: items.length }
  }
  const crossing = await f.service.collections({
    kind: 'playlists',
    query: 'list',
    limit: 4,
    offset: 2
  })
  assert.deepEqual(
    crossing.items.map((item) => [item.providerId, item.name]),
    [
      ['local', 'Local 2'],
      ['first', 'First 0'],
      ['first', 'First 1'],
      ['second', 'Second 0']
    ]
  )
  assert.equal(crossing.total, 10)
  assert.equal(crossing.hasMore, true)
  assert.equal(crossing.playlistsRevision, 7)
  const tail = await f.service.collections({
    kind: 'playlists',
    query: 'list',
    limit: 4,
    offset: 7
  })
  assert.deepEqual(
    tail.items.map((item) => item.name),
    ['Second 2', 'Second 3', 'Second 4']
  )
  assert.equal(tail.hasMore, false)
  assert.ok(calls.some(([id, limit, offset]) => id === 'second' && limit === 3 && offset === 2))
  assert.ok(crossing.items.every((item) => item.cover === null))
  assert.doesNotMatch(JSON.stringify(crossing), /private|"revision"/)
  f.options.playlists.searchLocal = () => {
    throw Error('Direct provider search must not use local playlists')
  }
  const direct = await f.service.collections({
    kind: 'playlists',
    query: 'list',
    providerId: 'second',
    limit: 1,
    offset: 3
  })
  assert.equal(direct.items[0].name, 'Second 3')
  assert.equal(direct.total, 5)
})

test('collection searches report partial provider failures without hiding local errors or exposing URL diagnostics', async (t) => {
  const f = await fixture(t)
  f.setTracks([track('one')])
  f.options.providers = () => [
    { id: 'failed', name: 'Failed', capabilities: ['search'], supportedMethods: ['searchAlbums'] },
    {
      id: 'disabled',
      name: 'Disabled',
      capabilities: ['search'],
      supportedMethods: ['searchAlbums'],
      available: false
    },
    { id: 'unsupported', name: 'Unsupported', capabilities: ['search'], supportedMethods: [] }
  ]
  f.options.searchCollectionProvider = async (id) => {
    assert.equal(id, 'failed')
    throw Error('https://user:secret@host.test/path?token=secret')
  }
  const partial = await f.service.collections({ kind: 'albums', query: 'Album' })
  assert.equal(partial.items.length, 1)
  assert.match(partial.warning!, /Failed/)
  assert.doesNotMatch(JSON.stringify(partial), /secret|user:|filePath/)
  await assert.rejects(f.service.collections({ kind: 'albums', query: 'Absent' }), /Failed/)
  f.options.database.queryCollections = async () => {
    throw Error('Local database unavailable')
  }
  await assert.rejects(
    f.service.collections({ kind: 'albums', query: 'Album' }),
    /Local database unavailable/
  )
})

for (const kind of ['albums', 'playlists'] as const)
  test(`collection search rejects stale ${kind} catalog while providers wait`, async (t) => {
    const f = await fixture(t),
      entered = gate(),
      finish = gate()
    let revision = 3
    f.options.playlists = {
      getRevision: () => revision,
      searchLocal: () => ({ items: [], total: 0, revision })
    }
    f.setTracks([track('one')])
    f.options.providers = () => [
      {
        id: 'remote',
        name: 'Remote',
        capabilities: ['search'],
        supportedMethods: [kind === 'albums' ? 'searchAlbums' : 'searchPlaylists']
      }
    ]
    f.options.searchCollectionProvider = async () => {
      entered.release()
      await finish.promise
      return { items: [], total: 0 }
    }
    const search = assert.rejects(
      f.service.collections({ kind, query: 'Album' }),
      (error: { code: string }) => error.code === 'STALE_REVISION'
    )
    await entered.promise
    if (kind === 'albums') f.setTracks([track('new')])
    else revision++
    finish.release()
    await search
  })

test('collection cancellation/shutdown reaches providers and joins their actual calls', async (t) => {
  const f = await fixture(t),
    entered = gate()
  let aborted = false
  f.options.providers = () => [
    { id: 'remote', name: 'Remote', capabilities: ['search'], supportedMethods: ['searchArtists'] }
  ]
  f.options.searchCollectionProvider = async (_id, _method, _query, _limit, _offset, signal) => {
    entered.release()
    return new Promise((_resolve, reject) =>
      signal.addEventListener(
        'abort',
        () => {
          aborted = true
          reject(signal.reason)
        },
        { once: true }
      )
    )
  }
  const rejected = assert.rejects(
    f.service.collections({ kind: 'artists', query: 'Artist' }),
    /cancelled|shutting down/i
  )
  await entered.promise
  await f.service.shutdown()
  await rejected
  assert.equal(aborted, true)
})
