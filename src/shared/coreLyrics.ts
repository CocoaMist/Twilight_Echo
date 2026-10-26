import type {
  LyricTrackOverride,
  LyricsManagementDocument,
  ManagedLyricsProjection
} from './lyricsManagement.ts'

export type CoreLyricsPreferences = Pick<
  LyricsManagementDocument,
  'globalOffsetMs' | 'showOriginal' | 'showTranslation' | 'showRomanization'
>
export type CoreLyricPatch = Partial<Omit<LyricTrackOverride, 'updatedAt'>>
export interface CoreLyricsCurrent {
  trackId: string
  occurrenceId: string | null
}
export interface CoreLyricsState {
  revision: number
  contentRevision: number
  preferences: CoreLyricsPreferences
  current: CoreLyricsCurrent | null
  loadState: { trackId: string; status: 'idle' | 'loading' | 'ready' | 'empty' | 'failed' }
  error: string | null
}
export interface CoreLyricsContent {
  revision: number
  contentRevision: number
  current: CoreLyricsCurrent | null
  automatic: ManagedLyricsProjection | null
  effective: ManagedLyricsProjection | null
  override: LyricTrackOverride | null
  offsetSeconds: number
}
export interface CoreLyricsMutation {
  revision: number
  edit:
    | { kind: 'globalOffset'; offsetMs: number }
    | { kind: 'visibility'; patch: Partial<Omit<CoreLyricsPreferences, 'globalOffsetMs'>> }
    | { kind: 'track'; trackId: string; patch: CoreLyricPatch }
}
