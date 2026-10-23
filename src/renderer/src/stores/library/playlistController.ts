import type { Ref } from 'vue'
import type { Playlist } from './musicStoreTypes.ts'
import { createPlaylistController as createPortable } from '../../../../core/playlists/controller.ts'
import { rendererPlaylistRuntime } from './playlistRuntime.ts'
export * from '../../../../core/playlists/controller.ts'
export function createPlaylistController(
  options: Omit<Parameters<typeof createPortable>[0], 'runtime' | 'playlists'> & {
    playlists: Ref<Playlist[]>
  }
) {
  return createPortable({ ...options, runtime: rendererPlaylistRuntime(options.playlists) })
}
