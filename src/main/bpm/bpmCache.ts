import { FileAnalysisCache } from '../audio/fileAnalysisCache.ts'
import type { BpmAnalysisResult, BpmTempoSegment } from '../../shared/audioEngineTypes.ts'

export type { BpmAnalysisResult, BpmTempoSegment }

export const BPM_ANALYSIS_ALGORITHM_VERSION = 1

export interface BpmAnalysisCacheIdentity {
  filePath: string
  size: number
  mtimeMs: number
  algorithmVersion?: number
}

export function buildBpmAnalysisCacheKey(identity: BpmAnalysisCacheIdentity): string {
  const algorithmVersion = identity.algorithmVersion ?? BPM_ANALYSIS_ALGORITHM_VERSION
  return [
    identity.filePath.toLowerCase(),
    Math.floor(identity.size),
    Math.floor(identity.mtimeMs),
    algorithmVersion
  ].join('|')
}

export class BpmAnalysisCache extends FileAnalysisCache<
  BpmAnalysisCacheIdentity,
  BpmAnalysisResult
> {
  constructor(cachePath: string) {
    super(cachePath, {
      key: buildBpmAnalysisCacheKey,
      isAnalysis: isBpmAnalysisResult
    })
  }
}

export function isBpmAnalysisResult(value: unknown): value is BpmAnalysisResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<BpmAnalysisResult>
  return (
    result.source === 'analyzed' &&
    typeof result.bpm === 'number' &&
    Number.isFinite(result.bpm) &&
    typeof result.confidence === 'number' &&
    Number.isFinite(result.confidence) &&
    typeof result.analyzedAt === 'string' &&
    typeof result.algorithmVersion === 'number'
  )
}
