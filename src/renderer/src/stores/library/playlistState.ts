import type { Ref } from 'vue'
import type { Playlist } from './musicStoreTypes.ts'
import { createPlaylistState as createPortable } from '../../../../core/playlists/state.ts'
import { rendererPlaylistRuntime } from './playlistRuntime.ts'
export * from '../../../../core/playlists/state.ts'
export function createPlaylistState(
  options: Omit<Parameters<typeof createPortable>[0], 'runtime' | 'playlists'> & {
    playlists: Ref<Playlist[]>
  }
) {
  return createPortable({ ...options, runtime: rendererPlaylistRuntime(options.playlists) })
}
