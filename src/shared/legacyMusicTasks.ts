import type { MusicAlbum } from './rhineMusic.ts'
import type { IntroductionResult, CreditsResult } from './rhineMetadata.ts'

export type LegacyMusicLookup = 'introductions' | 'credits' | 'enrich'
export const legacyMusicLookup = (value: unknown): value is LegacyMusicLookup =>
  ['introductions', 'credits', 'enrich'].includes(String(value))

/** Core-only seeds; views supply album IDs, never these library snapshots. */
export interface LegacyMusicTaskSeed {
  album: MusicAlbum
  collectionId: string
  contentRevision: number
  force: boolean
}
export interface LegacyMusicTaskRef {
  pluginId: string
  batchId: string
  albumId: string
  operation: LegacyMusicLookup
  title: string
}
export interface LegacyMusicTaskWork extends LegacyMusicTaskRef {
  album: MusicAlbum
  collectionId: string
  force: boolean
  contact: string
}
export type LegacyMusicLookupResult =
  | { operation: 'introductions'; value: IntroductionResult }
  | { operation: 'credits'; value: CreditsResult }
  | { operation: 'enrich'; value: Partial<MusicAlbum> }
export interface LegacyMusicTaskStatus {
  batchId: string
  state: 'staging' | 'published' | 'cancelled' | 'abandoned'
  running: boolean
  total: number
  completed: number
  updated: number
  notFound: number
  failed: number
  needsReview: number
  blocked: number
  retrying: number
  cancelled: number
  currentAlbum: string
  error: string
  nextAttemptAt: number | null
}
export interface LegacyMusicTaskDatabaseApi {
  legacyMusicBatchBegin(
    request: {
      id: string
      pluginId: string
      operation: LegacyMusicLookup
      expected: number
      documentRevision: number
    },
    now: number
  ): Promise<LegacyMusicTaskStatus>
  legacyMusicBatchStage(batchId: string, entries: LegacyMusicTaskSeed[], now: number): Promise<void>
  legacyMusicBatchPublish(batchId: string, now: number): Promise<LegacyMusicTaskStatus>
  legacyMusicTaskStatus(
    pluginId: string,
    operation: LegacyMusicLookup
  ): Promise<LegacyMusicTaskStatus | null>
  legacyMusicBatchCancel(
    pluginId: string,
    operation: LegacyMusicLookup,
    now: number
  ): Promise<LegacyMusicTaskStatus | null>
}
export interface LegacyMusicTaskClient {
  startLegacyMusic(
    pluginId: string,
    operation: LegacyMusicLookup,
    documentRevision: number,
    entries: LegacyMusicTaskSeed[]
  ): Promise<LegacyMusicTaskStatus>
  legacyMusicStatus(
    pluginId: string
  ): Promise<Partial<Record<LegacyMusicLookup, LegacyMusicTaskStatus | null>>>
  cancelLegacyMusic(
    pluginId: string,
    operation: LegacyMusicLookup
  ): Promise<LegacyMusicTaskStatus | null>
}
