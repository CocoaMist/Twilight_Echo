import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { ref, shallowRef } from 'vue'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type { LibraryDatabaseApi } from '../../../../shared/libraryDatabase.ts'
import type { Track } from '../../types/music.ts'
import type { Playlist, PlaylistPersistenceNotice } from './musicStoreTypes.ts'
import type { PlaylistPersistenceStatus } from '../playlistPersistence.ts'
import { createPlaylistController } from './playlistController.ts'
import { readLibraryPlaylistTrackPresence } from './libraryPlaylistPresence.ts'

function track(id: string): Track {
  return {
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    album: 'Album',
    filePath: `D:/Music/${id}.flac`,
    fileName: `${id}.flac`,
    source: 'local',
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null
  }
}

function fixture(t: TestContext) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const records = Array.from({ length: 2500 }, (_, i) => track(String(i)))
  records.push(
    ...[1, 2].map((subTrack) => ({
      ...track(`cue:${subTrack}`),
      filePath: 'D:/Music/cue.flac',
      subTrack: String(subTrack),
      cueRange: { startSeconds: (subTrack - 1) * 30, endSeconds: subTrack * 30, pregapSeconds: 0 }
    }))
  )
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: records })
  let active = 0,
    maximumActive = 0,
    maximumRecords = 0
  const requests: string[][] = []
  const api: Pick<LibraryDatabaseApi, 'getTracksByIds' | 'getMetadata'> = {
    getTracksByIds: async (ids, revision) => {
      active++
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      try {
        requests.push(ids)
        const page = db.getTracksByIds(ids, revision)
        maximumRecords = Math.max(maximumRecords, page.tracks.length)
        return page
      } finally {
        active--
      }
    },
    getMetadata: async () => db.getMetadata()
  }
  return {
    db,
    api,
    requests,
    get maximumActive() {
      return maximumActive
    },
    get maximumRecords() {
      return maximumRecords
    }
  }
}

function controllerFixture(
  t: TestContext,
  readTrackPresence: Parameters<typeof createPlaylistController>[0]['readTrackPresence'],
  loaded: Track[] = [],
  findRelocationsInFolder?: Parameters<
    typeof createPlaylistController
  >[0]['findRelocationsInFolder']
) {
  t.mock.method(globalThis, 'setTimeout', (() => 0) as unknown as typeof setTimeout)
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api: { data: { savePlaylists: async () => {} } } }
  })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const playlists = shallowRef<Playlist[]>([])
  const persistence = ref<PlaylistPersistenceStatus>({
    state: 'idle',
    dirty: false,
    failureCount: 0,
    lastError: null
  })
  const controller = createPlaylistController({
    playlists,
    tracks: shallowRef(loaded),
    trackById: new Map(loaded.map((item) => [item.id, item])),
    getTracksRevision: () => 0,
    playlistPersistenceStatus: persistence,
    playlistPersistenceNotice: ref<PlaylistPersistenceNotice | null>(null),
    readTrackPresence,
    findRelocationsInFolder
  })
  playlists.value = [
    {
      id: 'favorites',
      name: '我收藏的音乐',
      isDefault: true,
      createdAt: '2026-01-01',
      trackIds: ['0', 'missing', 'remote:1'],
      trackSnapshots: {
        '0': track('0'),
        missing: track('missing'),
        'remote:1': { ...track('remote:1'), source: 'ncm' }
      }
    }
  ]
  return { controller, playlists, persistence }
}

const moved = { ...track('missing'), id: 'relocated', filePath: 'E:/Moved/missing.flac' }

test('membership reads complete deep IDs and CUE identities in one 200-record window at a time', async (t) => {
  const f = fixture(t),
    ids = [
      ...Array.from({ length: 405 }, (_, i) => String(i)),
      '2499',
      'cue:1',
      'cue:2',
      '0',
      'missing'
    ]
  const present = await readLibraryPlaylistTrackPresence(ids, f.api)
  assert.deepEqual(
    [...present],
    [...new Set(ids)].filter((id) => id !== 'missing')
  )
  assert.deepEqual(
    f.requests.map((ids) => ids.length),
    [200, 200, 9]
  )
  assert.equal(f.maximumActive, 1)
  assert.equal(f.maximumRecords, 200)
  assert.ok([...present].every((id) => typeof id === 'string'))
  f.requests.length = 0
  assert.deepEqual([...(await readLibraryPlaylistTrackPresence([], f.api))], [])
  assert.equal(f.requests.length, 0)
})

