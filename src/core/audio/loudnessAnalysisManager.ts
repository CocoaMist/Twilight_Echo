import { FileAnalysisManager } from './fileAnalysisManager.ts'

import {
  LOUDNESS_ANALYSIS_ALGORITHM_VERSION,
  LOUDNORM_DEFAULT_TARGET_LUFS,
  LOUDNORM_DEFAULT_TRUE_PEAK_CEILING_DB,
  LoudnessAnalysisCache,
  type LoudnessAnalysisCacheIdentity,
  type LoudnessAnalysisResult
} from './loudnessCache.ts'

export interface LoudnessAnalysisRequest {
  trackId: string
  filePath: string
  targetLufs?: number
  truePeakCeilingDb?: number
  priority?: number
}

export type LoudnessAnalysisRequestResult =
  | { status: 'completed'; analysis: LoudnessAnalysisResult }
  | { status: 'cached'; analysis: LoudnessAnalysisResult }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'unavailable'; reason: string }

export interface LoudnessAnalysisManagerOptions {
  cache: LoudnessAnalysisCache
  analyzeFile: (request: LoudnessAnalysisRequest) => Promise<LoudnessAnalysisResult | null>
  cancelFile?: (filePath?: string) => void
  failureCooldownMs?: number
  now?: () => number
  onComplete?: (event: {
    trackId: string
    filePath: string
    analysis: LoudnessAnalysisResult
  }) => void
}

export class LoudnessAnalysisManager extends FileAnalysisManager<
  LoudnessAnalysisRequest,
  LoudnessAnalysisResult,
  LoudnessAnalysisCacheIdentity,
  { status: 'unavailable'; reason: string }
> {
  constructor(options: LoudnessAnalysisManagerOptions) {
    super({
      ...options,
      buildIdentity,
      rejectAnalysis: (analysis) =>
        analysis.available === false
          ? { status: 'unavailable', reason: 'ebur128-unavailable' }
          : null
    })
  }
  peekCached(request: LoudnessAnalysisRequest): Promise<LoudnessAnalysisResult | null> {
    return this.peekCachedAnalysis(request)
  }
  clearFailures(): void {
    this.resetFailures()
  }
}

function buildIdentity(
  request: LoudnessAnalysisRequest,
  size: number,
  mtimeMs: number
): LoudnessAnalysisCacheIdentity {
  return {
    filePath: request.filePath,
    size,
    mtimeMs,
    algorithmVersion: LOUDNESS_ANALYSIS_ALGORITHM_VERSION,
    targetLufs: request.targetLufs ?? LOUDNORM_DEFAULT_TARGET_LUFS,
    truePeakCeilingDb: request.truePeakCeilingDb ?? LOUDNORM_DEFAULT_TRUE_PEAK_CEILING_DB
  }
}
