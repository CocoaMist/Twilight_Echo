import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import { coreLibraryFixture } from './coreLibraryTestFixture.ts'
import { createCoreMusicStore } from './library/coreMusicStore.ts'
import * as fileValidation from '../utils/playlistFileValidation.ts'
import * as playlistExport from '../utils/playlistExport.ts'
import type { usePlaylistLifecycleActions } from '../components/song-list/usePlaylistLifecycleActions.ts'
import type { CorePlaylistDescriptor } from '../../../shared/corePlaylists.ts'

function lifecycle(store: ReturnType<typeof createCoreMusicStore>) {
  const exports: { usePlaylistLifecycleActions?: typeof usePlaylistLifecycleActions } = {}
  const dependencies: Record<string, unknown> = {
    vue,
    '@renderer/stores/useMusicStore.ts': { useMusicStore: () => store },
    '@renderer/utils/playlistExport.ts': playlistExport,
    '@renderer/utils/playlistFileValidation.ts': fileValidation
  }
  runInNewContext(
    ts.transpileModule(
      readFileSync(
        new URL('../components/song-list/usePlaylistLifecycleActions.ts', import.meta.url),
        'utf8'
      ),
      {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }
    ).outputText,
    {
      exports,
      require: (id: string) => {
        assert.ok(id in dependencies, id)
        return dependencies[id]
      },
      Error,
      setTimeout
    }
  )
  return exports.usePlaylistLifecycleActions!
}

test('the production file-input action imports through Core SQL authority without transferring full membership or a library array', async (t) => {
  const f = await coreLibraryFixture(t, {
    tracks: [
      {
        id: 'deep-track',
        filePath: 'D:/Music/deep.flac',
        title: 'Authoritative',
        artist: 'Artist',
        album: 'Album'
      }
    ]
  })
  const store = createCoreMusicStore(f.core)
  t.after(store.dispose)
  await store.loadPlaylists()
  const id = await store.createPlaylist('SQL')
  const currentPlaylist = vue.shallowRef<CorePlaylistDescriptor | null>(
    store.playlists.value.find((item) => item.id === id)!
  )
  const message = vue.ref('')
  const scope = vue.effectScope()
  t.after(() => scope.stop())
  const actions = scope.run(() =>
    lifecycle(store)({
      currentPlaylist,
      isPlaylistDetail: vue.ref(true),
      repairMessage: message,
      getSelectedTracks: () => [],
      isSelected: () => false,
      clearSelection() {},
      selectPlaylist() {}
    })
  )!
  const event = (text: () => Promise<string>) =>
    ({
      target: { files: [{ name: 'mix.pls', size: 64, text }], value: 'mix.pls' }
    }) as unknown as Event
  await actions.handlePlaylistImport(
    event(async () => '[playlist]\nFile1=deep.flac\nNumberOfEntries=1')
  )
  assert.match(message.value, /已导入 1 首/)
  const members = await store.getPlaylistMembers(id)
  assert.deepEqual(
    members.items.map((item) => item.id),
    ['deep-track']
  )
  assert.equal(store.playlists.value.find((item) => item.id === id)?.count, 1)
  assert.equal('trackIds' in store.playlists.value.find((item) => item.id === id)!, false)
  assert.equal('tracks' in store, false)
  assert.equal(
    f.commands.filter((command) => command.name === 'playlists.importDocument').length,
    1
  )
  assert.equal(
    f.queries.some((query) => query.name === 'library.tracks'),
    false
  )
  let release!: (text: string) => void
  const held = new Promise<string>((resolve) => {
    release = resolve
  })
  const pending = actions.handlePlaylistImport(event(() => held))
  await store.deletePlaylist(id)
  const before = f.commands.length
  release('deep.flac')
  await pending
  assert.match(message.value, /重命名或删除/)
  assert.equal(f.commands.length, before)
  assert.equal(
    store.playlists.value.some((playlist) => playlist.id === id),
    false
  )
})
