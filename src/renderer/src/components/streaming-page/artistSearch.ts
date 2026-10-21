import type {
  MediaProviderArtistSummary,
  MediaProviderCallOptions,
  MediaProviderSearchResult
} from '../../providers/mediaProvider.ts'
import type { LibrarySearchSnapshot } from '../../utils/unifiedMusicSearch.ts'
import type { LocalArtistSearchItem } from './localStreamingSearch.ts'
import { searchLocalStreamingArtists } from './localStreamingSearch.ts'
import { searchUnifiedCollections } from './unifiedCollectionSearch.ts'

/** Optional for legacy direct-provider arrays; search entry points always tag
 * origins so equal IDs/names from different providers never share navigation. */
export interface ArtistSearchItem extends MediaProviderArtistSummary {
  providerId?: string
  providerName?: string
}
export function artistSearchKey(item: ArtistSearchItem): string {
  return JSON.stringify([item.providerId ?? '', String(item.id)])
}

export function createArtistSearch(options: {
  localArtists(): readonly LocalArtistSearchItem[]
  localSource?: {
    searchArtists(
      query: string,
      limit: number,
      offset: number,
      signal?: AbortSignal
    ): Promise<{ items: MediaProviderArtistSummary[]; total: number } & LibrarySearchSnapshot>
    confirm(page: LibrarySearchSnapshot, signal?: AbortSignal): Promise<void>
  }
  providers(): readonly {
    id: string
    name: string
    supportedMethods: readonly string[]
    health?: { available?: boolean }
  }[]
  searchProvider(
    id: string,
    query: string,
    limit: number,
    offset: number,
    callOptions?: MediaProviderCallOptions
  ): Promise<MediaProviderSearchResult<MediaProviderArtistSummary>>
  reportError(message: string): void
}) {
  async function readLocal(query: string, limit: number, offset: number, signal?: AbortSignal) {
    const page = options.localSource
      ? await options.localSource.searchArtists(query, limit, offset, signal)
      : null
    const result = page
      ? { artists: page.items, total: page.total }
      : searchLocalStreamingArtists(options.localArtists(), query, limit, offset)
    return {
      artists: result.artists.map(
        (artist): ArtistSearchItem => ({ ...artist, providerId: 'local', providerName: '本地音乐' })
      ),
      total: result.total,
      ...(page?.libraryRevision !== undefined ? { libraryRevision: page.libraryRevision } : {})
    }
  }
  async function searchLocalArtists(
    query: string,
    limit = 30,
    offset = 0,
    callOptions?: MediaProviderCallOptions
  ) {
    const result = await readLocal(query, limit, offset, callOptions?.signal)
    await options.localSource?.confirm(result, callOptions?.signal)
    return result
  }
  async function searchProviderArtists(
    id: string,
    query: string,
    limit = 30,
    offset = 0,
    callOptions?: MediaProviderCallOptions
  ) {
    const provider = options.providers().find((provider) => provider.id === id)
    if (
      !provider ||
      provider.health?.available === false ||
      !provider.supportedMethods.includes('searchArtists')
    )
      throw new Error(`${provider?.name ?? id} 的艺人搜索不可用`)
    const result = await options.searchProvider(id, query, limit, offset, callOptions)
    return {
      artists: result.items.map(
        (artist): ArtistSearchItem => ({ ...artist, providerId: id, providerName: provider.name })
      ),
      total: result.total
    }
  }
  async function searchArtists(
    query: string,
    limit = 30,
    offset = 0,
    callOptions?: MediaProviderCallOptions
  ) {
    const local = await readLocal(query, limit, 0, callOptions?.signal)
    const result = await searchUnifiedCollections({
      local: { items: local.artists, total: local.total },
      searchLocal: async (pageLimit, pageOffset) => {
        const page = await readLocal(query, pageLimit, pageOffset, callOptions?.signal)
        if (page.libraryRevision !== local.libraryRevision)
          throw new Error('曲库在搜索期间发生变化，请重新搜索')
        return { items: page.artists, total: page.total }
      },
      providers: options
        .providers()
        .filter(
          (provider) =>
            provider.supportedMethods.includes('searchArtists') &&
            provider.health?.available !== false
        ),
      search: async (id, pageLimit, pageOffset) => {
        const page = await searchProviderArtists(id, query, pageLimit, pageOffset, callOptions)
        return { items: page.artists, total: page.total }
      },
      limit,
      offset,
      signal: callOptions?.signal,
      confirmLocal: () =>
        options.localSource?.confirm(local, callOptions?.signal) ?? Promise.resolve(),
      reportError: (message) => {
        if (!callOptions?.signal?.aborted) options.reportError(message)
      }
    })
    return { artists: result.items, total: result.total }
  }
  return { searchArtists, searchLocalArtists, searchProviderArtists }
}