for (const phase of ['between-batches', 'final-check', 'mismatched-response'] as const)
  test(`membership fails without repairing any entries when the library changes at ${phase}`, async (t) => {
    const f = fixture(t)
    const mutate = () =>
      f.db.patchTracks([{ id: '0', expectedVersion: 1, patch: { title: 'Edit' } }])
    if (phase === 'final-check')
      f.api.getMetadata = async () => {
        mutate()
        return f.db.getMetadata()
      }
    else {
      const read = f.api.getTracksByIds
      f.api.getTracksByIds = async (...args) => {
        const page = await read(...args)
        if (f.requests.length === 1) mutate()
        return phase === 'mismatched-response' ? { ...page, revision: page.revision + 1 } : page
      }
    }
    const { controller, playlists, persistence } = controllerFixture(t, (ids) =>
      readLibraryPlaylistTrackPresence(ids, f.api)
    )
    playlists.value[0].trackIds = [...Array.from({ length: 405 }, (_, i) => String(i)), 'missing']
    const before = structuredClone(playlists.value)
    await assert.rejects(
      controller.repairPlaylistMissingTracksAsync('favorites', [moved]),
      /发生变化/
    )
    assert.deepEqual(playlists.value, before)
    assert.equal(persistence.value.dirty, false)
  })

test('malformed membership results are errors, not successful missing-file checks', async (t) => {
  const f = fixture(t),
    read = f.api.getTracksByIds
  for (const bad of ['unrequested', 'duplicate']) {
    f.api.getTracksByIds = async (...args) => {
      const page = await read(...args)
      return {
        ...page,
        tracks: bad === 'unrequested' ? [{ ...track('wrong') }] : [...page.tracks, ...page.tracks]
      }
    }
    await assert.rejects(readLibraryPlaylistTrackPresence(['0'], f.api), /无效/)
  }
})

test('authoritative repair protects unloaded favorites and CUE, preserves remote entries and slims replacement snapshots', async (t) => {
  const f = fixture(t)
  const { controller, playlists } = controllerFixture(t, (ids) =>
    readLibraryPlaylistTrackPresence(ids, f.api)
  )
  playlists.value[0].trackIds.push('cue:2')
  playlists.value[0].trackSnapshots!['cue:2'] = { ...track('cue:2'), subTrack: '2' }
  const candidates: Track[] = [
    { ...track('0'), id: 'wrong-replacement', filePath: 'E:/Moved/0.flac' },
    { ...moved, lyrics: 'large lyrics', translatedLyrics: 'large translation' }
  ]
  const result = await controller.repairPlaylistMissingTracksAsync('favorites', candidates)
  assert.deepEqual(
    result.relocations.map((item) => item.trackId),
    ['missing']
  )
  assert.deepEqual(playlists.value[0].trackIds, ['0', 'relocated', 'remote:1', 'cue:2'])
  assert.equal(playlists.value[0].trackSnapshots!.relocated.lyrics, null)
  assert.equal('translatedLyrics' in playlists.value[0].trackSnapshots!.relocated, false)
  assert.equal('missing' in playlists.value[0].trackSnapshots!, false)
  await controller.flushPlaylists()
})

