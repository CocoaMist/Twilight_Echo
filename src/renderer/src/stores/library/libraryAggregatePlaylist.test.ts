import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { reactive, watch } from 'vue'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type {
  LibraryPage,
  LibraryQuery,
  LibraryTrackRecord
} from '../../../../shared/libraryDatabase.ts'
import { createLibraryAggregatePlaylist } from './libraryAggregatePlaylist.ts'
import { libraryTrack } from '../../utils/libraryQueuePlayback.ts'
import type { Playlist } from './musicStoreTypes.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
async function until(check: () => boolean) {
  for (let i = 0; i < 150 && !check(); i++) await tick()
  assert.ok(check(), 'aggregate owner did not settle')
}
const record = (id: string, patch: Record<string, unknown> = {}): LibraryTrackRecord => ({
  id,
  filePath: `D:/Music/${id}.flac`,
  title: id,
  artist: 'Artist',
  album: 'Album',
  duration: 180,
  format: 'flac',
  source: 'local',
  ...patch
})
function fixture(t: TestContext, records: LibraryTrackRecord[], playlist: Playlist) {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({ version: 2, revision: 0, tracks: records, folders: [], exclusions: [] })
  let active = 0,
    maximum = 0
  let intercept: ((query: LibraryQuery, page: LibraryPage) => Promise<void>) | undefined
  let metadataHook: (() => Promise<void>) | undefined
  const calls: LibraryQuery[] = []
  const owner = createLibraryAggregatePlaylist({
    syncPlaylistView: async (request) => db.syncPlaylistView(request),
    queryTracks: async (query = {}) => {
      calls.push(query)
      active++
      maximum = Math.max(maximum, active)
      try {
        const result = db.queryTracks(query)
        await intercept?.(query, result)
        return result
      } finally {
        active--
      }
    },
    queryCollections: async (kind, query) => {
      active++
      maximum = Math.max(maximum, active)
      try {
        return db.queryCollections(kind, query)
      } finally {
        active--
      }
    },
    getMetadata: async () => {
      await metadataHook?.()
      return db.getMetadata()
    }
  })
  const stop = watch(
    [() => owner.detailState.value.id, () => owner.catalogState.value.id],
    owner.refreshQueries,
    { flush: 'sync' }
  )
  const input = {
    enabled: true,
    playlist,
    playlists: [playlist],
    search: '',
    revision: 1,
    versions: []
  }
  owner.setInput(input)
  t.after(async () => {
    stop()
    owner.dispose()
    await until(() => active === 0 && owner.readState.active === 0)
    db.close()
  })
  return {
    db,
    owner,
    input,
    calls,
    until,
    intercept(value: typeof intercept) {
      intercept = value
    },
    metadataHook(value: typeof metadataHook) {
      metadataHook = value
    },
    get maximum() {
      return maximum
    }
  }
}

test('aggregate renderer owns authoritative pages, full queues and visible variant preferences without a full Track array', async (t) => {
  const local = Array.from({ length: 405 }, (_, i) => record(`local${i}`, { title: `Song ${i}` })),
    remote = local.map((item, i) =>
      libraryTrack(record(`ncm:${i}`, { title: item.title, source: 'ncm', ncmSongId: i }))
    )
  const playlist = reactive<Playlist>({
    id: 'mix',
    name: 'Mix',
    kind: 'aggregate',
    createdAt: '',
    trackIds: local.flatMap((item, i) => [remote[i].id, item.id]),
    trackSnapshots: Object.fromEntries(remote.map((track) => [track.id, track])),
    hiddenSources: [],
    variantPreferences: { local0: 'ncm' }
  })
  const f = fixture(t, local, playlist),
    { owner, db } = f
  await until(() => !owner.busy.value && !!owner.pageState.value.page)
  assert.equal(owner.error.value, '')
  assert.equal(owner.pageState.value.total, 405)
  assert.equal(owner.pageState.value.page!.tracks.length, 200)
  assert.equal(owner.pageState.value.page!.tracks[0].id, 'ncm:0')
  const first = owner.pageState.value.page!.tracks[0] as unknown as ReturnType<typeof libraryTrack>
  assert.ok(owner.rowFor(reactive(first)))
  owner.openVariants(first)
  await until(() => !!owner.variantState.value.page)
  assert.equal(owner.variantState.value.total, 2)
  owner.goToPage(2)
  await until(() => !owner.busy.value && !!owner.pageState.value.page)
  assert.equal(owner.pageState.value.page!.tracks.length, 5)
  assert.equal(owner.rowFor(first), null, 'a delayed row action cannot act on another page')
  const chosen = owner.pageState.value.page!.tracks[2] as unknown as ReturnType<typeof libraryTrack>
  const query = owner.playbackQuery(chosen)!
  const queue = db.createLibraryQueue(query, chosen.id)
  assert.equal(queue.total, 405)
  assert.equal(queue.index, 402)
  assert.equal(owner.playbackQuery(first), null)
  assert.ok(f.maximum <= 2)
  await until(() => !!owner.sourceState.value.page)
  assert.deepEqual(
    owner.sourceState.value.page!.aggregate!.sources!.map((item) => item.source),
    ['local', 'ncm']
  )
  owner.setInput({ ...f.input, search: 'Song 404' })
  await until(() => !owner.busy.value && !!owner.pageState.value.page)
  assert.equal(owner.pageState.value.total, 1)
  assert.equal(owner.playbackQuery()!.search, 'Song 404')
})

