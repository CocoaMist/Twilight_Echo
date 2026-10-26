import type { LocalAlbumSearchItem } from './localStreamingSearch.ts'
import type {
  MediaProvider,
  MediaProviderAlbumSummary,
  MediaProviderCallOptions,
  MediaProviderSearchResult
} from '@renderer/providers/mediaProvider.ts'
import type { Track } from '@renderer/types/music'
import { searchLocalStreamingAlbums } from './localStreamingSearch.ts'
import { searchUnifiedCollections } from './unifiedCollectionSearch.ts'
import type { LibrarySearchSnapshot } from '../../utils/unifiedMusicSearch.ts'

export interface AlbumSearchItem extends MediaProviderAlbumSummary {
  providerId: string
  providerName: string
}
export interface LocalAlbumSearchView extends LocalAlbumSearchItem {
  tracks: Track[]
}

interface AlbumSearchProvider {
  id: string
  name: string
  capabilities: readonly string[]
  supportedMethods?: readonly string[]
  health?: { available: boolean }
}

export function supportsAlbumSearch(provider: AlbumSearchProvider): boolean {
  return (
    provider.capabilities.includes('search') &&
    provider.supportedMethods?.includes('searchAlbums') === true
  )
}

export function albumSearchKey(album: Pick<AlbumSearchItem, 'id' | 'providerId'>): string {
  return JSON.stringify([album.providerId, String(album.id)])
}

export function createAlbumSearch(options: {
  localAlbums: () => readonly LocalAlbumSearchView[]
  providers: () => readonly AlbumSearchProvider[]
  searchProvider: (
    providerId: string,
    query: string,
    limit: number,
    offset: number,
    options?: MediaProviderCallOptions
  ) => Promise<MediaProviderSearchResult<MediaProviderAlbumSummary>>
  getProvider: (providerId: string) => MediaProvider | null | undefined
  reportError: (message: string) => void
  localSource?: {
    searchAlbums(
      query: string,
      limit: number,
      offset: number,
      signal?: AbortSignal
    ): Promise<{ items: MediaProviderAlbumSummary[]; total: number } & LibrarySearchSnapshot>
    confirm(page: LibrarySearchSnapshot, signal?: AbortSignal): Promise<void>
  }
}) {
  async function readLocalAlbums(
    query: string,
    limit: number,
    offset: number,
    signal?: AbortSignal
  ) {
    const page = options.localSource
      ? await options.localSource.searchAlbums(query, limit, offset, signal)
      : null
    const result = page
      ? { albums: page.items, total: page.total }
      : searchLocalStreamingAlbums(options.localAlbums(), query, limit, offset)
    return {
      albums: result.albums.map(
        (album): AlbumSearchItem => ({
          ...album,
          providerId: 'local',
          providerName: '本地音乐'
        })
      ),
      total: result.total,
      ...(page?.libraryRevision !== undefined ? { libraryRevision: page.libraryRevision } : {})
    }
  }

  async function searchLocalAlbums(
    query: string,
    limit = 30,
    offset = 0,
    callOptions?: MediaProviderCallOptions
  ) {
    const result = await readLocalAlbums(query, limit, offset, callOptions?.signal)
    await options.localSource?.confirm(result, callOptions?.signal)
    return result
  }

  async function searchProviderAlbums(
    providerId: string,
    query: string,
    limit = 30,
    offset = 0,
    callOptions?: MediaProviderCallOptions
  ) {
    const provider = options.providers().find((item) => item.id === providerId)
    if (!provider || provider.health?.available === false || !supportsAlbumSearch(provider)) {
      throw new Error(`${provider?.name ?? providerId} 的专辑搜索不可用`)
    }
    const result = await options.searchProvider(providerId, query, limit, offset, callOptions)
    return {
      albums: result.items.map(
        (album): AlbumSearchItem => ({
          ...album,
          providerId,
          providerName: provider.name
        })
      ),
      total: result.total
    }
  }

  async function searchAlbums(
    query: string,
    limit = 30,
    offset = 0,
    callOptions?: MediaProviderCallOptions
  ) {
    const local = await readLocalAlbums(query, limit, 0, callOptions?.signal)
    const result = await searchUnifiedCollections({
      local: { items: local.albums, total: local.total },
      searchLocal: async (pageLimit, pageOffset) => {
        const page = await readLocalAlbums(query, pageLimit, pageOffset, callOptions?.signal)
        if (page.libraryRevision !== local.libraryRevision)
          throw new Error('曲库在搜索期间发生变化，请重新搜索')
        return { items: page.albums, total: page.total }
      },
      providers: options
        .providers()
        .filter(
          (provider) => supportsAlbumSearch(provider) && provider.health?.available !== false
        ),
      search: async (providerId, pageLimit, pageOffset) => {
        const page = await searchProviderAlbums(
          providerId,
          query,
          pageLimit,
          pageOffset,
          callOptions
        )
        return { items: page.albums, total: page.total }
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
    return { albums: result.items, total: result.total }
  }

  async function loadAlbumTracks(
    album: Pick<AlbumSearchItem, 'id' | 'providerId'>
  ): Promise<Track[]> {
    if (album.providerId === 'local') {
      const local = options.localAlbums().find((item) => item.id === album.id)
      if (!local) throw new Error('这张专辑已不在本地音乐库中，请重新搜索')
      return local.tracks
    }
    const provider = options.getProvider(album.providerId)
    if (!provider?.fetchAlbumTracks) {
      throw new Error(`${provider?.name ?? album.providerId} 的专辑详情不可用`)
    }
    if (provider.isEnabled && !(await provider.isEnabled())) {
      throw new Error(`${provider.name} 音源当前不可用`)
    }
    return provider.fetchAlbumTracks(album.id)
  }

  return { searchAlbums, searchLocalAlbums, searchProviderAlbums, loadAlbumTracks }
}
