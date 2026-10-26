import type {
  DuplicateCandidate,
  DuplicateConfidence,
  DuplicateEvidenceKind
} from './duplicateDetection.ts'

export interface CoreDuplicatesStatus {
  id: string
  revision: number | null
  state: 'loading' | 'inspecting' | 'completed' | 'cancelled' | 'failed'
  candidates: number
  groups: number
  unavailable: number
  error?: string
}
export interface CoreDuplicateGroup {
  index: number
  kind: DuplicateEvidenceKind
  confidence: DuplicateConfidence
  total: number
  action: 'mergeSuggestion' | 'mark'
}
export type CoreDuplicateItem = Omit<
  DuplicateCandidate,
  'filePath' | 'contentHash' | 'audioFingerprint'
> & { fileName: string }
export interface CoreDuplicatePage<T> {
  id: string
  revision: number
  offset: number
  total: number
  items: T[]
}
export interface CoreDuplicatePageQuery {
  id: string
  offset?: number
  limit?: number
}
