import assert from 'node:assert/strict'
import test from 'node:test'
import { artistSearchKey, createArtistSearch } from './artistSearch.ts'

test('JSON compatibility artist search preserves local-name matching, origin identity and cross-source pagination', async () => {
  const local = Array.from({ length: 35 }, (_, i) => ({
    name: `歌手 ${i}`,
    cover: null,
    trackCount: i + 1
  }))
  const remote = Array.from({ length: 40 }, (_, i) => ({
    id: local[i % 35].name,
    name: `歌手 ${i}`,
    picUrl: null
  }))
  const calls: Array<[number, number]> = []
  const search = createArtistSearch({
    localArtists: () => local,
    providers: () => [{ id: 'remote', name: 'Remote', supportedMethods: ['searchArtists'] }],
    searchProvider: async (_id, _query, limit, offset) => {
      calls.push([limit, offset])
      return { items: remote.slice(offset, offset + limit), total: 40 }
    },
    reportError: (message) => assert.fail(message)
  })
  const pages = await Promise.all(
    [0, 30, 60].map((offset) => search.searchArtists('歌手', 30, offset))
  )
  assert.ok(pages.every((page) => page.total === 75 && page.artists.length <= 30))
  const all = pages.flatMap((page) => page.artists)
  assert.equal(all.length, 75)
  assert.ok(all.slice(0, 35).every((item) => item.providerId === 'local'))
  assert.ok(all.slice(35).every((item) => item.providerId === 'remote'))
  assert.notEqual(artistSearchKey(all[0]), artistSearchKey(all[35]))
  assert.ok(calls.some(([limit, offset]) => limit === 15 && offset === 25))
  assert.equal((await search.searchLocalArtists('gs')).total, 0)
  assert.equal((await search.searchLocalArtists('!!!')).total, 0)
})

test('disabled providers are not called and partial online failure retains authoritative local artist results', async () => {
  let available = true,
    calls = 0
  const warnings: string[] = []
  const search = createArtistSearch({
    localArtists: () => [{ name: 'Singer', cover: null, trackCount: 1 }],
    providers: () => [
      { id: 'remote', name: 'Remote', supportedMethods: ['searchArtists'], health: { available } }
    ],
    searchProvider: async () => {
      calls++
      throw new Error('offline')
    },
    reportError: (message) => warnings.push(message)
  })
  assert.equal((await search.searchArtists('Singer')).artists[0].providerId, 'local')
  assert.match(warnings[0], /Remote.*offline/)
  await assert.rejects(search.searchArtists('missing'), /offline/)
  available = false
  const before = calls
  assert.equal((await search.searchArtists('Singer')).total, 1)
  assert.equal(calls, before)
  await assert.rejects(search.searchProviderArtists('remote', 'Singer'), /不可用/)
})
