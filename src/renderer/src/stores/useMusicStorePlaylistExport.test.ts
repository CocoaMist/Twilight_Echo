import assert from 'node:assert/strict'
import test from 'node:test'
import { ref, shallowRef } from 'vue'
import { LibraryDatabase } from '../../../main/library/libraryDatabase.ts'
import { useMusicStore } from './useMusicStore.ts'
import { usePlaylistLifecycleActions } from '../components/song-list/usePlaylistLifecycleActions.ts'
import type { Track } from '../types/music.ts'
import type { Playlist } from './library/musicStoreTypes.ts'

test('production download waits for authoritative export, reports failures without fallback, and fences concurrent edits', async (t) => {
  const store = useMusicStore(),
    db = new LibraryDatabase(':memory:')
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'),
    priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  t.after(() => {
    store.clearTracks()
    store.playlists.value = []
    db.close()
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  const track: Track = {
    id: 'unloaded',
    title: 'Authoritative',
    artist: 'Artist',
    album: 'Album',
    filePath: 'D:/Music/deep.flac',
    fileName: 'deep.flac',
    duration: 180,
    size: 1,
    source: 'local',
    cover: null,
    lyrics: 'large lyrics'
  }
  db.replaceDocument({ version: 2, revision: 0, tracks: [track], folders: [], exclusions: [] })
  const playlist: Playlist = { id: 'p', name: 'Mix', createdAt: '', trackIds: [track.id] }
  store.clearTracks()
  store.playlists.value = [playlist]
  let mode: unknown = 'unknown',
    fail = false,
    reads = 0,
    hold: Promise<void> | null = null
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        library: {
          getStorageMode: async () => mode,
          database: {
            lookupPlaylistTracks: async (...args: Parameters<typeof db.lookupPlaylistTracks>) => {
              reads++
              if (hold) await hold
              if (fail) throw new Error('database offline')
              return db.lookupPlaylistTracks(...args)
            },
            getTracksByIds: async (...args: Parameters<typeof db.getTracksByIds>) =>
              db.getTracksByIds(...args),
            getMetadata: async () => db.getMetadata()
          }
        }
      }
    }
  })
  const blobs: Blob[] = [],
    downloads: string[] = [],
    revoked: string[] = []
  t.mock.method(URL, 'createObjectURL', (blob: Blob) => {
    blobs.push(blob)
    return 'blob:export'
  })
  t.mock.method(URL, 'revokeObjectURL', (url: string) => {
    revoked.push(url)
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: (name: string) => {
        assert.equal(name, 'a')
        return {
          href: '',
          download: '',
          click() {
            downloads.push(this.download)
          }
        }
      }
    }
  })
  const current = shallowRef<Playlist | null>(playlist),
    message = ref('')
  const actions = usePlaylistLifecycleActions({
    currentPlaylist: current,
    isPlaylistDetail: ref(true),
    repairMessage: message,
    getSelectedTracks: () => [],
    isSelected: () => false,
    clearSelection: () => {},
    selectPlaylist: () => {}
  })
  await actions.downloadPlaylistDocument('pls')
  assert.match(message.value, /无法确认/)
  assert.equal(downloads.length, 0)
  assert.equal(reads, 0)
  mode = 'sqlite'
  fail = true
  await actions.downloadPlaylistDocument('pls')
  assert.equal(message.value, 'database offline')
  assert.equal(downloads.length, 0)
  fail = false
  await actions.downloadPlaylistDocument('pls')
  assert.deepEqual(downloads, ['Mix.pls'])
  assert.match(await blobs[0].text(), /File1=D:\/Music\/deep.flac/)
  assert.match(await blobs[0].text(), /NumberOfEntries=1/)
  assert.equal(store.tracks.value.length, 0)
  assert.deepEqual(revoked, ['blob:export'])
  let release!: () => void
  hold = new Promise((resolve) => {
    release = resolve
  })
  const pending = actions.downloadPlaylistDocument('m3u8')
  await Promise.resolve()
  await Promise.resolve()
  const before = reads
  await actions.downloadPlaylistDocument('m3u8')
  assert.equal(reads, before, 'duplicate export clicks must not create another read pipeline')
  playlist.name = 'Renamed'
  release()
  await pending
  assert.match(message.value, /发生变化/)
  assert.equal(downloads.length, 1)
  hold = null
  playlist.name = 'Mix'
  mode = 'json'
  store.tracks.value = [track]
  store.refreshLibraryIndex()
  await actions.downloadPlaylistDocument('m3u8')
  assert.deepEqual(downloads, ['Mix.pls', 'Mix.m3u8'])
  assert.match(await blobs[1].text(), /D:\/Music\/deep.flac/)
})
