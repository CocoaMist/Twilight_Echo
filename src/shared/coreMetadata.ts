import type { CoreTrackView } from './coreViews.ts'
import type { MetadataMatchConfidence } from './musicMetadataMatching.ts'

export type LibraryMetadataEnrichmentState =
  | 'idle'
  | 'enriching'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface LibraryMetadataEnrichmentStatus {
  state: LibraryMetadataEnrichmentState
  total: number
  queued: number
  active: number
  completed: number
  failed: number
  skipped: number
  error: string
}

export interface CoreMetadataCandidates {
  token: string
  id: string
  version: number
  items: Array<{
    track: CoreTrackView
    confidence: MetadataMatchConfidence
    score: number
    fills: { cover: boolean; lyrics: boolean; translatedLyrics: boolean; metadata: boolean }
  }>
}
