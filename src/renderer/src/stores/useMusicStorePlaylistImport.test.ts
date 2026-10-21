import assert from 'node:assert/strict'
import test from 'node:test'
import { ref, shallowRef } from 'vue'
import { LibraryDatabase } from '../../../main/library/libraryDatabase.ts'
import { useMusicStore } from './useMusicStore.ts'
import { usePlaylistLifecycleActions } from '../components/song-list/usePlaylistLifecycleActions.ts'
import type { Playlist } from './library/musicStoreTypes.ts'

test('store imports only through discovered authority and the production file-input action awaits SQLite', async (t) => {
  t.mock.method(globalThis, 'setTimeout', (() => 0) as unknown as typeof setTimeout)
  const db = new LibraryDatabase(':memory:'),
    store = useMusicStore()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.after(async () => {
    await store.flushPlaylists()
    store.playlists.value = []
    store.clearTracks()
    db.close()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const track = {
    id: 'deep-track',
    filePath: 'D:/Music/deep.flac',
    title: 'Authoritative',
    artist: 'Artist',
    album: 'Album'
  }
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [track] })
  let mode: unknown = 'unknown',
    failure = false,
    reads = 0,
    writes = 0
  const api = {
    library: {
      getStorageMode: async () => {
        if (failure) throw new Error('discovery failed')
        return mode
      },
      database: {
        lookupTracksByPaths: async (...args: Parameters<typeof db.lookupTracksByPaths>) => {
          reads++
          return db.lookupTracksByPaths(...args)
        },
        getTracksByIds: async (...args: Parameters<typeof db.getTracksByIds>) =>
          db.getTracksByIds(...args),
        getMetadata: async () => db.getMetadata()
      }
    },
    data: {
      savePlaylists: async () => {
        writes++
      },
      loadMusicLibrary: async () => {
        throw new Error('must not export the entire library to import a playlist')
      }
    }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api } })
  store.clearTracks()
  store.playlists.value = []
  await assert.rejects(
    store.importPlaylistPathBatchAsync([{ name: 'Unknown', paths: ['deep.flac'] }]),
    /无法确认/
  )
  failure = true
  await assert.rejects(
    store.importPlaylistPathBatchAsync([{ name: 'Failed', paths: ['deep.flac'] }]),
    /discovery failed/
  )
  assert.equal(store.playlists.value.length, 0)
  assert.equal(reads, 0)
  failure = false
  mode = 'json'
  const json = await store.importPlaylistDocumentAsync('JSON', 'mix.m3u8', 'deep.flac')
  assert.equal(json.unresolvedEntries, 1)
  assert.equal(reads, 0)
  await store.flushPlaylists()
  mode = 'sqlite'
  const result = await store.importPlaylistPathBatchAsync([{ name: 'SQL', paths: ['deep.flac'] }])
  assert.equal(result[0].importedCount, 1)
  assert.deepEqual(store.playlists.value.at(-1)?.trackIds, ['deep-track'])
  assert.deepEqual(store.tracks.value, [])
  assert.equal(reads, 1)
  await store.flushPlaylists()

  // Exercise the production file-input action, not an imitation of its logic.
  const currentPlaylist = shallowRef<Playlist | null>(store.playlists.value.at(-1)!)
  const message = ref('')
  const actions = usePlaylistLifecycleActions({
    currentPlaylist,
    isPlaylistDetail: ref(true),
    repairMessage: message,
    getSelectedTracks: () => [],
    isSelected: () => false,
    clearSelection: () => {},
    selectPlaylist: () => {}
  })
  const event = (text: () => Promise<string>) =>
    ({
      target: { files: [{ name: 'mix.pls', size: 64, text }], value: 'mix.pls' }
    }) as unknown as Event
  await actions.handlePlaylistImport(
    event(async () => '[playlist]\nFile1=deep.flac\nNumberOfEntries=1')
  )
  assert.match(message.value, /已导入 1 首/)
  assert.equal(reads, 2)
  await store.flushPlaylists()
  let release!: (text: string) => void
  const held = new Promise<string>((resolve) => {
    release = resolve
  })
  const pending = actions.handlePlaylistImport(event(() => held))
  store.deletePlaylist(currentPlaylist.value!.id)
  const before = reads
  release('deep.flac')
  await pending
  assert.match(message.value, /重命名或删除/)
  assert.equal(reads, before)
  assert.equal(
    store.playlists.value.some((p) => p.name === 'SQL'),
    false
  )
  assert.ok(writes > 0)
})
