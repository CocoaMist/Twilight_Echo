import { FileAnalysisCache } from './fileAnalysisCache.ts'
import type { LoudnessAnalysisResult } from '../../shared/audioEngineTypes.ts'
import { LIBRARY_LOUDNESS_ALGORITHM_VERSION } from '../../shared/libraryLoudness.ts'

export type { LoudnessAnalysisResult }

export const LOUDNESS_ANALYSIS_ALGORITHM_VERSION = LIBRARY_LOUDNESS_ALGORITHM_VERSION
export const LOUDNORM_DEFAULT_TARGET_LUFS = -23.0
export const LOUDNORM_DEFAULT_TRUE_PEAK_CEILING_DB = -1.0
/** Soft cap on cached identities; oldest analyzedAt entries are evicted first. */
export const LOUDNESS_ANALYSIS_CACHE_MAX_ENTRIES = 512

export interface LoudnessAnalysisCacheIdentity {
  filePath: string
  size: number
  mtimeMs: number
  algorithmVersion?: number
  targetLufs?: number
  truePeakCeilingDb?: number
}

export function buildLoudnessAnalysisCacheKey(identity: LoudnessAnalysisCacheIdentity): string {
  const algorithmVersion = identity.algorithmVersion ?? LOUDNESS_ANALYSIS_ALGORITHM_VERSION
  const target = identity.targetLufs ?? LOUDNORM_DEFAULT_TARGET_LUFS
  const ceiling = identity.truePeakCeilingDb ?? LOUDNORM_DEFAULT_TRUE_PEAK_CEILING_DB
  return [
    identity.filePath.toLowerCase(),
    Math.floor(identity.size),
    Math.floor(identity.mtimeMs),
    algorithmVersion,
    target.toFixed(2),
    ceiling.toFixed(2)
  ].join('|')
}

export class LoudnessAnalysisCache extends FileAnalysisCache<
  LoudnessAnalysisCacheIdentity,
  LoudnessAnalysisResult
> {
  constructor(cachePath: string, maxEntries = LOUDNESS_ANALYSIS_CACHE_MAX_ENTRIES) {
    const limit = Math.max(1, maxEntries)
    super(cachePath, {
      key: buildLoudnessAnalysisCacheKey,
      isAnalysis: (value, identity): value is LoudnessAnalysisResult =>
        isLoudnessAnalysisResult(value) &&
        value.algorithmVersion ===
          (identity.algorithmVersion ?? LOUDNESS_ANALYSIS_ALGORITHM_VERSION) &&
        value.available !== false,
      prune: (entries) => pruneLoudnessCacheEntries(entries, limit)
    })
  }

  async getEntryCount(): Promise<number> {
    return await this.countEntries()
  }
}

/** Evict oldest analyzedAt entries until at or under maxEntries. */
export function pruneLoudnessCacheEntries(
  entries: Record<string, LoudnessAnalysisResult>,
  maxEntries: number
): void {
  const keys = Object.keys(entries)
  if (keys.length <= maxEntries) return
  const ordered = keys.sort((a, b) => {
    const aAt = Date.parse(entries[a]?.analyzedAt ?? '') || 0
    const bAt = Date.parse(entries[b]?.analyzedAt ?? '') || 0
    return aAt - bAt
  })
  const removeCount = keys.length - maxEntries
  for (let i = 0; i < removeCount; i += 1) {
    delete entries[ordered[i]!]
  }
}

export function isLoudnessAnalysisResult(value: unknown): value is LoudnessAnalysisResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<LoudnessAnalysisResult>
  return (
    result.source === 'analyzed' &&
    typeof result.integratedLufs === 'number' &&
    Number.isFinite(result.integratedLufs) &&
    typeof result.truePeakDb === 'number' &&
    Number.isFinite(result.truePeakDb) &&
    typeof result.analyzedAt === 'string' &&
    typeof result.algorithmVersion === 'number'
  )
}
