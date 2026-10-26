import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import type { TrackData } from '../../shared/track.ts'
import type { NetworkEntry } from '../../shared/networkSources.ts'
import type {
  CoreMusicSearchQuery,
  CoreMusicSearchPage,
  CoreCollectionSearchQuery
} from '../../shared/coreSearch.ts'
import type { CoreRecordingVersions } from '../playlists/recordingVersions.ts'
import { createUnifiedSearchSources } from '../../shared/musicSearchSources.ts'
import {
  createUnifiedMusicSearch,
  type UnifiedSearchProvider,
  type UnifiedSearchResult,
  type UnifiedLocalSearchPage,
  type LibrarySearchSnapshot
} from '../../shared/unifiedMusicSearch.ts'
import { normalizeSearchText, getTrackSearchBlob } from '../../shared/trackSearchText.ts'
import { libraryTrack } from '../playback/libraryTrack.ts'
import { projectCoreTrack, projectCoreError } from '../projections.ts'
import { searchMusicCollections, type CollectionSearchOptions } from './collections.ts'

interface Options {
  database: Pick<LibraryDatabaseApi, 'queryTracks' | 'getMetadata' | 'queryCollections'>
  versions: Pick<CoreRecordingVersions, 'identity' | 'getRevision' | 'snapshot'>
  loadJsonLibrary?: () => Promise<{ revision: number; tracks: TrackData[] }>
  providers(): UnifiedSearchProvider[]
  playlists: CollectionSearchOptions['playlists']
  searchCollectionProvider: CollectionSearchOptions['searchProvider']
  searchProvider(
    id: string,
    query: string,
    limit: number,
    offset: number,
    signal: AbortSignal
  ): Promise<{ items: TrackData[]; total: number }>
  network: {
    revision(): number
    search(
      query: string,
      signal: AbortSignal
    ): Promise<Array<{ profileName: string; entry: NetworkEntry }>>
  }
}

