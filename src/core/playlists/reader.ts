import {
  EXTERNAL_PLAYLIST_MAX_ENTRIES,
  recognizePlaylistLink,
  isNeteaseShortLink,
  providerMatchesImportPlatform,
  type PlaylistImportPage,
  type PlaylistImportDocument,
  type PlaylistLink
} from '../../shared/externalPlaylist.ts'
import type { PlaylistReadCredentials } from './platformReader.ts'

export interface PlaylistReadProvider {
  id: string
  isEnabled?(): boolean | Promise<boolean>
  readPlaylistImportPage?(
    id: string,
    offset: number,
    limit: number,
    options: { signal: AbortSignal }
  ): Promise<PlaylistImportPage>
}
export interface PlaylistReaderPorts {
  providers(): Promise<PlaylistReadProvider[]> | PlaylistReadProvider[]
  resolveShortLink(input: string, signal: AbortSignal): Promise<PlaylistLink>
  readPage(
    request: {
      link: string
      offset: number
      cursor?: string
      credentials?: PlaylistReadCredentials
    },
    signal: AbortSignal
  ): Promise<PlaylistImportPage>
}
export interface PlaylistReaderOptions {
  signal: AbortSignal
  credentials?: PlaylistReadCredentials
  onLink?(link: PlaylistLink): void
  onPage?(page: PlaylistImportPage): void
}

/** The caller owns the job lifetime; credentials are used only by this read. */
export function createPlaylistReader(ports: PlaylistReaderPorts) {
  return async (input: string, options: PlaylistReaderOptions): Promise<PlaylistImportDocument> => {
    const { signal } = options
    signal.throwIfAborted()
    const link = isNeteaseShortLink(input)
      ? await ports.resolveShortLink(input, signal)
      : recognizePlaylistLink(input)
    signal.throwIfAborted()
    options.onLink?.(link)
    const provider = (await ports.providers()).find((p) =>
      providerMatchesImportPlatform(p.id, link.platform)
    )
    if (provider?.isEnabled && !(await provider.isEnabled()))
      throw new Error('对应音源尚未启用，请启用后重试，或选择文件导入')
    const songs: PlaylistImportDocument['songs'] = []
    let offset = 0,
      cursor: string | undefined,
      total: number | undefined,
      name = `${link.platform} 歌单`,
      expected: number | undefined
    for (;;) {
      signal.throwIfAborted()
      const page = provider?.readPlaylistImportPage
        ? await provider.readPlaylistImportPage(link.id, offset, 100, { signal })
        : await ports.readPage(
            { link: link.url, offset, cursor, credentials: options.credentials },
            signal
          )
      signal.throwIfAborted()
      if (
        !page ||
        !Array.isArray(page.songs) ||
        !Number.isSafeInteger(page.total) ||
        page.total < 0 ||
        page.total > EXTERNAL_PLAYLIST_MAX_ENTRIES ||
        !Number.isSafeInteger(page.nextOffset) ||
        page.nextOffset !== offset + page.songs.length ||
        typeof page.hasMore !== 'boolean'
      )
        throw new Error('平台返回了无效或超限的分页，未标记为完整歌单')
      if (page.hasMore && (!page.songs.length || page.nextOffset <= offset))
        throw new Error('平台分页没有前进，请重试')
      if (provider?.readPlaylistImportPage) {
        expected ??= page.total
        if (expected !== page.total) throw new Error('歌单在读取期间发生变化，请重新读取')
      }
      const normalized = page.songs.map((s) => ({ ...s, platform: s.platform ?? link.platform }))
      songs.push(...normalized)
      if (
        songs.length > EXTERNAL_PLAYLIST_MAX_ENTRIES ||
        (!page.hasMore && songs.length !== page.total)
      )
        throw new Error('歌单条目不完整，请重试或使用文件导入')
      total = page.total
      name = page.name || name
      options.onPage?.({ ...page, songs: normalized })
      if (!page.hasMore) break
      offset = page.nextOffset
      cursor = page.nextCursor
    }
    return {
      name,
      songs,
      source: {
        kind: 'platform',
        platform: link.platform,
        playlistId: link.id,
        url: link.url,
        label: link.platform
      },
      warnings: [],
      complete: true,
      total
    }
  }
}
