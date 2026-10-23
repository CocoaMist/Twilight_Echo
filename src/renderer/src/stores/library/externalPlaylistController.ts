import type { Ref } from 'vue'
import type { Playlist } from './musicStoreTypes.ts'
import { createExternalPlaylistCommands as createPortable } from '../../../../core/playlists/externalController.ts'
import { rendererPlaylistRuntime } from './playlistRuntime.ts'
export * from '../../../../core/playlists/externalController.ts'
export function createExternalPlaylistCommands(
  options: Omit<Parameters<typeof createPortable>[0], 'runtime' | 'playlists'> & {
    playlists: Ref<Playlist[]>
  }
) {
  return createPortable({ ...options, runtime: rendererPlaylistRuntime(options.playlists) })
}
