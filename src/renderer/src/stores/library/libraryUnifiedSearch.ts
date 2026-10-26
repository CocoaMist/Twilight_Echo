import type {
  LibraryDatabaseApi,
  LibraryCollectionPage
} from '../../../../shared/libraryDatabase.ts'
import type { TrackData as Track } from '../../../../shared/track.ts'
import type {
  LibrarySearchSnapshot,
  UnifiedLocalSearchPage
} from '../../utils/unifiedMusicSearch.ts'
import type { LibraryItem } from './musicStoreTypes.ts'
import type {
  MediaProviderAlbumSummary,
  MediaProviderArtistSummary
} from '../../providers/mediaProvider.ts'
import {
  searchLocalStreamingAlbums,
  searchLocalStreamingArtists
} from '../../utils/localStreamingSearch.ts'
import { getTrackSearchBlob, normalizeSearchText } from '../../utils/localLibrarySearch.ts'
import { searchUnifiedLocalPage, toSearchItem } from '../../utils/unifiedSearchSources.ts'
import { libraryTrack } from '../../../../core/playback/libraryTrack.ts'

const cancelled = () => new DOMException('Search was cancelled', 'AbortError')
type Operation = {
  run(): Promise<unknown>
  resolve(value: unknown): void
  reject(error: unknown): void
  signal?: AbortSignal
}

/** One instance per search consumer. Two in-flight reads and only the newest
 * waiting demand; replacing a search cannot free a still-running RPC slot. */
