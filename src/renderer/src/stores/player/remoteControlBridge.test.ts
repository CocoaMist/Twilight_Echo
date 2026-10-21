import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef } from 'vue'
import type { RemoteBrowseResult } from '../../../../shared/remoteControl.ts'
import type { Track } from '../../types/music.ts'
import { createRemoteControlBridge } from './remoteControlBridge.ts'
import { createQueueCommandController } from './queueCommandController.ts'
import { toPlaybackQueueSnapshots } from '@renderer/utils/playbackQueueVirtualization.ts'
import type { PlayMode } from '@renderer/types/settings'

const track = (id: string, title: string): Track => ({
  id,
  title,
  artist: 'Artist',
  album: 'Album',
  duration: 180,
  filePath: `C:/private/${id}.flac`,
  fileName: `${id}.flac`,
  size: 1,
  cover: '',
  lyrics: '',
  source: 'local'
})

test('remote revisions follow real queue removal and undo and cannot reuse a stale duplicate index', async (t) => {
  const tracks = shallowRef([track('a', 'Alpha'), track('b', 'Beta')])
  const queue = shallowRef(
    toPlaybackQueueSnapshots([tracks.value[0], tracks.value[0], tracks.value[1]])
  )
  const originalQueue = shallowRef([...queue.value])
  const currentTrack = shallowRef<Track | null>(queue.value[1])
  const queueIndex = shallowRef(1)
  const playMode = shallowRef<PlayMode>('sequential')
  const commands = createQueueCommandController({
    queue,
    originalQueue,
    currentTrack,
    queueIndex,
    playMode,
    getPosition: () => 0,
    prepareSelection: (track) => {
      currentTrack.value = track
    },
    onMutation: () => {}
  })
  t.after(commands.dispose)
  const bridge = createRemoteControlBridge({
    tracks,
    queue,
    queueIndex,
    playMode,
    playlists: shallowRef([]),
    getPlaylistTracks: () => [],
    playTrack: async () => {},
    enqueueTrack: (track) => {
      commands.add([track], queue.value.length, originalQueue.value.length)
    },
    removeQueueItem: commands.remove,
    jumpQueue: () => {},
    setPlayMode: () => {}
  })
  const page = bridge.browse({ view: 'queue', query: '', offset: 0, limit: 40 })
  await bridge.command({ action: 'removeQueue', index: 0, revision: page.revision! })
  assert.equal(queueIndex.value, 0)
  assert.equal(currentTrack.value?.queueEntryId, queue.value[0].queueEntryId)
  const afterRemoval = bridge.snapshot().queueRevision
  assert.equal(commands.undo(), true)
  assert.ok(bridge.snapshot().queueRevision > afterRemoval)
  assert.equal(queueIndex.value, 1)
  await assert.rejects(
    bridge.command({ action: 'removeQueue', index: 0, revision: page.revision! }),
    /queue_changed/
  )
  assert.equal(queue.value.length, 3)
})

test('remote bridge returns opaque bounded pages and executes a selected track', async () => {
  const tracks = shallowRef([track('private-a', 'Alpha'), track('private-b', 'Beta')])
  const queue = shallowRef([tracks.value[0]])
  const played: string[] = []
  const bridge = createRemoteControlBridge({
    tracks,
    playlists: shallowRef([{ id: 'playlist-private', name: 'Quiet', trackIds: ['private-a'] }]),
    getPlaylistTracks: () => [tracks.value[0]],
    queue,
    queueIndex: shallowRef(0),
    playMode: shallowRef('sequential'),
    playTrack: async (item) => {
      played.push(item.id)
    },
    enqueueTrack: (item) => {
      queue.value = [...queue.value, item]
    },
    jumpQueue: () => {},
    removeQueueItem: () => {},
    setPlayMode: () => {}
  })
  const page = bridge.browse({ view: 'library', query: 'alpha', offset: 0, limit: 40 })
  assert.equal(page.items.length, 1)
  assert.notEqual(page.items[0].id, 'private-a')
  assert.doesNotMatch(JSON.stringify(page), /C:\/private/)
  await bridge.command({ action: 'playTrack', id: page.items[0].id })
  assert.deepEqual(played, ['private-a'])
})

test('remote bridge expands opaque playlist tokens through the authoritative resolver', () => {
  const tracks = shallowRef([track('a', 'Alpha'), track('b', 'Beta')])
  const playlists = shallowRef([{ id: 'playlist-private', name: 'Quiet', trackIds: [] }])
  const bridge = createRemoteControlBridge({
    tracks,
    playlists,
    getPlaylistTracks: () => [tracks.value[1]],
    queue: shallowRef([]),
    queueIndex: shallowRef(-1),
    playMode: shallowRef('sequential'),
    playTrack: async () => {},
    enqueueTrack: () => {},
    jumpQueue: () => {},
    removeQueueItem: () => {},
    setPlayMode: () => {}
  })
  const playlist = bridge.browse({ view: 'playlists', query: '', offset: 0, limit: 40 }).items[0]
  const page = bridge.browse({
    view: 'playlists',
    playlistId: playlist.id,
    query: '',
    offset: 0,
    limit: 40
  })
  assert.deepEqual(
    page.items.map((item) => item.title),
    ['Beta']
  )
})

