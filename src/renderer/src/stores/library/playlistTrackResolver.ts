import { createPlaylistTrackResolver as createPortable } from '../../../../core/playlists/trackResolver.ts'
import { rendererPlaylistRuntime } from './playlistRuntime.ts'
export * from '../../../../core/playlists/trackResolver.ts'
export function createPlaylistTrackResolver(
  options: Omit<Parameters<typeof createPortable>[0], 'runtime'>
) {
  return createPortable({ ...options, runtime: rendererPlaylistRuntime() })
}
