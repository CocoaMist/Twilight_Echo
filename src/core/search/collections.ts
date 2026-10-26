import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import type { TrackData } from '../../shared/track.ts'
import type {
  MediaProviderAlbumSummary,
  MediaProviderArtistSummary,
  MediaProviderPlaylistSummary
} from '../../shared/providerSearch.ts'
import type {
  CoreCollectionSearchQuery,
  CoreCollectionSearchPage,
  CoreCollectionSearchMethod,
  CoreSearchCollection
} from '../../shared/coreSearch.ts'
import type { UnifiedSearchProvider } from '../../shared/unifiedMusicSearch.ts'
import { searchUnifiedCollections } from '../../shared/unifiedCollectionSearch.ts'
import {
  searchLocalStreamingAlbums,
  searchLocalStreamingArtists
} from '../../shared/localMusicSearch.ts'
import { buildDerivedCollections } from '../library/derivedCollections.ts'
import { projectCoreError } from '../projections.ts'

export type CollectionSummary =
  | MediaProviderAlbumSummary
  | MediaProviderArtistSummary
  | MediaProviderPlaylistSummary
export interface CollectionSearchOptions {
  database: Pick<LibraryDatabaseApi, 'getMetadata' | 'queryCollections'>
  loadJsonLibrary?: () => Promise<{ revision: number; tracks: TrackData[] }>
  playlists: {
    getRevision(): number
    searchLocal(
      query: string,
      limit: number,
      offset: number
    ): { items: MediaProviderPlaylistSummary[]; total: number; revision: number }
  }
  providers(): Array<UnifiedSearchProvider & { supportedMethods?: readonly string[] }>
  searchProvider(
    id: string,
    method: CoreCollectionSearchMethod,
    query: string,
    limit: number,
    offset: number,
    signal: AbortSignal
  ): Promise<{ items: CollectionSummary[]; total: number }>
}

