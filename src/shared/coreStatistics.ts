import type { CoreStateRow } from './coreState.ts'
import type { CoreTrackView } from './coreViews.ts'
import type { ListeningStatsClearRange } from './listeningStatsHistory.ts'
import type { ListeningStatsClearPreview } from './listeningStatsHistory.ts'
import type { ListeningArtistStat, ListeningTrackSourceId } from './listeningStats.ts'
import type { summarizeRecordedTracks } from './listeningRecordedSummary.ts'

export type CoreStatisticsDomain = 'statistics-tracks' | 'statistics-days'
export interface CoreStatisticsRevision {
  tracks: number
  days: number
}
export interface CoreStatisticsCheckpoint {
  revision: CoreStatisticsRevision
  operation: {
    id: string
    batches: number
    nextBatch: number
    committed: boolean
  } | null
}
/** Private database transport. A checkpoint publishes both domains atomically;
 * incomplete stages are invisible and may be discarded after read recovery. */
export interface CoreStatisticsApi {
  coreStatisticsStatus(): Promise<CoreStatisticsCheckpoint>
  coreStatisticsBegin(
    id: string,
    revision: CoreStatisticsRevision,
    batches: number,
    replace: boolean
  ): Promise<CoreStatisticsCheckpoint>
  coreStatisticsStage(
    id: string,
    batch: number,
    domain: CoreStatisticsDomain,
    rows: CoreStateRow[]
  ): Promise<CoreStatisticsCheckpoint>
  coreStatisticsCommit(id: string): Promise<CoreStatisticsCheckpoint>
  coreStatisticsAbort(id: string): Promise<void>
}

export type CoreStatisticsSort = 'recent' | 'plays' | 'seconds'
export interface CoreStatisticsQuery {
  sort?: CoreStatisticsSort
  offset?: number
  limit?: number
  revision?: number
}
export interface CoreStatisticsTrackView {
  cover: string | null
  sourceIds: ListeningTrackSourceId[]
  id: string
  seconds: number
  plays: number
  lastPlayed: number
  skips: number
  completions: number
  title: string
  artist: string
  track: CoreTrackView | null
}
export interface CoreStatisticsOverview extends CoreStatisticsSummary {
  recorded: ReturnType<typeof summarizeRecordedTracks>
  artists: Array<ListeningArtistStat & { providerId: string | null }>
  history: { mode: 'json' | 'sqlite' | null; ready: boolean; pending: boolean; revision: number | null; error: string }
}
export interface CoreStatisticsPreviewQuery {
  range: ListeningStatsClearRange
  revision: number
}
export type CoreStatisticsClearPreview = ListeningStatsClearPreview & { revision: number }
export interface CoreStatisticsPage {
  revision: number
  total: number
  offset: number
  items: CoreStatisticsTrackView[]
}
export interface CoreStatisticsSummary {
  revision: number
  trackCount: number
  days: Record<string, number>
  persistence: { dirty: boolean; failureCount: number; error: string | null }
}
export interface CoreStatisticsClear {
  range: ListeningStatsClearRange
  revision: number
}
