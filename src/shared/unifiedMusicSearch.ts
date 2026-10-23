import type { TrackData as Track, TrackSource } from './track.ts'
import type { NetworkEntry } from './networkSources.ts'
import type { LibraryQuery } from './libraryDatabase.ts'
import {
  getTrackSource,
  type LogicalTrack,
  type SourceVariant,
  type LogicalTrackModel
} from './logicalTrackModel.ts'
import type { UnifiedSearchSources } from './musicSearchSources.ts'

export interface UnifiedSearchProvider {
  id: string
  name: string
  capabilities: string[]
  supportedMethods?: readonly string[]
  available?: boolean
  health?: UnifiedSearchProviderReliabilityInput
}

export interface UnifiedSearchProviderReliabilityInput {
  available?: boolean
  pluginStatus?: string
  successRate?: number
  methodStats?: Record<string, { successRate?: number; lastError?: string | null } | undefined>
  lastError?: string | null
  lastCheckedAt?: string | null
}

export interface UnifiedSearchProviderHealth {
  providerId: string
  providerName: string
  available: boolean
  searchable: boolean
  resultCount: number
  lastError: string | null
  pluginStatus: string | null
  successRate: number | null
  playbackUrlSuccessRate: number | null
  playbackUrlLastError: string | null
  lastCheckedAt: string | null
}

export interface UnifiedSearchTrackItem {
  kind: 'track'
  track: Track
  source: TrackSource
  sourceName: string
  local: boolean
  lossless: boolean
  providerAvailable: boolean
  providerReliability: number
}

export type LogicalMusicVariant = SourceVariant
export type LogicalMusicItem = LogicalTrack

export interface LibrarySearchSnapshot {
  libraryRevision?: number
  preferenceRevision?: number
}
export interface UnifiedLocalSearchPage extends LibrarySearchSnapshot {
  items: UnifiedSearchTrackItem[]
  total: number
  /** Local-only results can play the complete database query, not this page. */
  playbackQuery?: LibraryQuery
}
export interface UnifiedLocalSearch {
  search(
    query: string,
    limit: number,
    offset: number,
    signal?: AbortSignal
  ): Promise<UnifiedLocalSearchPage>
  /** Slow providers must not publish a local page from an obsolete library/order. */
  confirm(page: LibrarySearchSnapshot, signal?: AbortSignal): Promise<void>
}

export interface UnifiedSearchOptions {
  query: string
  localTracks: Track[]
  localSource?: UnifiedLocalSearch
  signal?: AbortSignal
  networkEntries?: Array<{ profileName: string; entry: NetworkEntry }>
  providers: UnifiedSearchProvider[]
  limit?: number
  offset?: number
  searchProviderSongs: (
    providerId: string,
    keywords: string,
    limit?: number,
    offset?: number
  ) => Promise<{ items: Track[]; total: number }>
}

export interface UnifiedSearchResult {
  items: UnifiedSearchTrackItem[]
  logicalItems: LogicalMusicItem[]
  health: Record<string, UnifiedSearchProviderHealth>
  total: number
  hasMore?: boolean
  libraryRevision?: number
}

/** Shared algorithm; the host owns providers, storage and recording preferences. */
export function createUnifiedMusicSearch(
  identity: LogicalTrackModel,
  sources: UnifiedSearchSources
) {
  const { buildLogicalTracks, clampReliability } = identity
  const { compareSearchItems, searchUnifiedLocalPage, searchUnifiedNetworkPage, toSearchItem } =
    sources
  async function unifiedSearchSongs(options: UnifiedSearchOptions): Promise<UnifiedSearchResult> {
    const query = options.query.trim()
    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 30) || 30))
    const offset = Math.max(0, Math.trunc(options.offset ?? 0) || 0)
    if (!query) return { items: [], logicalItems: [], health: {}, total: 0, hasMore: false }
    const local: UnifiedLocalSearchPage = options.localSource
      ? await options.localSource.search(query, limit, offset, options.signal)
      : searchUnifiedLocalPage(options.localTracks, query, limit, offset)
    if (options.signal?.aborted) throw new DOMException('Search was cancelled', 'AbortError')
    const network = searchUnifiedNetworkPage(options.networkEntries ?? [], query, limit, offset)
    const health: Record<string, UnifiedSearchProviderHealth> = {}
    let total = local.total + network.total
    let hasMore = local.total > offset + limit || network.total > offset + limit

    const providerItems = (
      await Promise.all(
        options.providers.map(async (provider) => {
          const providerAvailable =
            provider.available !== false && provider.health?.available !== false
          const providerReliability = getProviderReliability(provider)
          const searchable = provider.capabilities.includes('search')
          const playbackUrlHealth = provider.health?.methodStats?.getPlaybackUrl
          const baseHealth: UnifiedSearchProviderHealth = {
            providerId: provider.id,
            providerName: provider.name,
            available: providerAvailable,
            searchable,
            resultCount: 0,
            lastError: provider.health?.lastError ?? null,
            pluginStatus: provider.health?.pluginStatus ?? null,
            successRate:
              typeof provider.health?.successRate === 'number' ? provider.health.successRate : null,
            playbackUrlSuccessRate:
              typeof playbackUrlHealth?.successRate === 'number'
                ? playbackUrlHealth.successRate
                : null,
            playbackUrlLastError: playbackUrlHealth?.lastError ?? null,
            lastCheckedAt: provider.health?.lastCheckedAt ?? null
          }
          health[provider.id] = baseHealth
          if (!query || !searchable || !providerAvailable) return []

          try {
            const result = await options.searchProviderSongs(provider.id, query, limit, offset)
            baseHealth.resultCount = result.items.length
            total += result.total
            hasMore ||= result.total > offset + limit
            return result.items.slice(0, limit).map((track) =>
              toSearchItem(track, {
                sourceName: provider.name,
                providerAvailable: true,
                providerReliability,
                source: provider.id
              })
            )
          } catch (error) {
            baseHealth.available = false
            baseHealth.lastError = error instanceof Error ? error.message : String(error)
            return []
          }
        })
      )
    ).flat()

    await options.localSource?.confirm(local, options.signal)
    if (options.signal?.aborted) throw new DOMException('Search was cancelled', 'AbortError')

    const items = [...local.items, ...network.items, ...providerItems].sort(compareSearchItems)
    return {
      items,
      logicalItems: buildLogicalMusicItemsFromSearchItems(items),
      health,
      total,
      hasMore,
      ...('libraryRevision' in local ? { libraryRevision: local.libraryRevision } : {})
    }
  }

  function buildLogicalMusicItems(tracks: Track[]): LogicalMusicItem[] {
    return buildLogicalMusicItemsFromSearchItems(
      tracks.map((track) =>
        toSearchItem(track, {
          sourceName: getTrackSource(track) === 'local' ? '本地音乐' : getTrackSource(track),
          providerAvailable: true
        })
      )
    )
  }

  function buildLogicalMusicItemsFromSearchItems(
    searchItems: UnifiedSearchTrackItem[]
  ): LogicalMusicItem[] {
    return buildLogicalTracks(searchItems)
  }

  function getProviderReliability(provider: UnifiedSearchProvider): number {
    const playbackUrlSuccessRate = provider.health?.methodStats?.getPlaybackUrl?.successRate
    if (typeof playbackUrlSuccessRate === 'number') return clampReliability(playbackUrlSuccessRate)
    if (typeof provider.health?.successRate === 'number')
      return clampReliability(provider.health.successRate)
    return provider.available === false || provider.health?.available === false ? 0 : 1
  }

  return { unifiedSearchSongs, buildLogicalMusicItems }
}