test('remote bridge fences queue operations by revision', async () => {
  const tracks = shallowRef([track('a', 'Alpha')])
  const queue = shallowRef([tracks.value[0]])
  let removed = -1
  const bridge = createRemoteControlBridge({
    tracks,
    playlists: shallowRef([]),
    getPlaylistTracks: () => [],
    queue,
    queueIndex: shallowRef(0),
    playMode: shallowRef('sequential'),
    playTrack: async () => {},
    enqueueTrack: () => {},
    jumpQueue: () => {},
    removeQueueItem: (index) => {
      removed = index
      queue.value = []
    },
    setPlayMode: () => {}
  })
  const revision = bridge.browse({ view: 'queue', query: '', offset: 0, limit: 40 }).revision!
  await bridge.command({ action: 'removeQueue', index: 0, revision })
  assert.equal(removed, 0)
  await assert.rejects(() => bridge.command({ action: 'removeQueue', index: 0, revision }), {
    message: 'queue_changed'
  })
})

test('playlist-only tracks play and enqueue current snapshots, then reject removal', async () => {
  const local = track('local', 'Local')
  let provider = track('provider-only', 'Provider')
  let playlistTracks = [provider]
  const played: Track[] = []
  const bridge = createRemoteControlBridge({
    tracks: shallowRef([local]),
    playlists: shallowRef([{ id: 'p', name: 'Provider', trackIds: ['provider-only'] }]),
    getPlaylistTracks: () => playlistTracks,
    queue: shallowRef([]),
    queueIndex: shallowRef(-1),
    playMode: shallowRef('sequential'),
    playTrack: async (item, context) => {
      played.push(item)
      assert.equal(context, playlistTracks)
    },
    enqueueTrack: (item) => {
      played.push(item)
    },
    jumpQueue: () => {},
    removeQueueItem: () => {},
    setPlayMode: () => {}
  })
  const p = bridge.browse({ view: 'playlists', query: '', offset: 0, limit: 40 }).items[0]
  const selected = bridge.browse({
    view: 'playlists',
    playlistId: p.id,
    query: '',
    offset: 0,
    limit: 40
  }).items[0]
  await bridge.command({ action: 'playTrack', id: selected.id })
  provider = { ...provider, title: 'Updated', filePath: 'new-authorized-path' }
  playlistTracks = [provider]
  await bridge.command({ action: 'enqueueTrack', id: selected.id })
  assert.equal(played[1], provider)
  playlistTracks = []
  await assert.rejects(bridge.command({ action: 'playTrack', id: selected.id }), /track_not_found/)
})

test('large-library paging mints only visible tokens and queue revisions distinguish duplicate reorders', () => {
  const tracks = shallowRef(Array.from({ length: 20000 }, (_, i) => track(String(i), 'Song ' + i)))
  const queue = shallowRef([tracks.value[0], tracks.value[0], tracks.value[1]])
  let minted = 0
  const original = crypto.randomUUID.bind(crypto)
  const stub = test.mock.method(crypto, 'randomUUID', () => {
    minted++
    return original()
  })
  try {
    const bridge = createRemoteControlBridge({
      tracks,
      playlists: shallowRef([]),
      getPlaylistTracks: () => [],
      queue,
      queueIndex: shallowRef(0),
      playMode: shallowRef('sequential'),
      playTrack: async () => {},
      enqueueTrack: () => {},
      jumpQueue: () => {},
      removeQueueItem: () => {},
      setPlayMode: () => {}
    })
    assert.equal(
      bridge.browse({ view: 'library', query: '', offset: 80, limit: 40 }).items.length,
      40
    )
    assert.equal(minted, 40)
    bridge.browse({ view: 'library', query: '', offset: 80, limit: 40 })
    assert.equal(minted, 40)
    const revision = bridge.snapshot().queueRevision
    assert.equal(bridge.snapshot().queueRevision, revision)
    queue.value = [tracks.value[0], tracks.value[1], tracks.value[0]]
    assert.ok(bridge.snapshot().queueRevision > revision)
  } finally {
    stub.mock.restore()
  }
})