test('aggregate renderer keeps ten detail pages total, including the variants menu', async (t) => {
  const records = Array.from({ length: 2205 }, (_, i) => record(`local${i}`)),
    playlist: Playlist = {
      id: 'mix',
      name: 'Mix',
      createdAt: '',
      trackIds: records.map((item) => item.id)
    }
  const { owner } = fixture(t, records, playlist)
  await until(() => !!owner.pageState.value.page)
  for (let page = 0; page < 12; page++) {
    owner.goToPage(page)
    await until(() => !!owner.pageState.value.page && !owner.busy.value)
  }
  const track = owner.pageState.value.page!.tracks[0] as unknown as ReturnType<typeof libraryTrack>
  owner.openVariants(track)
  await until(() => !!owner.variantState.value.page)
  assert.equal(owner.readState.cachedDetailPages, 10)
  assert.ok(owner.readState.cachedTracks <= 2000)
})

test('continuous aggregate actions use each loaded page identity, including a secondary-page recording', async (t) => {
  const records = Array.from({ length: 605 }, (_, i) => record(`local${i}`))
  const playlist: Playlist = {
    id: 'mix',
    name: 'Mix',
    createdAt: '',
    trackIds: ['missing', ...records.map((item) => item.id)]
  }
  const { owner, db } = fixture(t, records, playlist)
  await until(() => !owner.busy.value && !!owner.pageState.value.page)
  owner.setRange(194, 216)
  await until(() => !owner.busy.value)
  assert.equal(owner.pages.value.length, 2)
  const track = owner.trackAt(215)! as unknown as ReturnType<typeof libraryTrack>
  assert.equal(owner.rowFor(track)?.page.offset, 200)
  assert.equal(owner.rowFor(track)?.entryId, '216')
  const query = owner.playbackQuery(track)!
  assert.equal(query.playlistEntryId, '216')
  assert.equal(db.createLibraryQueue(query, track.id).index, 215)
  owner.openVariants(track)
  await until(() => !owner.variantState.value.loading && !!owner.variantState.value.page)
  assert.equal(owner.variantState.value.page!.tracks[0].id, 'local215')
  assert.deepEqual((await owner.removalIds(track))?.ids, ['local215'])
  owner.setRange(400, 420)
  assert.equal(owner.menu.value, null)
  assert.equal(owner.rowFor(track), null)
})

