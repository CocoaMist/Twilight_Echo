import type { LibrarySelectionRequest } from './librarySelection.ts'
import type {
  LibraryLoudnessResult,
  LoudnessBatchItem,
  LoudnessBatchStatus
} from './libraryLoudness.ts'

export interface CoreLoudnessPlanRequest {
  selection: LibrarySelectionRequest
  mode: 'track' | 'album'
}
export interface CoreLoudnessState {
  id: string
  libraryRevision: number
  groups: number
  tracks: number
  skipped: number
  status: LoudnessBatchStatus
}
export interface CoreLoudnessPage {
  id: string
  offset: number
  total: number
  items: Array<Omit<LoudnessBatchItem, 'id'> & { index: number }>
}
export type CoreLoudnessResult = Omit<LibraryLoudnessResult, 'id'> & { index: number }
