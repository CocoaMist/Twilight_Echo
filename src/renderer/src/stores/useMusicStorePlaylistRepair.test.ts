import assert from 'node:assert/strict'
import test from 'node:test'
import { ref, shallowRef } from 'vue'
import { LibraryDatabase } from '../../../main/library/libraryDatabase.ts'
import { useMusicStore } from './useMusicStore.ts'
import { usePlaylistLifecycleActions } from '../components/song-list/usePlaylistLifecycleActions.ts'
import type { Track } from '../types/music.ts'
import type { Playlist } from './library/musicStoreTypes.ts'
import { findPlaylistRelocations } from '../utils/playlistLifecycle.ts'
import type {
  LibraryPlaylistRepairRequest,
  LibraryPlaylistRepairResponse
} from '../../../shared/playlistRepair.ts'

test('the production repair action discovers authority, checks after scanning, and never uses renderer membership', async (t) => {
  t.mock.method(globalThis, 'setTimeout', (() => 0) as unknown as typeof setTimeout)
  const store = useMusicStore(),
    db = new LibraryDatabase(':memory:')
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.after(async () => {
    await store.flushPlaylists()
    store.playlists.value = []
    store.clearTracks()
    db.close()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const existing: Track = {
    id: 'existing',
    filePath: 'D:/Music/existing.flac',
    fileName: 'existing.flac',
    title: 'Existing',
    artist: 'Artist',
    album: 'Album',
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null,
    source: 'local'
  }
  const missing = {
      ...existing,
      id: 'missing',
      title: 'Missing',
      filePath: 'D:/Old/missing.flac',
      fileName: 'missing.flac'
    },
    moved = { ...missing, id: 'moved', filePath: 'E:/Moved/missing.flac' }
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [existing] })
  let mode: unknown = 'unknown',
    failure = false,
    reads = 0,
    writes = 0,
    pickerHook: (() => void) | undefined,
    scanHook: (() => void) | undefined
  const api = {
    library: {
      getStorageMode: async () => {
        if (failure) throw new Error('discovery failed')
        return mode
      },
      database: {
        repairPlaylist: async (
          request: LibraryPlaylistRepairRequest
        ): Promise<LibraryPlaylistRepairResponse> => {
          if (request.kind === 'open') {
            scanHook?.()
            return { kind: 'ready', id: 'repair', candidateCount: 2 }
          }
          if (request.kind === 'close') return { kind: 'closed', id: request.id }
          return {
            kind: 'resolved',
            id: request.id,
            sequence: request.sequence,
            result: findPlaylistRelocations(request.missing as unknown as Track[], [
              { ...existing, id: 'wrong', filePath: 'E:/Moved/existing.flac' },
              moved
            ]) as unknown as Extract<LibraryPlaylistRepairResponse, { kind: 'resolved' }>['result']
          }
        },
        getTracksByIds: async (...args: Parameters<typeof db.getTracksByIds>) => {
          reads++
          return db.getTracksByIds(...args)
        },
        getMetadata: async () => db.getMetadata()
      }
    },
    data: {
      savePlaylists: async () => {
        writes++
      }
    },
    dialog: {
      openFolder: async () => {
        pickerHook?.()
        return 'E:/Moved'
      }
    },
    fs: {
      scanMusicFiles: async () => {
        scanHook?.()
        return [{ ...existing, id: 'wrong', filePath: 'E:/Moved/existing.flac' }, moved]
      }
    }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api } })
  store.clearTracks()
  const playlist: Playlist = {
    id: 'favorites',
    name: '我收藏的音乐',
    isDefault: true,
    createdAt: '2026-01-01',
    trackIds: [existing.id, missing.id],
    trackSnapshots: { existing, missing }
  }
  store.playlists.value = [playlist]
  const currentPlaylist = shallowRef<Playlist | null>(playlist),
    message = ref('')
  const actions = usePlaylistLifecycleActions({
    currentPlaylist,
    isPlaylistDetail: ref(true),
    repairMessage: message,
    getSelectedTracks: () => [],
    isSelected: () => false,
    clearSelection: () => {},
    selectPlaylist: () => {}
  })
  await actions.handlePlaylistRepair()
  assert.match(message.value, /无法确认/)
  assert.deepEqual(playlist.trackIds, ['existing', 'missing'])
  failure = true
  await actions.handlePlaylistRepair()
  assert.equal(message.value, 'discovery failed')
  assert.equal(reads, 0)
  assert.equal(writes, 0)
  failure = false
  mode = 'sqlite'
  await actions.handlePlaylistRepair()
  assert.match(message.value, /已重新定位 1 首/)
  assert.deepEqual(playlist.trackIds, ['existing', 'moved'])
  assert.equal(reads, 2)
  assert.equal(store.tracks.value.length, 0)
  assert.equal(actions.playlistRepairPending.value, false)
  await store.flushPlaylists()
  assert.equal(writes, 1)
  for (const phase of ['picker', 'scan']) {
    playlist.name = '我收藏的音乐'
    playlist.trackIds = ['existing', 'missing']
    playlist.trackSnapshots = { existing, missing }
    const rename = () => {
      playlist.name = 'Renamed'
    }
    pickerHook = phase === 'picker' ? rename : undefined
    scanHook = phase === 'scan' ? rename : undefined
    await actions.handlePlaylistRepair()
    assert.match(message.value, /重命名或删除/)
  }
  pickerHook = undefined
  scanHook = undefined
  playlist.name = '我收藏的音乐'
  playlist.trackIds = ['existing', 'missing']
  playlist.trackSnapshots = { existing, missing }
  mode = 'json'
  const databaseReads = reads
  store.tracks.value = [existing]
  store.refreshLibraryIndex()
  await actions.handlePlaylistRepair()
  assert.deepEqual(playlist.trackIds, ['existing', 'moved'])
  assert.equal(reads, databaseReads)
  await store.flushPlaylists()
})
