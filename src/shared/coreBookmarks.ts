import type { PlaybackBookmark } from './playbackBookmarks.ts'

/** Local path/sub-track keys stay private; callers address the bookmark ID. */
export type CoreBookmark = Omit<PlaybackBookmark, 'trackKey'>
export interface CoreBookmarkCurrent {
  trackId: string
  occurrenceId: string | null
}
export interface CoreBookmarksState {
  revision: number
  longTrackResumeSeconds: number
  current: CoreBookmarkCurrent | null
  resumeOffer: CoreBookmark | null
  error: string | null
}
export interface CoreBookmarksQuery {
  revision: number
  scope: 'all' | 'current'
  offset?: number
  limit?: number
}
export interface CoreBookmarksPage {
  revision: number
  total: number
  offset: number
  items: CoreBookmark[]
}
export type CoreBookmarkEdit =
  | { kind: 'addCurrent'; current: CoreBookmarkCurrent; label?: string }
  | { kind: 'remove'; id: string }
  | { kind: 'rename'; id: string; label: string }
  | { kind: 'threshold'; seconds: number }
  | { kind: 'dismissOffer'; current: CoreBookmarkCurrent }
export interface CoreBookmarkMutation {
  revision: number
  edit: CoreBookmarkEdit
}
