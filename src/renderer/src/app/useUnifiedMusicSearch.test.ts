import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '../types/music'
import type { UnifiedSearchResult } from '../utils/unifiedMusicSearch.ts'

const { createUnifiedMusicSearch } = (await import(
  new URL('./useUnifiedMusicSearch.ts', import.meta.url).href
)) as typeof import('./useUnifiedMusicSearch.ts')

const localTrack: Track = {
  id: 'local:1',
  title: 'Moon River',
  artist: 'Audrey',
  album: 'Album',
  filePath: 'D:\\Music\\Moon River.flac',
  fileName: 'Moon River.flac',
  duration: 181,
  size: 1,
  cover: null,
  lyrics: null,
  source: 'local',
  format: 'flac'
}

function unifiedResult(track: Track): UnifiedSearchResult {
  return {
    items: [
      {
        kind: 'track' as const,
        track,
        source: 'local',
        sourceName: 'local',
        local: true,
        lossless: true,
        providerAvailable: true,
        providerReliability: 1
      }
    ],
    logicalItems: [
      {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        preferredTrack: track,
        variants: [
          {
            track,
            source: 'local',
            sourceName: 'local',
            local: true,
            lossless: true,
            providerAvailable: true,
            providerReliability: 1
          }
        ]
      }
    ],
    health: {},
    total: 1
  }
}

test('unified music search composable exposes unified items and provider health', async () => {
  const search = createUnifiedMusicSearch({
    getLocalTracks: () => [localTrack],
    searchAllSongs: async ({ localTracks }): Promise<UnifiedSearchResult> => ({
      items: localTracks.map((track) => ({
        kind: 'track' as const,
        track,
        source: 'local',
        sourceName: '本地音乐',
        local: true,
        lossless: true,
        providerAvailable: true,
        providerReliability: 1
      })),
      logicalItems: [
        {
          id: 'moon river::audrey',
          title: 'Moon River',
          artist: 'Audrey',
          album: 'Album',
          preferredTrack: localTrack,
          variants: [
            {
              track: localTrack,
              source: 'local',
              sourceName: '本地音乐',
              local: true,
              lossless: true,
              providerAvailable: true,
              providerReliability: 1
            }
          ]
        }
      ],
      health: {
        ncm: {
          providerId: 'ncm',
          providerName: 'NetEase',
          available: false,
          searchable: true,
          resultCount: 0,
          lastError: 'login expired',
          pluginStatus: null,
          successRate: null,
          playbackUrlSuccessRate: null,
          playbackUrlLastError: null,
          lastCheckedAt: null
        }
      },
      total: 1
    })
  })

  await search.search('moon')

  assert.equal(search.loading.value, false)
  assert.equal(search.error.value, '')
  assert.deepEqual(
    search.items.value.map((item) => item.track.id),
    ['local:1']
  )
  assert.equal(search.logicalItems.value[0].preferredTrack.id, 'local:1')
  assert.equal(search.providerHealth.value.ncm.available, false)
  assert.equal(search.providerHealth.value.ncm.lastError, 'login expired')
})

test('unified music search clears state for blank queries', async () => {
  let called = false
  const search = createUnifiedMusicSearch({
    getLocalTracks: () => [localTrack],
    searchAllSongs: async () => {
      called = true
      return { items: [], logicalItems: [], health: {}, total: 0 }
    }
  })

  await search.search('   ')

  assert.equal(called, false)
  assert.equal(search.loading.value, false)
  assert.equal(search.items.value.length, 0)
  assert.equal(search.logicalItems.value.length, 0)
  assert.deepEqual(search.providerHealth.value, {})
})

test('a late unified search page cannot overwrite a newer request with the same query', async () => {
  let resolveFirst!: () => void
  let resolveSecond!: () => void
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve
  })
  const second = new Promise<void>((resolve) => {
    resolveSecond = resolve
  })
  const pageZero = { ...localTrack, id: 'local:page-0', title: 'Page zero' }
  const pageThirty = { ...localTrack, id: 'local:page-30', title: 'Page thirty' }
  const search = createUnifiedMusicSearch({
    getLocalTracks: () => [localTrack],
    searchAllSongs: async ({ offset }) => {
      if (offset === 0) {
        await first
        return unifiedResult(pageZero)
      }
      await second
      return unifiedResult(pageThirty)
    }
  })

  const oldRequest = search.search('moon', { offset: 0 })
  const newestRequest = search.search('moon', { offset: 30 })
  resolveSecond()
  await newestRequest
  resolveFirst()
  await oldRequest

  assert.deepEqual(
    search.items.value.map((item) => item.track.id),
    ['local:page-30']
  )
  assert.equal(search.loading.value, false)
})

test('clearing search aborts in-flight requests and cannot publish late results', async () => {
  let release!: () => void
  let signal: AbortSignal | undefined
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const search = createUnifiedMusicSearch({
    getLocalTracks: () => [],
    searchAllSongs: async (options) => {
      signal = options.signal
      await pending
      return unifiedResult(localTrack)
    }
  })
  const request = search.search('moon')
  assert.equal(search.loading.value, true)
  search.clear()
  assert.equal(signal?.aborted, true)
  release()
  await request
  assert.deepEqual(search.logicalItems.value, [])
  assert.equal(search.loading.value, false)
  assert.equal(search.total.value, 0)
})

test('obsolete network-library reads do not start provider searches', async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const queries: string[] = []
  const search = createUnifiedMusicSearch({
    getLocalTracks: () => [],
    searchNetworkLibrary: async (query) => {
      if (query === 'old') await pending
      return []
    },
    searchAllSongs: async ({ query }) => {
      queries.push(query)
      return unifiedResult(localTrack)
    }
  })
  const old = search.search('old')
  await search.search('new')
  release()
  await old
  assert.deepEqual(queries, ['new'])
  assert.equal(search.query.value, 'new')
})

test('database refreshes coalesce, retain the page, and reject responses older than the notified content revision', async () => {
  const calls: Array<{ query: string; offset?: number }> = []
  let revision = 3
  const search = createUnifiedMusicSearch({
    getLocalTracks: () =>
      assert.fail('an authoritative local source must bypass the renderer array'),
    localSource: { search: async () => ({ items: [], total: 0 }), confirm: async () => {} },
    searchAllSongs: async ({ query, offset, localTracks }) => {
      assert.equal(localTracks.length, 0)
      calls.push({ query, offset })
      return { ...unifiedResult(localTrack), libraryRevision: revision }
    }
  })
  await search.search('moon', { limit: 20, offset: 200 })
  for (let i = 0; i < 500; i++) search.invalidateLibrary(4)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, [
    { query: 'moon', offset: 200 },
    { query: 'moon', offset: 200 }
  ])
  assert.match(search.error.value, /发生变化/)
  assert.equal(search.items.value.length, 0)
  revision = 4
  search.refresh()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(search.items.value[0].track.id, localTrack.id)
  search.refresh()
  await search.search('new', { offset: 0 })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(calls.at(-1), { query: 'new', offset: 0 })
  assert.equal(calls.length, 4, 'a scheduled refresh cannot restart after a newer manual search')
  search.clear()
})