test('SQLite remote browsing reads a bounded page and plays through the frozen database query', async () => {
  const record = {
    id: 'track:deep',
    filePath: 'D:/Music/deep.flac',
    fileName: 'deep.flac',
    title: 'Deep Song',
    artist: 'Artist',
    album: 'Album',
    duration: 180,
    source: 'local'
  }
  const requests: unknown[] = []
  const played: Array<{ query: unknown; id: string }> = []
  const bridge = createRemoteControlBridge({
    tracks: {
      get value(): Track[] {
        throw new Error('SQLite remote browse must not read the compatibility array')
      }
    } as never,
    playlists: shallowRef([]),
    getPlaylistTracks: () => {
      throw new Error('SQLite remote browse must not resolve playlist arrays')
    },
    queue: shallowRef([]),
    queueIndex: shallowRef(-1),
    playMode: shallowRef('sequential'),
    playTrack: async () => {},
    enqueueTrack: () => {},
    jumpQueue: () => {},
    removeQueueItem: () => {},
    setPlayMode: () => {},
    getStorageMode: async () => 'sqlite',
    database: {
      queryTracks: async (query) => {
        requests.push(query)
        return {
          tracks: [record],
          versions: { [record.id]: 1 },
          total: 401,
          revision: 7,
          offset: query?.offset ?? 0,
          totalDuration: 0
        }
      },
      queryCollections: async () => ({
        items: [],
        total: 0,
        revision: 7,
        offset: 0,
        letterOffsets: {}
      }),
      getTracksByIds: async () => ({
        tracks: [record],
        versions: { [record.id]: 1 },
        total: 1,
        revision: 7,
        offset: 0
      }),
      readLibraryQueue: async () => ({
        items: [],
        total: 0,
        revision: 1,
        libraryRevision: 7,
        offset: 0
      })
    },
    playLibraryQuery: async (query, id) => {
      played.push({ query, id })
    }
  })
  const page = await (bridge.browse({
    view: 'library',
    query: 'Deep',
    offset: 200,
    limit: 40
  }) as unknown as Promise<RemoteBrowseResult>)
  assert.equal(page.items[0].title, 'Deep Song')
  assert.equal(page.total, 401)
  assert.deepEqual(requests, [
    {
      search: 'Deep',
      searchLiteral: true,
      sort: 'insertion',
      direction: 'asc',
      offset: 200,
      limit: 40
    }
  ])
  await bridge.command({ action: 'playTrack', id: page.items[0].id })
  assert.deepEqual(played, [
    {
      query: { search: 'Deep', searchLiteral: true, sort: 'insertion', direction: 'asc' },
      id: record.id
    }
  ])
})

test('SQLite remote playlist browsing uploads a playlist view once and keeps playback query bounded', async () => {
  const playlistQueries: Array<{ id: string; request: unknown }> = []
  const record = {
    id: 'track:playlist',
    filePath: 'D:/Music/playlist.flac',
    fileName: 'playlist.flac',
    title: 'Playlist Song',
    artist: 'Artist',
    album: 'Album',
    duration: 90,
    source: 'local'
  }
  const bridge = createRemoteControlBridge({
    tracks: { value: [] } as never,
    playlists: shallowRef([{ id: 'p', name: 'Saved', trackIds: ['track:playlist'] }]),
    getPlaylistTracks: () => [],
    queue: shallowRef([]),
    queueIndex: shallowRef(-1),
    playMode: shallowRef('sequential'),
    playTrack: async () => {},
    enqueueTrack: () => {},
    jumpQueue: () => {},
    removeQueueItem: () => {},
    setPlayMode: () => {},
    getStorageMode: async () => 'sqlite',
    database: {
      queryTracks: async () => ({ tracks: [], versions: {}, total: 0, revision: 2, offset: 0 }),
      queryCollections: async () => ({
        items: [],
        total: 0,
        revision: 2,
        offset: 0,
        letterOffsets: {}
      }),
      getTracksByIds: async () => ({ tracks: [], versions: {}, total: 0, revision: 2, offset: 0 }),
      readLibraryQueue: async () => ({
        items: [],
        total: 0,
        revision: 1,
        libraryRevision: 2,
        offset: 0
      })
    },
    queryLibraryPlaylist: async (id, request) => {
      playlistQueries.push({ id, request })
      return {
        page: { tracks: [record], versions: {}, total: 1, revision: 2, offset: 0 },
        query: { playlistView: 'remote-view', sort: 'playlist' }
      }
    },
    playLibraryQuery: async () => {}
  })
  const headers = await (bridge.browse({
    view: 'playlists',
    query: '',
    offset: 0,
    limit: 40
  }) as unknown as Promise<RemoteBrowseResult>)
  const page = await (bridge.browse({
    view: 'playlists',
    playlistId: headers.items[0].id,
    query: '',
    offset: 0,
    limit: 40
  }) as unknown as Promise<RemoteBrowseResult>)
  assert.equal(page.items[0].title, 'Playlist Song')
  assert.equal(playlistQueries.length, 1)
  assert.equal(playlistQueries[0].id, 'p')
})
