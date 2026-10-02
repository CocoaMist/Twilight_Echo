import { FileAnalysisManager } from '../audio/fileAnalysisManager.ts'

import {
  BPM_ANALYSIS_ALGORITHM_VERSION,
  BpmAnalysisCache,
  type BpmAnalysisResult,
  type BpmAnalysisCacheIdentity
} from './bpmCache.ts'

export interface BpmAnalysisRequest {
  trackId: string
  filePath: string
  referenceBpm?: number
  priority?: number
}

export type BpmAnalysisRequestResult =
  | { status: 'completed'; analysis: BpmAnalysisResult }
  | { status: 'cached'; analysis: BpmAnalysisResult }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }

export interface BpmAnalysisManagerOptions {
  cache: BpmAnalysisCache
  analyzeFile: (request: BpmAnalysisRequest) => Promise<BpmAnalysisResult | null>
  cancelFile?: (filePath?: string) => void
  failureCooldownMs?: number
  now?: () => number
  onComplete?: (event: { trackId: string; filePath: string; analysis: BpmAnalysisResult }) => void
}

export class BpmAnalysisManager extends FileAnalysisManager<
  BpmAnalysisRequest,
  BpmAnalysisResult,
  BpmAnalysisCacheIdentity
> {
  constructor(options: BpmAnalysisManagerOptions) {
    super({
      ...options,
      buildIdentity: (request, size, mtimeMs) => ({
        filePath: request.filePath,
        size,
        mtimeMs,
        algorithmVersion: BPM_ANALYSIS_ALGORITHM_VERSION
      })
    })
  }
}
