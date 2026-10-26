import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { coreSnapshot } from '../coreTestFixtures.ts'
import { disposeCoreConnection } from '../coreConnection.ts'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type { LibraryQuery } from '../../../../shared/libraryDatabase.ts'
import { createLibraryUnifiedSearch } from './libraryUnifiedSearch.ts'
import { unifiedSearchSongs } from '../../utils/unifiedMusicSearch.ts'
import { versionSourceKey } from '../../../../shared/trackSourceIdentity.ts'
import { searchLocalStreamingSongs } from '../../components/streaming-page/localStreamingSearch.ts'

// This private compatibility-helper suite keeps its version lookup on Core too.
// Production consumers are covered separately by useUnifiedMusicSearchDatabase.
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    api: {
      core: {
        onMessage: () => () => {},
        onStatus: () => () => {},
        connect: async () => ({
          ok: true,
          value: {
            connectionId: 'legacy-search-reference',
            snapshot: coreSnapshot({ versionsRevision: 0 })
          }
        }),
        request: async () => ({ ok: true, value: { revision: 0, total: 0, offset: 0, items: [] } }),
        cancel: async () => ({ ok: true, value: undefined }),
        disconnect: async () => ({ ok: true, value: undefined })
      }
    }
  }
})
test.after(() => {
  disposeCoreConnection()
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function assertAborted(value: unknown): void {
  assert.ok(value instanceof DOMException)
  assert.equal(value.name, 'AbortError')
}
function fixture(t: TestContext) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const tracks = Array.from({ length: 610 }, (_, i) => ({
    id: `local:${i}`,
    filePath: `D:/Music/${i}.flac`,
    fileName: `${i}.flac`,
    title: `晴天 ${String(i).padStart(4, '0')}`,
    artist: '周杰伦',
    album: 'Album',
    format: 'flac',
    source: 'local' as const,
    size: 1,
    duration: 180,
    cover: null,
    lyrics: null
  }))
  db.replaceDocument({ version: 2, revision: 0, tracks, folders: [], exclusions: [] })
  let mode: 'json' | 'sqlite' = 'sqlite',
    preferenceRevision = 0,
    keys: string[] = [],
    metadataReads = 0
  const queries: LibraryQuery[] = []
  const options: Parameters<typeof createLibraryUnifiedSearch>[0] = {
    getStorageMode: async () => mode,
    getJsonTracks: () => {
      throw new Error('full renderer library access')
    },
    getPreferences: () => ({ revision: preferenceRevision, sources: keys }),
    api: {
      queryTracks: async (query: LibraryQuery = {}) => {
        queries.push(query)
        return db.queryTracks(query)
      },
      getMetadata: async () => {
        metadataReads++
        return db.getMetadata()
      }
    }
  }
  const source = createLibraryUnifiedSearch(options)
  t.after(() => source.dispose())
  return {
    db,
    tracks,
    queries,
    options,
    source,
    prefer(index: number) {
      keys = [versionSourceKey(tracks[index])]
      preferenceRevision++
    },
    json() {
      mode = 'json'
    },
    get metadataReads() {
      return metadataReads
    }
  }
}

test('deep local pages use the authoritative query and preserve complete totals, preferred ordering and the 100-record limit', async (t) => {
  const f = fixture(t)
  const page = await f.source.search('zjl', 100, 500)
  assert.equal(page.total, 610)
  assert.equal(page.items.length, 100)
  assert.equal(page.items[0].track.id, 'local:500')
  assert.equal(page.libraryRevision, f.db.getMetadata().revision)
  assert.equal(f.queries[0].sort, 'unifiedSearch')
  assert.equal(
    page.playbackQuery,
    undefined,
    'mixed-source search retains its existing queue contract'
  )
  await f.source.confirm(page)
  assert.equal(f.metadataReads, 1)
  f.prefer(609)
  assert.equal((await f.source.search('晴天', 1, 0)).items[0].track.id, 'local:609')
  assert.equal((await f.source.search('!!!', 20, 0)).total, 0)
  assert.equal(f.queries.length, 2, 'punctuation must not become an unfiltered full-library search')
  await assert.rejects(f.source.search('晴天', 101, 0), /页码/)
})

test('mode discovery and SQL failures reject rather than use a partial array; explicit JSON mode keeps the legacy path', async (t) => {
  const f = fixture(t)
  f.options.getStorageMode = async () => {
    throw new Error('discovery failed')
  }
  await assert.rejects(f.source.search('晴天', 20, 0), /discovery failed/)
  f.options.getStorageMode = async () => 'invalid' as never
  await assert.rejects(f.source.search('晴天', 20, 0), /无法确认/)
  f.options.getStorageMode = async () => 'sqlite'
  f.options.api.queryTracks = async () => {
    throw new Error('database failed')
  }
  await assert.rejects(f.source.search('晴天', 20, 0), /database failed/)
  f.options.getStorageMode = async () => 'json'
  f.options.getJsonTracks = () => f.tracks
  const json = await f.source.search('晴天', 20, 500)
  assert.equal(json.total, 610)
  assert.equal(json.items[0].track.id, 'local:500')
  await f.source.confirm(json)
  assert.equal(f.metadataReads, 0)
})

test('library edits, preference edits, stale notifications and failed confirmation all prevent publishing a mixed search', async (t) => {
  const f = fixture(t)
  const page = await f.source.search('晴天', 20, 0)
  f.prefer(609)
  await assert.rejects(f.source.confirm(page), /版本偏好/)
  const next = await f.source.search('晴天', 20, 0)
  f.db.patchTracks([{ id: 'local:0', expectedVersion: 1, patch: { title: 'Changed' } }])
  await assert.rejects(f.source.confirm(next), /发生变化/)
  const latest = await f.source.search('晴天', 20, 0)
  f.source.invalidate(latest.libraryRevision! + 1)
  await assert.rejects(f.source.confirm(latest), /已变化/)
  const other = createLibraryUnifiedSearch(f.options)
  t.after(() => other.dispose())
  const confirmation = await other.search('晴天', 20, 0)
  f.options.api.getMetadata = async () => {
    throw new Error('offline')
  }
  await assert.rejects(other.confirm(confirmation), /offline/)
})

test('two running queries retain their slots; rapid replacements keep only the newest waiting page', async (t) => {
  const f = fixture(t),
    releases: Array<() => void> = []
  const read = f.options.api.queryTracks
  f.options.api.queryTracks = async (query) => {
    await new Promise<void>((resolve) => {
      releases.push(resolve)
    })
    return read(query)
  }
  const requests = Array.from({ length: 30 }, (_, i) =>
    f.source.search('晴天', 20, i * 20).catch((error: unknown) => error)
  )
  await tick()
  assert.deepEqual(f.source.state, { active: 2, pending: 1 })
  assert.equal(releases.length, 2)
  releases[0]()
  releases[1]()
  await tick()
  assert.equal(releases.length, 3)
  releases[2]()
  const results = await Promise.all(requests)
  assert.deepEqual(
    f.queries.map((query) => query.offset),
    [0, 20, 580]
  )
  assert.equal(
    results.filter((result) => result instanceof DOMException && result.name === 'AbortError')
      .length,
    27
  )
  assert.equal(
    (results.at(-1) as Awaited<ReturnType<typeof f.source.search>>).items[0].track.id,
    'local:580'
  )
  await tick()
  assert.deepEqual(f.source.state, { active: 0, pending: 0 })
})

test('mixed search counts complete local and provider totals; a slow provider cannot publish an obsolete local page', async (t) => {
  const f = fixture(t)
  const result = await unifiedSearchSongs({
    query: '晴天',
    localTracks: [],
    localSource: f.source,
    limit: 20,
    offset: 500,
    providers: [{ id: 'remote', name: 'Remote', capabilities: ['search'] }],
    searchProviderSongs: async () => ({
      items: [{ ...f.tracks[0], id: 'remote:1', source: 'remote' }],
      total: 1000
    })
  })
  assert.equal(result.total, 1610)
  assert.equal(result.items.length, 21)
  assert.equal(result.hasMore, true)
  assert.equal(result.libraryRevision, f.db.getMetadata().revision)
  let release!: () => void, started!: () => void
  const gate = new Promise<void>((resolve) => {
      release = resolve
    }),
    ready = new Promise<void>((resolve) => {
      started = resolve
    })
  const pending = unifiedSearchSongs({
    query: '晴天',
    localTracks: [],
    localSource: f.source,
    providers: [{ id: 'remote', name: 'Remote', capabilities: ['search'] }],
    searchProviderSongs: async () => {
      started()
      await gate
      return { items: [], total: 0 }
    }
  })
  await ready
  f.db.patchTracks([
    { id: 'local:0', expectedVersion: 1, patch: { title: 'Changed during provider wait' } }
  ])
  release()
  await assert.rejects(pending, /发生变化/)
})

test('local-only search preserves insertion order and legacy metadata-only matching in SQL and explicit JSON', async (t) => {
  const f = fixture(t)
  f.prefer(609)
  for (const query of ['晴天', 'zjl', '609.flac', '!!!']) {
    const expected = searchLocalStreamingSongs(f.tracks, query, 30, 500)
    const page = await f.source.searchLocal(query, 30, 500)
    assert.equal(page.total, expected.total)
    assert.deepEqual(
      page.items.map((item) => item.track.id),
      expected.tracks.map((track) => track.id)
    )
    await f.source.confirm(page)
    if (page.items.length) {
      assert.deepEqual(page.playbackQuery, {
        search: query,
        sort: 'playlist',
        contentRevision: page.libraryRevision
      })
      const selected = page.items[0].track.id
      const queue = f.db.createLibraryQueue(page.playbackQuery!, selected)
      assert.equal(queue.total, expected.total)
      assert.equal(queue.index, 500)
    }
    f.options.getStorageMode = async () => 'json'
    f.options.getJsonTracks = () => f.tracks
    const json = await f.source.searchLocal(query, 30, 500)
    assert.equal(json.playbackQuery, undefined)
    assert.equal(json.total, expected.total)
    assert.deepEqual(
      json.items.map((item) => item.track.id),
      expected.tracks.map((track) => track.id)
    )
    f.options.getStorageMode = async () => 'sqlite'
  }
})

test('aborted running reads retain their slots, skip aborted waiting demands, and disposal prevents late publication', async (t) => {
  const f = fixture(t),
    releases: Array<() => void> = []
  const query = f.options.api.queryTracks
  f.options.api.queryTracks = async (request) => {
    await new Promise<void>((resolve) => {
      releases.push(resolve)
    })
    return query(request)
  }
  const abort = new AbortController()
  const first = f.source.search('晴天', 20, 0, abort.signal).catch((error: unknown) => error)
  const second = f.source.search('晴天', 20, 20).catch((error: unknown) => error)
  const pendingAbort = new AbortController()
  const third = f.source
    .search('晴天', 20, 40, pendingAbort.signal)
    .catch((error: unknown) => error)
  await tick()
  abort.abort()
  pendingAbort.abort()
  assert.deepEqual(f.source.state, { active: 2, pending: 1 })
  releases[0]()
  const error = await first
  assertAborted(error)
  assertAborted(await third)
  await tick()
  assert.equal(releases.length, 2, 'aborted pending operation must not start an RPC')
  const waiting = f.source.search('晴天', 20, 60).catch((error: unknown) => error)
  await tick()
  const next = f.source.search('晴天', 20, 80).catch((error: unknown) => error)
  f.source.dispose()
  assertAborted(await next)
  releases[1]()
  releases[2]()
  assertAborted(await second)
  assertAborted(await waiting)
  await assert.rejects(f.source.search('晴天', 20, 0), { name: 'AbortError' })
  await tick()
  assert.deepEqual(f.source.state, { active: 0, pending: 0 })
})
