import { createPlaylistReader, type PlaylistReaderOptions } from '../../../core/playlists/reader.ts'
import type {
  PlaylistImportDocument,
  PlaylistImportPage,
  PlaylistLink
} from '../../../shared/externalPlaylist.ts'
import type { PlaylistReadCredentials } from '../../../core/playlists/platformReader.ts'
import { useMediaProviders, syncPluginProviders } from '../providers/index.ts'

export interface PlaylistImportBridge {
  resolveNeteaseShortLink(request: { input: string; requestId: string }): Promise<PlaylistLink>
  readPage(request: {
    link: string
    offset: number
    cursor?: string
    requestId?: string
    credentials?: PlaylistReadCredentials
  }): Promise<PlaylistImportPage>
  cancelRead(requestId: string): Promise<boolean>
}
export interface PlaylistImportAdapter {
  read(
    link: string,
    options: PlaylistReaderOptions,
    bridge: PlaylistImportBridge
  ): Promise<PlaylistImportDocument>
}
/** Compatibility adapter until the production owner cutover. */
export const externalPlaylistAdapter: PlaylistImportAdapter = {
  read(input, options, bridge) {
    async function invoke<T>(signal: AbortSignal, action: (id: string) => Promise<T>): Promise<T> {
      signal.throwIfAborted()
      const id = crypto.randomUUID(),
        cancel = () => void bridge.cancelRead(id).catch(() => undefined)
      signal.addEventListener('abort', cancel, { once: true })
      try {
        return await action(id)
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    }
    return createPlaylistReader({
      providers: async () => {
        await syncPluginProviders()
        return useMediaProviders().list()
      },
      resolveShortLink: (input, signal) =>
        invoke(signal, (requestId) => bridge.resolveNeteaseShortLink({ input, requestId })),
      readPage: (request, signal) =>
        invoke(signal, (requestId) => bridge.readPage({ ...request, requestId }))
    })(input, options)
  }
}