/** Search orchestration lives beside playback; slow providers hold no transport lane. */
export class CoreMusicSearchService {
  private readonly options: Options
  private readonly sources: ReturnType<typeof createUnifiedSearchSources>
  private readonly search: ReturnType<typeof createUnifiedMusicSearch>
  private readonly lifetime = new AbortController()
  private readonly work = new Set<Promise<unknown>>()
  constructor(options: Options) {
    this.options = options
    this.sources = createUnifiedSearchSources(options.versions.identity, () =>
      options.versions.getRevision()
    )
    this.search = createUnifiedMusicSearch(options.versions.identity, this.sources)
  }
  /** Raw identities stay in Core for matching/repair; public pages are projections. */
  songs(
    query: CoreMusicSearchQuery,
    signal?: AbortSignal
  ): Promise<UnifiedSearchResult & { versionsRevision: number; networkRevision?: number }> {
    return this.request((current) => this.run(query, current), signal)
  }
  collections(query: CoreCollectionSearchQuery, signal?: AbortSignal) {
    return this.request(
      (current) =>
        searchMusicCollections(
          {
            ...this.options,
            searchProvider: this.options.searchCollectionProvider
          },
          query,
          current
        ),
      signal
    )
  }
  private request<T>(run: (current: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const current = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])])
    const work = run(current)
    this.work.add(work)
    void work.then(
      () => this.work.delete(work),
      () => this.work.delete(work)
    )
    return work
  }
  async page(query: CoreMusicSearchQuery, signal?: AbortSignal): Promise<CoreMusicSearchPage> {
    const result = await this.songs(query, signal)
    const variant = (item: UnifiedSearchResult['logicalItems'][number]['variants'][number]) => ({
      ...item,
      track: projectCoreTrack(item.track)
    })
    return {
      ...result,
      items: result.items.map((item) => ({ ...item, track: projectCoreTrack(item.track) })),
      logicalItems: result.logicalItems.map((item) => ({
        ...item,
        preferredTrack: projectCoreTrack(item.preferredTrack),
        variants: item.variants.map(variant)
      })),
      health: Object.fromEntries(
        Object.entries(result.health).map(([id, health]) => [
          id,
          {
            ...health,
            lastError: health.lastError ? projectCoreError(health.lastError) : null,
            playbackUrlLastError: health.playbackUrlLastError
              ? projectCoreError(health.playbackUrlLastError)
              : null
          }
        ])
      )
    }
  }
  private async run(query: CoreMusicSearchQuery, signal: AbortSignal) {
    signal.throwIfAborted()
    const versionsRevision = this.options.versions.getRevision()
    const networkRevision = query.scope === 'local' ? undefined : this.options.network.revision()
    const fence = () => {
      signal.throwIfAborted()
      if (
        versionsRevision !== this.options.versions.getRevision() ||
        (query.versionsRevision !== undefined && query.versionsRevision !== versionsRevision) ||
        (networkRevision !== undefined &&
          (networkRevision !== this.options.network.revision() ||
            (query.networkRevision !== undefined && query.networkRevision !== networkRevision)))
      )
        throw stale('音源或版本偏好已变化，请重新搜索')
    }
    fence()
    const localSource = {
      search: async (
        text: string,
        limit: number,
        offset: number
      ): Promise<UnifiedLocalSearchPage> => {
        if (!normalizeSearchText(text)) return { items: [], total: 0 }
        const unified = query.scope !== 'local'
        let page: UnifiedLocalSearchPage
        if (this.options.loadJsonLibrary) {
          const library = await this.options.loadJsonLibrary()
          if (unified)
            page = this.sources.searchUnifiedLocalPage(library.tracks, text, limit, offset)
          else {
            const q = normalizeSearchText(text)
            const items: UnifiedLocalSearchPage['items'] = []
            let total = 0
            for (const track of library.tracks) {
              if (!getTrackSearchBlob(track).includes(q)) continue
              if (total >= offset && items.length < limit)
                items.push(
                  this.sources.toSearchItem(track, {
                    sourceName: '本地音乐',
                    providerAvailable: true
                  })
                )
              total++
            }
            page = { items, total }
          }
          page.libraryRevision = library.revision
        } else {
          const preferences = this.options.versions
            .snapshot()
            .tracks.versions.flatMap((version) =>
              version.preferredSource ? [version.preferredSource] : []
            )
          const found = await this.options.database.queryTracks({
            search: text,
            ...(unified
              ? {
                  searchFileName: true,
                  sort: 'unifiedSearch' as const,
                  preferredSources: preferences
                }
              : { sort: 'playlist' as const }),
            limit,
            offset,
            contentRevision: query.contentRevision
          })
          page = {
            items: found.tracks.map((track) =>
              this.sources.toSearchItem(libraryTrack(track), {
                sourceName: '本地音乐',
                providerAvailable: true
              })
            ),
            total: found.total,
            libraryRevision: found.revision
          }
        }
        if (query.contentRevision !== undefined && query.contentRevision !== page.libraryRevision)
          throw stale('曲库在搜索期间发生变化，请重新搜索')
        fence()
        return { ...page, preferenceRevision: versionsRevision }
      },
      confirm: async (page: LibrarySearchSnapshot) => {
        fence()
        if (page.libraryRevision === undefined) return
        const revision = this.options.loadJsonLibrary
          ? (await this.options.loadJsonLibrary()).revision
          : (await this.options.database.getMetadata()).revision
        if (revision !== page.libraryRevision) throw stale('曲库在搜索期间发生变化，请重新搜索')
        fence()
      }
    }
    const text = query.query.trim()
    if (query.scope === 'local') {
      const page = await localSource.search(text, query.limit ?? 30, query.offset ?? 0)
      await localSource.confirm(page)
      return {
        items: page.items,
        logicalItems: this.options.versions.identity.buildLogicalTracks(page.items),
        health: {},
        total: page.total,
        hasMore: page.total > (query.offset ?? 0) + (query.limit ?? 30),
        libraryRevision: page.libraryRevision,
        versionsRevision,
        ...(!this.options.loadJsonLibrary && page.libraryRevision !== undefined
          ? {
              playbackQuery: {
                search: text,
                sort: 'playlist' as const,
                contentRevision: page.libraryRevision
              }
            }
          : {})
      }
    }
    const networkEntries = text ? await this.options.network.search(text, signal) : []
    fence()
    const result = await this.search.unifiedSearchSongs({
      query: text,
      limit: query.limit,
      offset: query.offset,
      localTracks: [],
      localSource,
      signal,
      networkEntries,
      providers: this.options.providers(),
      searchProviderSongs: (id, keywords, limit = 30, offset = 0) =>
        this.options.searchProvider(id, keywords, limit, offset, signal)
    })
    fence()
    return {
      ...result,
      versionsRevision,
      ...(networkRevision !== undefined ? { networkRevision } : {})
    }
  }
  async shutdown(): Promise<void> {
    this.lifetime.abort(new Error('Core search shutting down'))
    await Promise.allSettled([...this.work])
  }
}
function stale(message: string) {
  return Object.assign(new Error(message), { code: 'STALE_REVISION' })
}
