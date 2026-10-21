import type { Track } from '../types/music'
import { getTrackSource } from './logicalTrackModel.ts'

export interface PlaylistSourceSummaryInput {
  trackIds?: string[]
  trackSnapshots?: Record<string, Track>
}

export interface PlaylistProviderSourceCount {
  source: string
  count: number
}

export interface PlaylistSourceSummary {
  total: number
  local: number
  provider: number
  providers: PlaylistProviderSourceCount[]
  additionalProviders?: number
}

export function summarizePlaylistSources(input: PlaylistSourceSummaryInput): PlaylistSourceSummary {
  const sourceCounts = new Map<string, number>()
  const trackIds = input.trackIds ?? []

  for (const trackId of trackIds) {
    const snapshot = input.trackSnapshots?.[trackId]
    const source = getTrackSource(snapshot ?? { id: trackId })
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1)
  }

  const local = sourceCounts.get('local') ?? 0
  const providers = Array.from(sourceCounts.entries())
    .filter(([source]) => source !== 'local')
    .map(([source, count]) => ({ source, count }))
    .sort((left, right) => left.source.localeCompare(right.source, 'en'))
  const provider = providers.reduce((total, item) => total + item.count, 0)

  return {
    total: trackIds.length,
    local,
    provider,
    providers
  }
}

export function formatPlaylistSourceSummary(summary: PlaylistSourceSummary): string {
  if (summary.total === 0) return ''

  const parts: string[] = []
  if (summary.local > 0) parts.push(`本地 ${summary.local}`)
  if (summary.provider > 0) parts.push(`Provider ${summary.provider}`)
  if (summary.providers.length > 0) {
    const labels = summary.providers.map((provider) => provider.source).join('/')
    parts.push(
      summary.additionalProviders
        ? `${labels} 等 ${summary.providers.length + summary.additionalProviders} 个音源`
        : labels
    )
  }

  return parts.join(' · ')
}
