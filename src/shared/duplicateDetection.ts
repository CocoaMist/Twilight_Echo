import type { CueRange } from './cue.ts'

/** Evidence is ordered from exact source identity to metadata-only similarity. */
export type DuplicateEvidenceKind =
  | 'path'
  | 'contentHash'
  | 'audioFingerprint'
  | 'metadataCandidate'
  | 'logicalTrack'

/**
 * A fingerprint can only promote a match above metadata review when the scanner can prove that it
 * came from an acoustic algorithm run over audio samples. Older records omit this field and are
 * deliberately treated as metadata-only candidates.
 */
export type AcousticFingerprintEvidence = 'verifiedAcoustic' | 'metadataCandidate'

export interface AcousticFingerprint {
  /** A versioned acoustic algorithm, for example `chromaprint-v1`. */
  algorithm: string
  value: string
  /** Defaults to `metadataCandidate` for legacy or unverifiable persisted values. */
  evidence?: AcousticFingerprintEvidence
}

export interface DuplicateCandidate {
  id: string
  filePath: string
  /** A container path/hash is exact evidence only within the same logical source segment. */
  subTrack?: string
  cueRange?: CueRange
  title: string
  artist: string
  album: string
  duration: number
  size: number
  sampleRate?: number
  bitrate?: number
  format?: string
  /** A SHA-256 of the complete media file, when it was already persisted by a scanner. */
  contentHash?: string
  /** A real, versioned acoustic fingerprint. Technical format metadata is not a fingerprint. */
  audioFingerprint?: AcousticFingerprint
}

export type DuplicateConfidence = 'exact' | 'probable' | 'possible'

export interface DuplicateGroup {
  key: string
  kind: DuplicateEvidenceKind
  confidence: DuplicateConfidence
  items: DuplicateCandidate[]
}

/**
 * A presentation-only recommendation. It never writes a file, edits metadata, or changes a
 * library entry. A future mutation flow must require an explicit user selection and confirmation.
 */
export interface DuplicateActionPlan {
  action: 'mark' | 'exclude' | 'mergeSuggestion'
  group: DuplicateGroup
  keepId: null
  affectedIds: []
  requiresConfirmation: true
  destructive: false
}

export interface DuplicateDetectionResult {
  groups: DuplicateGroup[]
  suggestions: DuplicateActionPlan[]
  /** Candidate IDs whose full-file hash could not be read; other evidence remains available. */
  contentHashUnavailableIds: string[]
}

/** The renderer can inspect duplicate candidates, but it cannot mutate or merge library records. */
export interface DuplicateDetectionReadApi {
  detectDuplicates(): Promise<DuplicateDetectionResult>
}

export function duplicateGroupLabel(group: DuplicateGroup): string {
  const evidence = {
    path: '相同路径',
    contentHash: '相同文件 hash',
    audioFingerprint: '相同音频指纹',
    metadataCandidate: '相近元数据',
    logicalTrack: '相同曲目'
  }[group.kind]
  const confidence = { exact: '精确', probable: '较高', possible: '待确认' }[group.confidence]
  return `${evidence} · ${confidence}置信度`
}