test('lease refresh preserves a deep continuous viewport and failed pages keep its total until explicit retry', async (t) => {
  const records = Array.from({ length: 605 }, (_, i) => record(`local${i}`))
  const playlist: Playlist = {
    id: 'mix',
    name: 'Mix',
    createdAt: '',
    trackIds: records.map((item) => item.id)
  }
  const f = fixture(t, records, playlist),
    { owner } = f
  await until(() => !owner.busy.value && !!owner.pageState.value.page)
  owner.setRange(397, 419)
  await until(() => !owner.busy.value)
  const previous = owner.detailState.value.id
  const release: Array<() => void> = []
  f.intercept(async (query) => {
    if (!query.aggregate?.sourceCounts) await new Promise<void>((resolve) => release.push(resolve))
  })
  owner.setInput({ ...f.input, revision: 2 })
  await until(() => release.length > 0)
  assert.notEqual(owner.detailState.value.id, previous)
  assert.equal(owner.pageState.value.total, 605)
  assert.equal(owner.trackAt(410), undefined)
  assert.equal(owner.pageState.value.requestedPage, 1)
  f.intercept(undefined)
  release.forEach((resolve) => resolve())
  await until(() => !owner.busy.value)
  assert.equal(owner.trackAt(410)?.id, 'local410')
  f.intercept(async (query) => {
    if (query.offset === 0 && !query.aggregate?.sourceCounts) throw new Error('disk unavailable')
  })
  owner.setRange(0, 20)
  await until(() => !owner.busy.value)
  assert.equal(owner.pageState.value.total, 605)
  assert.match(owner.error.value, /disk unavailable/)
  const count = f.calls.length
  for (let i = 0; i < 10; i++) owner.setRange(i, 20 + i)
  await tick()
  assert.equal(f.calls.length, count)
  f.intercept(undefined)
  owner.retry()
  await until(() => !owner.busy.value)
  assert.equal(owner.trackAt(10)?.id, 'local10')
})

test('aggregate catalogs continuously expose bounded summaries, configured order and full counts', async (t) => {
  const records = Array.from({ length: 2205 }, (_, i) => record(`local${i}`))
  const playlists: Playlist[] = records.map((track, i) => ({
    id: `list${i}`,
    name: `List ${i}`,
    createdAt: '',
    trackIds: [track.id]
  }))
  const f = fixture(t, records, playlists[0]),
    { owner } = f
  owner.setInput({ ...f.input, playlist: null, playlists: playlists.toReversed() })
  await until(() => !owner.busy.value && !!owner.cardState.value.page)
  assert.equal(owner.cardState.value.total, 2205)
  for (let i = 1; i < 12; i++) {
    owner.setCardRange(i * 200 - 4, Math.min(2205, i * 200 + 18))
    await until(() => !owner.busy.value)
    assert.equal(owner.cardAt(i * 200)?.id, `list${2204 - i * 200}`)
    assert.ok(owner.cardPages.value.length <= 2)
  }
  assert.equal(owner.readState.cachedCollectionPages, 10)
  assert.ok(owner.readState.cachedSummaries <= 2000)
  assert.equal(owner.cardAt(0), undefined)
  assert.ok(f.maximum <= 2)
})

test('removing one aggregate row reads all sources by occurrence and maps relinked IDs back to configuration', async (t) => {
  const records = Array.from({ length: 605 }, (_, i) => record(`local${i}`, { title: 'Same' })),
    remote = libraryTrack(record('remote:7', { title: 'Same', source: 'remote' })),
    old = libraryTrack(record('old', { ...records[0], id: 'old' })),
    playlist: Playlist = {
      id: 'mix',
      name: 'Mix',
      createdAt: '',
      trackIds: ['missing', 'old', ...records.slice(1).map((item) => item.id), 'remote:7'],
      trackSnapshots: { old, 'remote:7': remote },
      hiddenSources: ['remote']
    }
  const { owner } = fixture(t, records, playlist)
  await until(() => !!owner.pageState.value.page)
  const track = owner.pageState.value.page!.tracks[0] as unknown as ReturnType<typeof libraryTrack>
  assert.equal(owner.pageState.value.total, 1)
  const removed = await owner.removalIds(track)
  assert.equal(removed!.ids.length, 606)
  assert.ok(removed!.ids.includes('old'))
  assert.ok(removed!.ids.includes('remote:7'), 'hidden variants must be removed too')
  assert.equal(removed!.ids.includes('local0'), false)
  assert.equal(removed!.ids.includes('missing'), false)
  assert.equal(owner.action.value.pending, false)
})

test('removal refuses a changed library or configuration and stale errors cannot replace the next playlist state', async (t) => {
  const playlist: Playlist = { id: 'mix', name: 'Mix', createdAt: '', trackIds: ['one'] }
  const f = fixture(t, [record('one')], playlist),
    { owner, db } = f
  await until(() => !!owner.pageState.value.page)
  const track = owner.pageState.value.page!.tracks[0] as unknown as ReturnType<typeof libraryTrack>
  f.metadataHook(async () => {
    db.patchTracks([{ id: 'one', expectedVersion: 1, patch: { title: 'Changed' } }])
  })
  assert.equal(await owner.removalIds(track), null)
  assert.match(owner.action.value.error, /变化/)
  f.metadataHook(undefined)
  owner.invalidate()
  await until(() => !!owner.pageState.value.page)
  let unblock!: () => void
  f.intercept(async (query) => {
    if (query.aggregate?.variantRow !== undefined)
      await new Promise<void>((resolve) => {
        unblock = resolve
      })
  })
  const removal = owner.removalIds(
    owner.pageState.value.page!.tracks[0] as unknown as ReturnType<typeof libraryTrack>
  )
  await until(() => !!unblock)
  owner.setInput({ ...f.input, playlist: { ...playlist, id: 'next' } })
  unblock()
  assert.equal(await removal, null)
  await until(() => !!owner.pageState.value.page && !owner.busy.value)
  assert.equal(owner.action.value.error, '')
})

