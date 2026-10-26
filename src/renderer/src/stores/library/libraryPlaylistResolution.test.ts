import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { ref, shallowRef } from 'vue'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type { LibraryDatabaseApi } from '../../../../shared/libraryDatabase.ts'
import { createLogicalTrackModel } from '../../../../shared/logicalTrackModel.ts'
import type { PlaylistRuntime } from '../../../../core/playlists/ports.ts'
import {
  readLibraryPlaylistTracks,
  playlistRecordingIdentity
} from './libraryPlaylistResolution.ts'
import { createPlaylistTrackResolver } from '../../../../core/playlists/trackResolver.ts'
import { LIBRARY_RECORDING_INDEX_EXPRESSION } from '../../../../main/library/libraryDatabasePlaylist.ts'
import { createPlaylistController } from './playlistController.ts'
import {
  createPlaylistDocumentWriter,
  exportPlaylistDocument
} from '../../utils/playlistLifecycle.ts'
import type { Playlist, PlaylistPersistenceNotice } from './musicStoreTypes.ts'
import type { PlaylistPersistenceStatus } from '../playlistPersistence.ts'
import type { TrackData as Track } from '../../../../shared/track.ts'

function track(id: string, patch: Partial<Track> = {}): Track {
  return {
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    album: 'Album',
    filePath: `D:/Music/${id}.flac`,
    fileName: `${id}.flac`,
    duration: 180,
    size: 1,
    cover: null,
    lyrics: 'heavy lyrics',
    source: 'local',
    ...patch
  }
}
function fixture(t: TestContext) {
  const db = new LibraryDatabase(':memory:')
  const tracks = Array.from({ length: 405 }, (_, i) => track(String(i)))
  db.replaceDocument({ version: 2, revision: 0, tracks, exclusions: [], folders: [] })
  t.after(() => db.close())
  const requests: Array<{ count: number; revision?: number }> = []
  let active = 0,
    maximumActive = 0,
    maximumRecords = 0
  const api: Pick<LibraryDatabaseApi, 'lookupPlaylistTracks' | 'getTracksByIds' | 'getMetadata'> = {
    lookupPlaylistTracks: async (request, revision) => {
      active++
      maximumActive = Math.max(maximumActive, active)
      try {
        requests.push({ count: request.entries.length, revision })
        await Promise.resolve()
        for (const entry of request.entries) {
          assert.equal('lyrics' in (entry.snapshot ?? {}), false)
          assert.equal('cover' in (entry.snapshot ?? {}), false)
        }
        return db.lookupPlaylistTracks(request, revision)
      } finally {
        active--
      }
    },
    getTracksByIds: async (ids, revision) => {
      active++
      maximumActive = Math.max(maximumActive, active)
      try {
        await Promise.resolve()
        const page = db.getTracksByIds(ids, revision)
        maximumRecords = Math.max(maximumRecords, page.tracks.length)
        return page
      } finally {
        active--
      }
    },
    getMetadata: async () => db.getMetadata()
  }
  const remote = track('remote:1', { source: 'remote', title: 'Remote only' }),
    replacement = track('remote:2', { source: 'remote', title: tracks[404].title }),
    missing = track('missing')
  const members = [...tracks, tracks[0], replacement, missing, remote],
    playlist: Playlist = {
      id: 'p',
      name: 'Mix',
      createdAt: '',
      trackIds: members.map((track) => track.id),
      trackSnapshots: Object.fromEntries(members.map((track) => [track.id, track]))
    }
  return {
    db,
    tracks,
    remote,
    playlist,
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

test('playlist resolution honors a shared revision and awaits each asynchronous consumer', async (t) => {
  const f = fixture(t)
  const expectedRevision = f.db.getMetadata().revision
  let consumed = 0
  await readLibraryPlaylistTracks(
    { trackIds: ['0'], trackSnapshots: { '0': f.tracks[0] } },
    f.api,
    {
      expectedRevision,
      getVersions: () => ({ revision: 0, versions: [] }),
      consume: async (batch) => {
        await Promise.resolve()
        consumed += batch.length
      }
    }
  )
  assert.equal(consumed, 1)
  assert.deepEqual(
    f.requests.map((request) => request.revision),
    [expectedRevision]
  )
})

test('stable mixed-source playlist export reads every member in 200-record windows, retains duplicates and preserves legacy text', async (t) => {
  const f = fixture(t)
  const sources = new Map([...f.tracks, f.remote].map((track) => [track.id, track]))
  for (const format of ['m3u', 'm3u8', 'pls'] as const) {
    const writer = createPlaylistDocumentWriter(format)
    await readLibraryPlaylistTracks(f.playlist, f.api, {
      getVersions: () => ({ revision: 0, versions: [] }),
      consume: (tracks) => {
        for (const track of tracks) {
          const source = sources.get(track.id)
          assert.ok(source)
          writer.append(source)
        }
      }
    })
    assert.equal(
      writer.finish(),
      exportPlaylistDocument([...f.tracks, f.tracks[0], f.tracks[404], f.remote], format)
    )
  }
  assert.deepEqual(
    f.requests.map((request) => request.count),
    [200, 200, 9, 200, 200, 9, 200, 200, 9]
  )
  assert.equal(f.maximumActive, 1)
  assert.equal(f.maximumRecords, 200)
})

test('aggregate resolution preserves remote variants and an empty playlist performs no library reads', async (t) => {
  const f = fixture(t),
    ids: string[] = []
  await readLibraryPlaylistTracks(f.playlist, f.api, {
    preserveSources: true,
    getVersions: () => ({ revision: 0, versions: [] }),
    consume: (batch) => {
      ids.push(...batch.map((track) => track.id))
    }
  })
  assert.deepEqual(ids.slice(-3), ['0', 'remote:2', 'remote:1'])
  f.requests.length = 0
  await readLibraryPlaylistTracks({ trackIds: [] }, f.api, {
    getVersions: () => ({ revision: 0, versions: [] }),
    consume: () => assert.fail('no empty batches')
  })
  assert.equal(f.requests.length, 0)
})

for (const phase of ['lookup', 'hydration', 'final-check', 'preferences', 'incomplete'] as const)
  test(`playlist export rejects ${phase} changes instead of publishing a partial file`, async (t) => {
    const f = fixture(t)
    let version = 0
    const mutate = () =>
      f.db.patchTracks([{ id: '0', expectedVersion: 1, patch: { title: 'Changed' } }])
    if (phase === 'lookup') {
      const lookup = f.api.lookupPlaylistTracks
      f.api.lookupPlaylistTracks = async (...args) => {
        const response = await lookup(...args)
        if (f.requests.length === 1) mutate()
        return response
      }
    }
    if (phase === 'hydration' || phase === 'incomplete') {
      const read = f.api.getTracksByIds
      f.api.getTracksByIds = async (...args) => {
        const page = await read(...args)
        if (phase === 'hydration' && f.requests.length === 1) mutate()
        return phase === 'incomplete' ? { ...page, tracks: [] } : page
      }
    }
    if (phase === 'final-check')
      f.api.getMetadata = async () => {
        mutate()
        return f.db.getMetadata()
      }
    const writer = createPlaylistDocumentWriter('pls')
    const sources = new Map([...f.tracks, f.remote].map((track) => [track.id, track]))
    await assert.rejects(
      readLibraryPlaylistTracks(f.playlist, f.api, {
        getVersions: () => ({ revision: version, versions: [] }),
        consume: (batch) => {
          for (const track of batch) {
            const source = sources.get(track.id)
            assert.ok(source)
            writer.append(source)
          }
          if (phase === 'preferences') version++
        }
      }),
      /发生变化/
    )
  })

test('async export guards playlist identity and concurrent order/snapshot changes; explicit JSON and sync callers keep their contract', async (t) => {
  t.mock.method(globalThis, 'setTimeout', (() => 0) as unknown as typeof setTimeout)
  const playlists = shallowRef<Playlist[]>([
    { id: 'p', name: 'Mix', createdAt: '', trackIds: ['0'], trackSnapshots: { '0': track('0') } }
  ])
  let release!: (value: string | null) => void
  const controller = createPlaylistController({
    playlists,
    tracks: shallowRef([track('0')]),
    trackById: new Map([['0', track('0')]]),
    getTracksRevision: () => 0,
    playlistPersistenceStatus: ref<PlaylistPersistenceStatus>({
      state: 'idle',
      dirty: false,
      failureCount: 0,
      lastError: null
    }),
    playlistPersistenceNotice: ref<PlaylistPersistenceNotice | null>(null),
    exportDocument: () =>
      new Promise((resolve) => {
        release = resolve
      })
  })
  for (const action of ['rename', 'replace', 'order', 'snapshot']) {
    playlists.value = [
      { id: 'p', name: 'Mix', createdAt: '', trackIds: ['0'], trackSnapshots: { '0': track('0') } }
    ]
    const pending = controller.exportPlaylistDocumentAsync('Mix', 'pls')
    if (action === 'rename') playlists.value[0].name = 'Renamed'
    if (action === 'replace') playlists.value[0].id = 'other'
    if (action === 'order') playlists.value[0].trackIds = ['0', '0']
    if (action === 'snapshot')
      playlists.value[0].trackSnapshots = { '0': track('0', { title: 'Changed' }) }
    release('should not download')
    await assert.rejects(pending, /发生变化/)
  }
  playlists.value = [{ id: 'p', name: 'Mix', createdAt: '', trackIds: ['0'] }]
  const json = controller.exportPlaylistDocumentAsync('Mix', 'pls')
  release(null)
  assert.equal(await json, controller.exportPlaylistDocument('Mix', 'pls'))
  assert.equal(await controller.exportPlaylistDocumentAsync('unknown', 'pls'), null)
})

test('indexed recording fallback exactly matches the existing resolver across duration groups, sources, NFKC and incomplete identities', (t) => {
  const recording = (id: string, patch: Partial<Track> = {}) =>
    track(id, { title: 'Song', ...patch })
  const tracks = [
    recording('first', { duration: 170, format: 'mp3' }),
    recording('later', { duration: 179, format: 'flac' }),
    recording('short-lossless', { duration: 176, format: 'flac' }),
    recording('live', { album: 'Live' }),
    recording('long', { duration: 300 }),
    recording('unicode', { title: ' Ａ  Song ', artist: '周杰伦' }),
    recording('incomplete', { title: '' }),
    recording('same-source-a', {
      title: 'Source',
      duration: 100,
      filePath: 'D:/Music/shared.flac'
    }),
    recording('same-source-b', {
      title: 'Source',
      duration: 300,
      filePath: 'D:/Music/shared.flac',
      album: 'Live'
    }),
    recording('source-neighbor', { title: 'Source', duration: 100, format: 'flac' })
  ]
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({ version: 2, revision: 0, tracks, folders: [], exclusions: [] })
  t.after(() => db.close())
  const snapshots = [
    ...Array.from({ length: 42 }, (_, i) => recording(`missing:${i}`, { duration: 160 + i * 2 })),
    recording('remote:song', { source: 'remote', duration: 175 }),
    recording('gone-live', { album: 'Live' }),
    recording('gone-unicode', { title: 'a song', artist: '周杰伦' }),
    recording('gone-empty', { title: '' }),
    recording('gone-source', { title: 'Source', duration: 100 }),
    recording('first', { title: 'stale title' })
  ]
  const resolver = createPlaylistTrackResolver({
    tracks: shallowRef(tracks),
    trackById: new Map(tracks.map((item) => [item.id, item])),
    getTracksRevision: () => 1,
    runtime: {
      now: Date.now,
      newId: () => 'test',
      clone: (value) => structuredClone(value),
      notify: () => {},
      identity: createLogicalTrackModel(() => undefined),
      versions: { ensure: () => {}, revision: () => 0 },
      repository: { load: async () => [], save: async () => ({ data: [], revision: 0 }) }
    } satisfies PlaylistRuntime
  })
  for (const preserveSources of [false, true]) {
    const expected = snapshots.map((snapshot) => {
      const resolved = resolver.resolvePlaylistTracks(
        {
          id: 'p',
          name: 'p',
          createdAt: '',
          trackIds: [snapshot.id],
          trackSnapshots: { [snapshot.id]: snapshot }
        },
        preserveSources
      )[0]
      return resolved && tracks.includes(resolved) ? resolved.id : null
    })
    assert.deepEqual(
      db.lookupPlaylistTracks({
        entries: snapshots.map((snapshot) => ({
          id: snapshot.id,
          snapshot: playlistRecordingIdentity(snapshot)
        })),
        versions: [],
        preserveSources
      }).ids,
      expected
    )
  }
  assert.match(
    db.sql
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM tracks WHERE ${LIBRARY_RECORDING_INDEX_EXPRESSION}=? ORDER BY seq`
      )
      .all('logic:song::artist')
      .map((row) => row.detail)
      .join(' '),
    /SEARCH.*tracks_recording/
  )
  const before = db.getMetadata().revision
  db.patchTracks([{ id: 'unicode', expectedVersion: 1, patch: { title: 'Changed' } }])
  assert.throws(() => db.lookupPlaylistTracks({ entries: [], versions: [] }, before), /发生变化/)
  assert.deepEqual(
    db.lookupPlaylistTracks({
      entries: [{ id: 'missing-unicode', snapshot: playlistRecordingIdentity(snapshots[44]) }],
      versions: []
    }).ids,
    [null]
  )
})
