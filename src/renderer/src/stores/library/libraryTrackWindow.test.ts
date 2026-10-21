import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type { LibraryPage, LibraryQuery } from '../../../../shared/libraryDatabase.ts'
import { createLibraryTrackWindow } from './libraryTrackWindow.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
async function settled(source: ReturnType<typeof createLibraryTrackWindow>) {
  for (let i = 0; i < 100; i++) {
    if (!source.state.value.loading) return
    await tick()
  }
  assert.fail('continuous reader did not settle')
}
function page(query: LibraryQuery = {}, revision = 1, total = 300_000): LibraryPage {
  const offset = query.offset ?? 0
  return {
    offset,
    revision,
    total,
    totalDuration: total * 180,
    tracks: Array.from({ length: Math.max(0, Math.min(200, total - offset)) }, (_, i) => ({
      id: `${query.search ?? 'song'}:${offset + i}`,
      filePath: `D:/Music/${offset + i}.flac`
    })),
    versions: {}
  }
}

test('continuous rows straddle pages and deep scrolling retains only ten detail pages and a bounded viewport', async (t) => {
  const queries: LibraryQuery[] = []
  const source = createLibraryTrackWindow({
    queryTracks: async (query) => {
      queries.push(query!)
      return page(query)
    }
  })
  t.after(() => source.dispose())
  source.setQuery({ search: 'moon', sort: 'title' })
  await settled(source)
  const selection = source.selectionEpoch.value
  source.setRange(194, 216)
  await settled(source)
  assert.equal(source.trackAt(199)?.id, 'moon:199')
  assert.equal(source.trackAt(200)?.id, 'moon:200')
  assert.equal(source.trackAt(215)?.id, 'moon:215')
  assert.equal(source.indexOfTrack(source.trackAt(215)!), 215)
  assert.equal(source.pageForTrack(source.trackAt(215)!)?.offset, 200)
  assert.equal(source.pages.value.length, 2)
  for (let i = 2; i < 22; i++) {
    source.setRange(i * 200 - 4, i * 200 + 18)
    await settled(source)
    assert.ok(source.pages.value.length <= 2)
  }
  assert.equal(source.selectionEpoch.value, selection)
  assert.equal(source.cacheState.cachedPages, 10)
  assert.equal(source.cacheState.cachedTracks, 2000)
  assert.equal(source.trackAt(0), undefined)
  assert.equal(source.state.value.total, 300_000)
  assert.ok(queries.every((query) => query.limit === 200))
  const before = queries.length
  source.setRange(4000, 4020)
  await settled(source)
  assert.equal(queries.length, before, 'revisiting cached rows must not read again')
})

test('fast scrollbar jumps queue only the latest range, sharing two slots with stale reads', async (t) => {
  const pending: {
    query: LibraryQuery
    resolve(value: LibraryPage): void
    reject(error: Error): void
  }[] = []
  const source = createLibraryTrackWindow({
    queryTracks: (query) =>
      new Promise((resolve, reject) => {
        pending.push({ query: query!, resolve, reject })
      })
  })
  t.after(() => source.dispose())
  source.setQuery({})
  source.setRange(199, 215)
  for (let i = 2; i < 100; i++) source.setRange(i * 200, i * 200 + 20)
  assert.equal(pending.length, 2)
  pending[0].resolve(page(pending[0].query))
  await tick()
  assert.equal(pending.length, 3)
  assert.equal(pending[2].query.offset, 19_800)
  assert.equal(source.trackAt(0), undefined, 'obsolete cached rows must not fill the new position')
  pending[1].reject(new Error('obsolete page failure'))
  pending[2].resolve(page(pending[2].query))
  await settled(source)
  assert.equal(source.state.value.error, '')
  assert.equal(source.trackAt(19_800)?.id, 'song:19800')
  assert.equal(source.cacheState.activeRequests, 0)
})

test('replaced queries, invalidations and disposal fence late windows without releasing live RPC slots', async () => {
  const pending: { query: LibraryQuery; resolve(value: LibraryPage): void }[] = []
  const source = createLibraryTrackWindow({
    queryTracks: (query) => new Promise((resolve) => pending.push({ query: query!, resolve }))
  })
  source.setQuery({ search: 'old' })
  source.setRange(199, 215)
  source.setQuery({ search: 'new' })
  source.setRange(4000, 4020)
  assert.equal(pending.length, 2)
  pending[0].resolve(page(pending[0].query))
  await tick()
  assert.equal(pending[2].query.search, 'new')
  assert.equal(pending[2].query.offset, 4000)
  pending[1].resolve(page(pending[1].query))
  pending[2].resolve(page(pending[2].query, 5))
  await settled(source)
  const selection = source.selectionEpoch.value
  source.invalidate(6)
  assert.ok(source.selectionEpoch.value > selection)
  assert.equal(source.pages.value.length, 0)
  pending[3].resolve(page(pending[3].query, 5))
  await settled(source)
  assert.match(source.state.value.error, /读取期间发生变化/)
  source.retry()
  const current = source.state.value
  source.dispose()
  pending[4].resolve(page(pending[4].query, 6))
  await tick()
  assert.equal(source.state.value, current)
  assert.equal(source.pages.value.length, 0)
  assert.equal(source.cacheState.cachedTracks, 0)
})

