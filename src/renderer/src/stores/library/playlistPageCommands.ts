import type { Ref } from 'vue'
import type { Playlist } from './musicStoreTypes.ts'
import { createPlaylistPageCommands as createPortable } from '../../../../core/playlists/pageCommands.ts'
import { rendererPlaylistRuntime } from './playlistRuntime.ts'
export * from '../../../../core/playlists/pageCommands.ts'
export function createPlaylistPageCommands(
  options: Omit<Parameters<typeof createPortable>[0], 'runtime' | 'playlists'> & {
    playlists: Ref<Playlist[]>
  }
) {
  return createPortable({ ...options, runtime: rendererPlaylistRuntime(options.playlists) })
}
