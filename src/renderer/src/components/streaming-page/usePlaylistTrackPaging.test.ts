import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef } from 'vue'
import { usePlaylistTrackPaging } from './usePlaylistTrackPaging.ts'
import type { Track } from '../../types/music'
import type { MediaProviderPlaylistTracksPage } from '../../providers/mediaProvider.ts'

const track = (id: string) => ({ id, title: id }) as Track
const page = (
  ids: string[],
  nextOffset: number,
  hasMore = true
): MediaProviderPlaylistTracksPage => ({
  tracks: ids.map(track),
  total: null,
  nextOffset,
  hasMore
})
const setup = () => {
  const tracks = shallowRef<Track[]>([])
  return { tracks, paging: usePlaylistTrackPaging(tracks, (error) => String(error)) }
}

test('opens one page and fetches the next only when requested, using the provider cursor', async () => {
  const { tracks, paging } = setup()
  const offsets: number[] = []
  await paging.open(async (offset) => {
    offsets.push(offset)
    return page([String(offset)], offset + 20)
  })
  assert.deepEqual(offsets, [0])
  assert.equal(tracks.value.length, 1)
  await paging.loadMore()
  assert.deepEqual(offsets, [0, 20])
  assert.deepEqual(
    tracks.value.map((track) => track.id),
    ['0', '20']
  )
})

test('keeps loaded tracks on a later page failure and retries only that page', async () => {
  const { tracks, paging } = setup()
  let fail = true
  const offsets: number[] = []
  await paging.open(async (offset) => {
    offsets.push(offset)
    if (offset && fail) throw new Error('rate limited')
    return page([String(offset)], offset + 20, offset === 0)
  })
  await paging.loadMore()
  assert.deepEqual(
    tracks.value.map((track) => track.id),
    ['0']
  )
  assert.match(paging.error.value, /rate limited/)
  assert.equal(paging.hasMore.value, true)
  fail = false
  await paging.loadMore()
  await paging.loadMore()
  assert.deepEqual(offsets, [0, 20, 20])
  assert.equal(paging.error.value, '')
  assert.equal(paging.hasMore.value, false)
})

test('merges overlapping pages without duplicate tracks, including within a page', async () => {
  const { tracks, paging } = setup()
  await paging.open(async (offset) =>
    offset ? page(['a', 'b', 'b'], 40, false) : page(['a', 'a'], 20)
  )
  await paging.loadMore()
  assert.deepEqual(
    tracks.value.map((track) => track.id),
    ['a', 'b']
  )
})

test('ignores old folder responses and errors after switching folders', async () => {
  const { tracks, paging } = setup()
  let resolveOld!: (page: MediaProviderPlaylistTracksPage) => void
  const old = paging.open(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve
      })
  )
  await paging.open(async () => page(['new'], 20, false))
  resolveOld(page(['old'], 20))
  await old
  assert.deepEqual(
    tracks.value.map((track) => track.id),
    ['new']
  )
  assert.equal(paging.loading.value, false)
  let rejectOld!: (error: Error) => void
  const pending = paging.open(
    () =>
      new Promise((_resolve, reject) => {
        rejectOld = reject
      })
  )
  paging.reset()
  rejectOld(new Error('old failure'))
  await pending
  assert.equal(paging.error.value, '')
  assert.equal(paging.active.value, false)
})

test('deduplicates concurrent load-more actions', async () => {
  const { tracks, paging } = setup()
  let calls = 0
  let resolve!: (page: MediaProviderPlaylistTracksPage) => void
  await paging.open(async () => page(['a'], 20))
  const saved = paging.snapshot()
  saved.loader = () => {
    calls++
    return new Promise((r) => {
      resolve = r
    })
  }
  paging.restore(saved)
  const pending = paging.loadMore()
  await paging.loadMore()
  assert.equal(calls, 1)
  resolve(page(['b'], 40, false))
  await pending
  assert.equal(tracks.value.length, 2)
})

test('restores the pagination cursor on back navigation without refetching', async () => {
  const { tracks, paging } = setup()
  const offsets: number[] = []
  await paging.open(async (offset) => {
    offsets.push(offset)
    return page([String(offset)], offset + 20)
  })
  const saved = paging.snapshot()
  const savedTracks = tracks.value
  await paging.open(async () => page(['different'], 20, false))
  tracks.value = savedTracks
  paging.restore(saved)
  assert.deepEqual(offsets, [0])
  await paging.loadMore()
  assert.deepEqual(offsets, [0, 20])
  assert.deepEqual(
    tracks.value.map((track) => track.id),
    ['0', '20']
  )
})

test('empty filtered pages keep the cursor usable and a nonadvancing cursor fails safely', async () => {
  const { tracks, paging } = setup()
  await paging.open(async (offset) => (offset ? page(['a'], 20) : page([], 20)))
  assert.equal(paging.hasMore.value, true)
  await paging.loadMore()
  assert.match(paging.error.value, /数据不完整/)
  assert.deepEqual(tracks.value, [])
})

test('force refresh only loads the first page and initial errors remain visible to the caller', async () => {
  const { paging } = setup()
  const args: unknown[][] = []
  await paging.open(async (...values) => {
    args.push(values)
    return page(['a'], 20)
  }, true)
  assert.deepEqual(args, [[0, true]])
  await assert.rejects(
    paging.open(async () => {
      throw new Error('first page failed')
    }),
    /first page failed/
  )
  assert.equal(paging.loading.value, false)
})