test('late reads share the global two-RPC bound, do not overwrite newer searches, and inactive owners release views', async (t) => {
  const records = [record('one'), record('two')],
    playlist: Playlist = { id: 'mix', name: 'Mix', createdAt: '', trackIds: ['one', 'two'] }
  const f = fixture(t, records, playlist),
    { owner } = f
  await until(() => !!owner.pageState.value.page && !!owner.sourceState.value.page)
  const releases: Array<() => void> = []
  f.intercept(async () => {
    await new Promise<void>((resolve) => releases.push(resolve))
  })
  owner.invalidate()
  await until(() => releases.length === 2)
  const before = f.calls.length
  for (let i = 0; i < 20; i++) owner.setInput({ ...f.input, search: i % 2 ? 'one' : 'two' })
  assert.equal(f.calls.length, before, 'new read owners cannot bypass old RPCs')
  assert.ok(owner.readState.waiting <= 5)
  f.intercept(undefined)
  for (const release of releases) release()
  await until(() => !!owner.pageState.value.page && !owner.busy.value)
  assert.deepEqual(
    owner.pageState.value.page!.tracks.map((item) => item.id),
    ['one']
  )
  assert.ok(f.maximum <= 2)
  owner.setInput({ ...f.input, enabled: false })
  await until(
    () =>
      owner.detailState.value.id === null &&
      owner.catalogState.value.id === null &&
      owner.readState.active === 0
  )
  assert.equal(owner.playbackQuery(), null)
  assert.equal(owner.pageState.value.page, null)
})

test('worker-private view expiration rebuilds the current input, but genuine content fences remain visible', async (t) => {
  const playlist: Playlist = { id: 'mix', name: 'Mix', createdAt: '', trackIds: ['one'] }
  const { owner, db } = fixture(t, [record('one')], playlist)
  await until(() => !!owner.pageState.value.page)
  const previous = owner.detailState.value.id!
  db.syncPlaylistView({ kind: 'drop', id: previous })
  owner.invalidate()
  await until(
    () =>
      !!owner.pageState.value.page && !owner.busy.value && owner.detailState.value.id !== previous
  )
  assert.equal(owner.error.value, '')
  owner.recoverPlayback(owner.detailState.value.id!, new Error('曲库在读取期间发生变化，请重试'))
  assert.equal(owner.error.value, '')
  assert.equal(owner.action.value.error, '')
  owner.setInput({
    ...{
      enabled: true,
      playlist: null,
      playlists: [playlist],
      search: '',
      revision: 1,
      versions: []
    }
  })
  await until(() => !!owner.cardState.value.page && !owner.busy.value)
  assert.equal(owner.cardState.value.total, 1)
  assert.equal(owner.detailState.value.id, null)
  assert.equal('trackIds' in owner.cardState.value.page!.items[0], false)
})

test('a scan invalidation during removal releases action state after the delayed read finishes', async (t) => {
  const f = fixture(t, [record('one')], {
      id: 'mix',
      name: 'Mix',
      createdAt: '',
      trackIds: ['one']
    }),
    { owner } = f
  await until(() => !!owner.pageState.value.page)
  let unblock!: () => void
  f.intercept(async (query) => {
    if (query.aggregate?.variantRow !== undefined)
      await new Promise<void>((resolve) => {
        unblock = resolve
      })
  })
  const removal = owner.removalIds(
    owner.pageState.value.page!.tracks[0] as unknown as ReturnType<typeof libraryTrack>
  )
  await until(() => !!unblock)
  owner.invalidate()
  unblock()
  assert.equal(await removal, null)
  assert.equal(owner.action.value.pending, false)
  assert.equal(owner.action.value.error, '')
})