test('concurrent additions, removals and order survive asynchronous repair without re-adding deleted entries', async (t) => {
  let release!: (present: Set<string>) => void
  const { controller, playlists } = controllerFixture(
    t,
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const pending = controller.repairPlaylistMissingTracksAsync('favorites', [moved])
  controller.addTracksToPlaylist('我收藏的音乐', [track('new')])
  controller.reorderPlaylistTracks('我收藏的音乐', ['new'], 0)
  controller.removeFromPlaylist('我收藏的音乐', '0')
  release(new Set(['0']))
  await pending
  assert.deepEqual(playlists.value[0].trackIds, ['new', 'relocated', 'remote:1'])
  const removed = controller.repairPlaylistMissingTracksAsync('favorites', [track('new')])
  controller.removeFromPlaylist('我收藏的音乐', 'new')
  release(new Set())
  const result = await removed
  assert.equal(result.relocations.length, 0)
  assert.deepEqual(playlists.value[0].trackIds, ['relocated', 'remote:1'])
  await controller.flushPlaylists()
})

for (const action of ['rename', 'replace', 'snapshot', 'failure'] as const)
  test(`async repair rejects ${action} without applying a stale replacement`, async (t) => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { controller, playlists } = controllerFixture(t, async () => {
      await held
      if (action === 'failure') throw new Error('database offline')
      return new Set(['0'])
    })
    const pending = controller.repairPlaylistMissingTracksAsync('favorites', [moved])
    if (action === 'rename') playlists.value[0].name = 'Renamed'
    if (action === 'replace') playlists.value = [{ ...playlists.value[0], id: 'another' }]
    if (action === 'snapshot')
      playlists.value[0].trackSnapshots = {
        ...playlists.value[0].trackSnapshots,
        missing: { ...track('missing'), title: 'Changed' }
      }
    const before = structuredClone(playlists.value)
    release()
    await assert.rejects(pending, /重命名或删除|发生变化|database offline/)
    assert.deepEqual(playlists.value, before)
  })

test('explicit JSON mode and the old synchronous command retain complete-library repair semantics', async (t) => {
  const { controller, playlists } = controllerFixture(t, async () => null, [track('0')])
  const result = await controller.repairPlaylistMissingTracksAsync('favorites', [moved])
  assert.deepEqual(
    result.relocations.map((item) => item.trackId),
    ['missing']
  )
  assert.deepEqual(playlists.value[0].trackIds, ['0', 'relocated', 'remote:1'])
  assert.equal(controller.repairPlaylistMissingTracks('不存在的歌单', []).relocations.length, 0)
  await controller.flushPlaylists()
})

for (const cause of ['restored', 'snapshot', 'renamed', 'removed', 'failure'] as const)
  test(`folder repair rechecks library membership and playlist state after a long scan: ${cause}`, async (t) => {
    const f = fixture(t)
    let finish!: () => void, started!: () => void
    const held = new Promise<void>((resolve) => {
        finish = resolve
      }),
      scanning = new Promise<void>((resolve) => {
        started = resolve
      })
    const { controller, playlists } = controllerFixture(
      t,
      (ids) => readLibraryPlaylistTrackPresence(ids, f.api),
      [],
      async (missing, folder) => {
        assert.equal(folder, 'E:/Moved')
        assert.deepEqual(
          missing.map((item) => item.id),
          ['missing']
        )
        started()
        await held
        if (cause === 'failure') throw new Error('candidate scan failed')
        return {
          relocations: [
            { trackId: 'missing', fromPath: track('missing').filePath, toTrack: moved }
          ],
          unresolvedTrackIds: [],
          ambiguousTrackIds: []
        }
      }
    )
    const pending = controller.repairPlaylistMissingTracksAsync('favorites', 'E:/Moved')
    await scanning
    if (cause === 'restored')
      f.db.replaceDocument({
        version: 2,
        revision: 0,
        tracks: [track('0'), track('missing')],
        folders: [],
        exclusions: []
      })
    if (cause === 'snapshot') playlists.value[0].trackSnapshots!.missing.title = 'Edited in place'
    if (cause === 'renamed') playlists.value[0].name = 'Renamed'
    if (cause === 'removed') controller.removeFromPlaylist('我收藏的音乐', 'missing')
    const before = structuredClone(playlists.value)
    finish()
    if (cause === 'removed') {
      const result = await pending
      assert.equal(result.relocations.length, 0)
      assert.deepEqual(playlists.value[0].trackIds, ['0', 'remote:1'])
    } else await assert.rejects(pending, /发生变化|重命名或删除|candidate scan failed/)
    assert.deepEqual(playlists.value, before)
    await controller.flushPlaylists()
  })