test('failed windows preserve scroll extent, require explicit retry and do not present an empty library', async (t) => {
  let fail = false,
    calls = 0
  const source = createLibraryTrackWindow({
    queryTracks: async (query) => {
      calls++
      if (fail) throw new Error('disk unavailable')
      return page(query)
    }
  })
  t.after(() => source.dispose())
  source.setQuery({})
  await settled(source)
  fail = true
  source.setRange(20_000, 20_030)
  await settled(source)
  assert.equal(source.state.value.total, 300_000)
  assert.equal(source.pages.value.length, 0)
  assert.match(source.state.value.error, /disk unavailable/)
  source.setRange(20_001, 20_031)
  await tick()
  assert.equal(calls, 2, 'scrolling inside the failed window must not spin retries')
  fail = false
  source.retry()
  await settled(source)
  assert.equal(source.trackAt(20_001)?.id, 'song:20001')
  assert.equal(source.state.value.error, '')
})

test('a library shrinking under a deep scrollbar position clamps to the new end, including empty libraries', async (t) => {
  let total = 300_000,
    revision = 1
  const source = createLibraryTrackWindow({
    queryTracks: async (query) => page(query, revision, total)
  })
  t.after(() => source.dispose())
  source.setQuery({})
  await settled(source)
  source.setRange(299_980, 300_000)
  await settled(source)
  total = 5
  revision++
  source.invalidate(revision)
  await settled(source)
  assert.equal(source.state.value.total, 5)
  assert.equal(source.trackAt(4)?.id, 'song:4')
  assert.equal(source.state.value.requestedPage, 0)
  total = 0
  revision++
  source.invalidate(revision)
  await settled(source)
  assert.equal(source.state.value.total, 0)
  assert.equal(source.state.value.loading, false)
  assert.equal(source.state.value.error, '')
})

test('error layout moving overscan across a page edge does not trigger an automatic retry loop', async (t) => {
  const queries: LibraryQuery[] = []
  const source = createLibraryTrackWindow({
    queryTracks: async (query) => {
      queries.push(query!)
      if (query?.offset === 200) throw new Error('disk unavailable')
      return page(query)
    }
  })
  t.after(() => source.dispose())
  source.setQuery({})
  await settled(source)
  source.setRange(180, 202)
  await settled(source)
  for (let i = 0; i < 10; i++) {
    source.setRange(178, 200) // Status expands; page 1 leaves the overscan.
    assert.equal(source.state.value.error, '')
    source.setRange(180, 202) // Status collapses; the same failed page returns.
    await settled(source)
    assert.match(source.state.value.error, /disk unavailable/)
  }
  assert.equal(queries.length, 2, 'only explicit retry may repeat the failed read')
  source.retry()
  await settled(source)
  assert.equal(queries.length, 4, 'explicit retry refreshes both required pages')
})

test('continuous locate uses complete SQL order and retains the absolute anchor until the viewport moves', async (t) => {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: Array.from({ length: 605 }, (_, i) => ({
      id: String(i),
      filePath: `D:/Music/${i}.flac`,
      title: `Song ${i}`,
      duration: i
    }))
  })
  const queries: LibraryQuery[] = []
  const source = createLibraryTrackWindow({
    queryTracks: async (query = {}) => {
      queries.push(query)
      return db.queryTracks(query)
    }
  })
  t.after(() => {
    source.dispose()
    db.close()
  })
  source.setQuery({ sort: 'duration', direction: 'desc' })
  await settled(source)
  source.locate('20')
  await settled(source)
  assert.equal(source.state.value.page?.anchorIndex, 584)
  assert.equal(source.trackAt(584)?.id, '20')
  await tick()
  assert.equal(source.state.value.page?.anchorIndex, 584)
  source.setRange(573, 599)
  await settled(source)
  assert.equal(source.state.value.page?.anchorIndex, undefined)
  assert.equal(queries.length, 2)
  source.locate('absent')
  await settled(source)
  assert.equal(source.state.value.page?.anchorIndex, -1)
  assert.equal(source.state.value.page?.offset, 400)
  assert.match(source.state.value.error, /不在此查询/)
  source.setQuery(null)
  await tick()
  assert.equal(source.state.value.loading, false)
  assert.equal(source.state.value.total, null)
})
