import type { TrackData as Track } from './track.ts'
import type { ListeningTrackDayStat } from './listeningStatsHistory.ts'

export interface ListeningTrackStat {
  seconds: number
  plays: number
  lastPlayed: number
  skips: number
  completions: number
  daily?: Record<string, ListeningTrackDayStat>
  undatedLastPlayed?: number
  title: string
  artist: string
  cover: string | null
  /** Durable remote cover origin for re-granting expired twilight-media handles. */
  coverSource?: string | null
  sourceIds?: ListeningTrackSourceId[]
  track?: Track
}

export interface ListeningTrackSourceId {
  source: string
  trackId: string
}

export interface ListeningArtistStat {
  id: string
  name: string
  seconds: number
  plays: number
  skips: number
  completions: number
  trackCount: number
  lastPlayed: number
  cover: string | null
  coverSource?: string | null
  sourceIds: string[]
}

export interface ListeningStats {
  days: Record<string, number>
  tracks: Record<string, ListeningTrackStat>
}

export type ListeningTrackStatWithId = ListeningTrackStat & { id: string }