export function createLibraryUnifiedSearch(options: {
  getStorageMode(): Promise<'json' | 'sqlite'>
  getJsonTracks(): Track[]
  getJsonAlbums?(): readonly LibraryItem[]
  getJsonArtists?(): readonly LibraryItem[]
  getPreferences(): { revision: number; sources: string[] }
  api: Pick<LibraryDatabaseApi, 'queryTracks' | 'getMetadata'> &
    Partial<Pick<LibraryDatabaseApi, 'queryCollections'>>
}) {
  let active = 0,
    pending: Operation | null = null,
    disposed = false,
    minimumRevision = 0
  function pump(): void {
    if (disposed || active >= 2 || !pending) return
    const operation = pending
    pending = null
    if (operation.signal?.aborted) {
      operation.reject(cancelled())
      return
    }
    active++
    void operation
      .run()
      .then(operation.resolve, operation.reject)
      .finally(() => {
        active--
        pump()
      })
  }
  function perform<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (disposed || signal?.aborted) return Promise.reject(cancelled())
    pending?.reject(cancelled())
    return new Promise((resolve, reject) => {
      pending = { run, resolve: (value) => resolve(value as T), reject, signal }
      pump()
    })
  }
  function assertCurrent(page: LibrarySearchSnapshot, signal?: AbortSignal): void {
    if (disposed || signal?.aborted) throw cancelled()
    if (
      (page.libraryRevision !== undefined && page.libraryRevision < minimumRevision) ||
      (page.preferenceRevision !== undefined &&
        page.preferenceRevision !== options.getPreferences().revision)
    )
      throw new Error('曲库或版本偏好已变化，请重新搜索')
  }
  async function storageMode(signal?: AbortSignal) {
    const mode = await options.getStorageMode()
    if (signal?.aborted || disposed) throw cancelled()
    if (mode !== 'json' && mode !== 'sqlite') throw new Error('无法确认曲库存储，未执行本地搜索')
    return mode
  }
  async function confirmSnapshot(page: LibrarySearchSnapshot, signal?: AbortSignal): Promise<void> {
    assertCurrent(page, signal)
    if (page.libraryRevision === undefined) return
    const current = await options.api.getMetadata()
    assertCurrent(page, signal)
    if (current.revision !== page.libraryRevision)
      throw new Error('曲库在搜索期间发生变化，请重新搜索')
  }
  function bounds(limit: number, offset: number): void {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Error('无效的统一搜索页码')
  }
  async function searchCollection(
    kind: 'albums' | 'artists',
    query: string,
    limit: number,
    offset: number,
    signal?: AbortSignal
  ) {
    bounds(limit, offset)
    if ((await storageMode(signal)) === 'json') return null
    if (!options.api.queryCollections) throw new Error('数据库分类查询不可用')
    const page = await options.api.queryCollections(kind, {
      search: query,
      collectionSearchMode: kind === 'albums' ? 'albumTerms' : 'artistName',
      limit,
      offset
    })
    const snapshot = { libraryRevision: page.revision }
    assertCurrent(snapshot, signal)
    return page
  }
  function catalogPage<T>(
    page: LibraryCollectionPage,
    items: T[]
  ): { items: T[]; total: number } & LibrarySearchSnapshot {
    return { items, total: page.total, libraryRevision: page.revision }
  }
  function searchPage(
    query: string,
    limit: number,
    offset: number,
    signal?: AbortSignal,
    unified = true
  ): Promise<UnifiedLocalSearchPage> {
    return perform(async () => {
      bounds(limit, offset)
      const mode = await storageMode(signal)
      if (mode === 'json') {
        if (unified) {
          const page = searchUnifiedLocalPage(options.getJsonTracks(), query, limit, offset)
          return { ...page, preferenceRevision: options.getPreferences().revision }
        }
        const q = normalizeSearchText(query),
          items: UnifiedLocalSearchPage['items'] = []
        let total = 0
        if (q)
          for (const track of options.getJsonTracks()) {
            if (!getTrackSearchBlob(track).includes(q)) continue
            if (total >= offset && items.length < limit)
              items.push(toSearchItem(track, { sourceName: '本地音乐', providerAvailable: true }))
            total++
          }
        return { items, total }
      }
      if (!normalizeSearchText(query)) return { items: [], total: 0 }
      const preferences = options.getPreferences()
      const page = await options.api.queryTracks({
        search: query,
        ...(unified
          ? {
              searchFileName: true,
              sort: 'unifiedSearch' as const,
              preferredSources: preferences.sources
            }
          : { sort: 'playlist' as const }),
        limit,
        offset
      })
      const result = {
        items: page.tracks.map((track) =>
          toSearchItem(libraryTrack(track), {
            sourceName: '本地音乐',
            providerAvailable: true
          })
        ),
        total: page.total,
        libraryRevision: page.revision,
        preferenceRevision: preferences.revision,
        ...(!unified
          ? {
              playbackQuery: {
                search: query,
                sort: 'playlist' as const,
                contentRevision: page.revision
              }
            }
          : {})
      }
      assertCurrent(result, signal)
      return result
    }, signal)
  }
  return {
    search: searchPage,
    confirm: (page: LibrarySearchSnapshot, signal?: AbortSignal) =>
      perform(() => confirmSnapshot(page, signal), signal),
    searchAlbums: (query: string, limit = 30, offset = 0, signal?: AbortSignal) =>
      perform(
        async (): Promise<
          { items: MediaProviderAlbumSummary[]; total: number } & LibrarySearchSnapshot
        > => {
          const page = await searchCollection('albums', query, limit, offset, signal)
          if (!page) {
            if (!options.getJsonAlbums) throw new Error('本地专辑查询不可用')
            const result = searchLocalStreamingAlbums(options.getJsonAlbums(), query, limit, offset)
            return { items: result.albums, total: result.total }
          }
          return catalogPage(
            page,
            page.items.map((item) => ({
              id: item.id,
              name: item.name,
              artist: item.artist,
              cover: item.cover,
              coverSource: item.coverSource,
              trackCount: item.trackCount
            }))
          )
        },
        signal
      ),
    searchArtists: (query: string, limit = 30, offset = 0, signal?: AbortSignal) =>
      perform(
        async (): Promise<
          { items: MediaProviderArtistSummary[]; total: number } & LibrarySearchSnapshot
        > => {
          const page = await searchCollection('artists', query, limit, offset, signal)
          if (!page) {
            if (!options.getJsonArtists) throw new Error('本地艺人查询不可用')
            const result = searchLocalStreamingArtists(
              options.getJsonArtists(),
              query,
              limit,
              offset
            )
            return { items: result.artists, total: result.total }
          }
          return catalogPage(
            page,
            page.items.map((item) => ({
              id: item.id,
              name: item.name,
              picUrl: item.cover,
              musicSize: item.trackCount
            }))
          )
        },
        signal
      ),
    resolveAlbum: (selection: { albumId: string } | { trackId: string }, signal?: AbortSignal) =>
      perform(async () => {
        const id = 'albumId' in selection ? selection.albumId : selection.trackId
        if (typeof id !== 'string' || !id || id.length > 32768)
          throw new Error('无效的本地专辑标识')
        const mode = await storageMode(signal)
        if (mode === 'json') {
          if (!options.getJsonAlbums) throw new Error('本地专辑查询不可用')
          const album = options
            .getJsonAlbums()
            .find((item) =>
              'albumId' in selection
                ? item.id === selection.albumId
                : item.tracks.some((track) => track.id === selection.trackId)
            )
          if (!album?.id) throw new Error('这张专辑已不在本地音乐库中，请重新搜索')
          return { mode, albumId: album.id }
        }
        if (!options.api.queryCollections) throw new Error('数据库分类查询不可用')
        const page = await options.api.queryCollections('albums', {
          ...('albumId' in selection
            ? { albumId: selection.albumId }
            : { ids: [selection.trackId] }),
          limit: 1
        })
        await confirmSnapshot({ libraryRevision: page.revision }, signal)
        if (!page.items[0]) throw new Error('这张专辑已不在本地音乐库中，请重新搜索')
        return { mode, albumId: page.items[0].id }
      }, signal),
    /** Local-only streaming search retains library insertion order and excludes
     * filename matching, unlike the unified preferred/lossless ordering. */
    searchLocal: (query: string, limit: number, offset: number, signal?: AbortSignal) =>
      searchPage(query, limit, offset, signal, false),
    invalidate(revision: number) {
      minimumRevision = Math.max(minimumRevision, revision)
    },
    dispose() {
      disposed = true
      pending?.reject(cancelled())
      pending = null
    },
    get state() {
      return { active, pending: pending ? 1 : 0 }
    }
  }
}