/** The established local-first prefix pagination, including partial-provider warnings. */
export async function searchMusicCollections(
  options: CollectionSearchOptions,
  query: CoreCollectionSearchQuery,
  signal: AbortSignal
): Promise<CoreCollectionSearchPage> {
  signal.throwIfAborted()
  const text = query.query.trim(),
    limit = query.limit ?? 30,
    offset = query.offset ?? 0
  const method: CoreCollectionSearchMethod =
    query.kind === 'albums'
      ? 'searchAlbums'
      : query.kind === 'artists'
        ? 'searchArtists'
        : 'searchPlaylists'
  const assertCurrent = async (revision: number | undefined) => {
    signal.throwIfAborted()
    if (revision === undefined) return
    const current =
      query.kind === 'playlists'
        ? options.playlists.getRevision()
        : options.loadJsonLibrary
          ? (await options.loadJsonLibrary()).revision
          : (await options.database.getMetadata()).revision
    signal.throwIfAborted()
    if (revision !== current) throw stale()
  }
  const tag = (item: CollectionSummary, id: string, name: string): CoreSearchCollection => ({
    ...('cover' in item ? { cover: publicCover(item.cover) } : {}),
    ...('picUrl' in item ? { picUrl: publicCover(item.picUrl) } : {}),
    kind: query.kind,
    id: item.id,
    name: item.name,
    providerId: id,
    providerName: name,
    ...('trackCount' in item ? { trackCount: item.trackCount } : {}),
    ...('artist' in item ? { artist: item.artist } : {}),
    ...('albumSize' in item ? { albumSize: item.albumSize } : {}),
    ...('musicSize' in item ? { musicSize: item.musicSize } : {}),
    ...('publishTime' in item ? { publishTime: item.publishTime } : {}),
    ...('releaseType' in item ? { releaseType: item.releaseType } : {}),
    ...('isExplicit' in item ? { isExplicit: item.isExplicit } : {}),
    ...('playCount' in item ? { playCount: item.playCount } : {}),
    ...('creatorName' in item ? { creatorName: item.creatorName } : {}),
    ...('owned' in item ? { owned: item.owned } : {})
  })
  const providerSearch = async (id: string, pageLimit: number, pageOffset: number) => {
    const provider = options.providers().find((item) => item.id === id)
    if (
      !provider ||
      provider.available === false ||
      provider.health?.available === false ||
      !provider.supportedMethods?.includes(method) ||
      (query.kind === 'albums' && !provider.capabilities.includes('search'))
    )
      throw new Error(`${provider?.name ?? id} 的搜索不可用`)
    const page = await options.searchProvider(id, method, text, pageLimit, pageOffset, signal)
    signal.throwIfAborted()
    return {
      items: page.items.slice(0, pageLimit).map((item) => tag(item, id, provider.name)),
      total: page.total
    }
  }
  const localSearch = async (pageLimit: number, pageOffset: number) => {
    signal.throwIfAborted()
    let page: { items: CollectionSummary[]; total: number; revision: number }
    if (query.kind === 'playlists')
      page = options.playlists.searchLocal(text, pageLimit, pageOffset)
    else if (options.loadJsonLibrary) {
      const library = await options.loadJsonLibrary()
      const catalog = buildDerivedCollections(library.tracks, [], '')
      const result =
        query.kind === 'albums'
          ? searchLocalStreamingAlbums(catalog.albums, text, pageLimit, pageOffset)
          : searchLocalStreamingArtists(catalog.artists, text, pageLimit, pageOffset)
      page = {
        items: 'albums' in result ? result.albums : result.artists,
        total: result.total,
        revision: library.revision
      }
    } else {
      const result = await options.database.queryCollections(query.kind, {
        search: text,
        collectionSearchMode: query.kind === 'albums' ? 'albumTerms' : 'artistName',
        limit: pageLimit,
        offset: pageOffset,
        contentRevision: query.contentRevision
      })
      page = {
        items: result.items.map((item) =>
          query.kind === 'albums'
            ? {
                id: item.id,
                name: item.name,
                artist: item.artist,
                cover: item.cover,
                trackCount: item.trackCount
              }
            : { id: item.id, name: item.name, picUrl: item.cover, musicSize: item.trackCount }
        ),
        total: result.total,
        revision: result.revision
      }
    }
    const expected = query.kind === 'playlists' ? query.playlistsRevision : query.contentRevision
    if (expected !== undefined && expected !== page.revision) throw stale()
    signal.throwIfAborted()
    return {
      items: page.items.map((item) => tag(item, 'local', '本地音乐')),
      total: page.total,
      revision: page.revision
    }
  }
  let warning: string | undefined
  let page: { items: CoreSearchCollection[]; total: number }, revision: number | undefined
  if (!text) page = { items: [], total: 0 }
  else if (query.providerId) page = await providerSearch(query.providerId, limit, offset)
  else if (query.scope === 'local') {
    const local = await localSearch(limit, offset)
    revision = local.revision
    await assertCurrent(revision)
    page = local
  } else {
    const local = await localSearch(limit, 0)
    revision = local.revision
    page = await searchUnifiedCollections({
      local,
      limit,
      offset,
      signal,
      searchLocal: async (pageLimit, pageOffset) => {
        const next = await localSearch(pageLimit, pageOffset)
        if (next.revision !== revision) throw stale()
        return next
      },
      providers: options
        .providers()
        .filter(
          (item) =>
            item.available !== false &&
            item.health?.available !== false &&
            item.supportedMethods?.includes(method) &&
            (query.kind !== 'albums' || item.capabilities.includes('search'))
        ),
      search: providerSearch,
      confirmLocal: () => assertCurrent(revision),
      reportError: (message) => {
        warning = projectCoreError(message)
      }
    })
  }
  signal.throwIfAborted()
  return {
    items: page.items,
    total: page.total,
    offset,
    hasMore: page.total > offset + limit,
    ...(revision === undefined
      ? {}
      : query.kind === 'playlists'
        ? { playlistsRevision: revision }
        : { libraryRevision: revision }),
    ...(warning ? { warning } : {})
  }
}
function stale() {
  return Object.assign(new Error('曲库或歌单在搜索期间发生变化，请重新搜索'), {
    code: 'STALE_REVISION'
  })
}
function publicCover(value: string | null): string | null {
  return value && (value.startsWith('cover://') || value.startsWith('twilight-media://image/')) ? value : null
}
