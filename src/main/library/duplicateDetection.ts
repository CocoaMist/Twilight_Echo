import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { normalize } from 'node:path'
import { normalizeCueRange } from '../../shared/cue.ts'
import type {
  AcousticFingerprint,
  DuplicateActionPlan,
  DuplicateCandidate,
  DuplicateDetectionResult,
  DuplicateEvidenceKind,
  DuplicateGroup
} from '../../shared/duplicateDetection.ts'

export type {
  AcousticFingerprint,
  DuplicateActionPlan,
  DuplicateCandidate,
  DuplicateDetectionResult,
  DuplicateEvidenceKind,
  DuplicateGroup
}

const EVIDENCE_ORDER: Record<DuplicateEvidenceKind, number> = {
  path: 0,
  contentHash: 1,
  audioFingerprint: 2,
  metadataCandidate: 3,
  logicalTrack: 4
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const MAX_FINGERPRINT_ALGORITHM_LENGTH = 96
const MAX_FINGERPRINT_VALUE_LENGTH = 16_384

export interface DuplicateDetectionOptions {
  /**
   * Reads an already authorized local media file. Returning null means the file cannot contribute
   * full-file hash evidence, but lower-confidence checks may still classify it.
   */
  contentHashForPath?: (filePath: string) => Promise<string | null>
  hashConcurrency?: number
}

/**
 * Streams a file into SHA-256 rather than materializing media bytes in Electron's main process.
 * This function only opens the source for reading.
 */
export async function contentHash(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

/**
 * Produces a deterministic, read-only detection result. Full-file hashing is attempted only for
 * equal-size candidates that survived the canonical-path pass, with bounded concurrency.
 */
export async function detectDuplicates(
  items: readonly DuplicateCandidate[],
  options: DuplicateDetectionOptions = {}
): Promise<DuplicateDetectionResult> {
  const remaining = new Set(items.filter(isDuplicateCandidate))
  const groups: DuplicateGroup[] = []

  appendGroups(groups, remaining, 'path', canonicalPathKey)

  const { hashes, unavailableIds } = await resolveContentHashes(
    Array.from(remaining),
    options.contentHashForPath,
    options.hashConcurrency ?? 4
  )
  appendGroups(groups, remaining, 'contentHash', (item) =>
    sourceEvidenceKey(hashes.get(item), item)
  )
  appendGroups(groups, remaining, 'audioFingerprint', verifiedAudioFingerprintKey)
  appendGroups(groups, remaining, 'metadataCandidate', metadataCandidateKey)
  appendGroups(groups, remaining, 'logicalTrack', logicalTrackKey)

  const orderedGroups = sortGroups(groups)
  return {
    groups: orderedGroups,
    suggestions: createDuplicateActionPlans(orderedGroups),
    contentHashUnavailableIds: Array.from(unavailableIds).sort((left, right) =>
      left.localeCompare(right)
    )
  }
}

/**
 * Synchronous helper for callers that already have hashes. It intentionally performs no file I/O.
 */
export function groupDuplicates(
  items: readonly DuplicateCandidate[],
  hashForPath?: (filePath: string) => string
): DuplicateGroup[] {
  const remaining = new Set(items.filter(isDuplicateCandidate))
  const groups: DuplicateGroup[] = []
  appendGroups(groups, remaining, 'path', canonicalPathKey)
  appendGroups(groups, remaining, 'contentHash', (item) => {
    const persisted = normalizeContentHash(item.contentHash)
    return sourceEvidenceKey(persisted ?? normalizeContentHash(hashForPath?.(item.filePath)), item)
  })
  appendGroups(groups, remaining, 'audioFingerprint', verifiedAudioFingerprintKey)
  appendGroups(groups, remaining, 'metadataCandidate', metadataCandidateKey)
  appendGroups(groups, remaining, 'logicalTrack', logicalTrackKey)
  return sortGroups(groups)
}

/** Returns the normalized fingerprint payload without asserting that its provenance is acoustic. */
export function audioFingerprintKey(item: DuplicateCandidate): string {
  const fingerprint = normalizeAudioFingerprint(item.audioFingerprint)
  return fingerprint ? `${fingerprint.algorithm}\u0000${fingerprint.value}` : ''
}

/**
 * Only an explicitly verified sample-derived fingerprint is allowed to be shown as acoustic
 * evidence. A legacy `algorithm/value` pair is useful for review, but it is not proof that audio
 * samples were analysed and must not influence automatic duplicate handling.
 */
export function verifiedAudioFingerprintKey(item: DuplicateCandidate): string {
  const fingerprint = normalizeAudioFingerprint(item.audioFingerprint)
  return fingerprint?.evidence === 'verifiedAcoustic'
    ? `${fingerprint.algorithm}\u0000${fingerprint.value}`
    : ''
}

/**
 * Fingerprints whose provenance is missing, malformed, or metadata-derived stay in the same
 * review-only tier as technical metadata. The prefix preserves why the pair was presented while
 * preventing a collision with the technical metadata key format.
 */
export function metadataCandidateKey(item: DuplicateCandidate): string {
  const fingerprint = normalizeAudioFingerprint(item.audioFingerprint)
  if (fingerprint && fingerprint.evidence !== 'verifiedAcoustic') {
    return `unverified-fingerprint\u0000${fingerprint.algorithm}\u0000${fingerprint.value}`
  }
  return technicalMetadataKey(item)
}

/**
 * A technical match is deliberately separated from an acoustic fingerprint. It is a UI review
 * marker only: two unrelated files can share duration, size, format, sample rate, and bitrate.
 */
export function technicalMetadataKey(item: DuplicateCandidate): string {
  const format = normalizeLogicalField(item.format ?? '')
  if (
    !Number.isFinite(item.duration) ||
    item.duration <= 0 ||
    !Number.isFinite(item.size) ||
    item.size <= 0 ||
    !item.sampleRate ||
    !item.bitrate ||
    !format
  ) {
    return ''
  }
  return [Math.round(item.duration * 2) / 2, item.size, item.sampleRate, item.bitrate, format].join(
    '\u0000'
  )
}

/**
 * Logical matches are deliberately conservative. They are useful review markers, never automatic
 * merge recommendations, because distinct masters and recordings can share the same metadata.
 */
export function logicalTrackKey(item: DuplicateCandidate): string {
  const title = normalizeLogicalField(item.title)
  const artist = normalizeLogicalField(item.artist)
  const album = normalizeLogicalField(item.album)
  if (!title || !artist || !album || !Number.isFinite(item.duration) || item.duration <= 0)
    return ''
  return [title, artist, album, Math.round(item.duration * 2) / 2].join('\u0000')
}

export function createDuplicateActionPlans(
  groups: readonly DuplicateGroup[]
): DuplicateActionPlan[] {
  return groups.map((group) => ({
    action: group.confidence === 'exact' ? 'mergeSuggestion' : 'mark',
    group,
    // Detection must never preselect a record to retain or a destructive set to change.
    keepId: null,
    affectedIds: [],
    requiresConfirmation: true,
    destructive: false
  }))
}

export function toDuplicateCandidate(track: Record<string, unknown>): DuplicateCandidate {
  const subTrack = text(track.subTrack)
  const cueRange = normalizeCueRange(track.cueRange)
  return {
    id: text(track.id),
    filePath: text(track.filePath),
    ...(subTrack ? { subTrack } : {}),
    ...(cueRange ? { cueRange } : {}),
    title: text(track.title),
    artist: text(track.artist),
    album: text(track.album),
    duration: finiteNonNegative(track.duration),
    size: finiteNonNegative(track.size),
    sampleRate: optionalFinitePositive(track.sampleRate),
    bitrate: optionalFinitePositive(track.bitrate),
    format: optionalText(track.format),
    contentHash: normalizeContentHash(track.contentHash),
    audioFingerprint: normalizeAudioFingerprint(track.audioFingerprint)
  }
}

export function isDuplicateCandidate(item: DuplicateCandidate): boolean {
  return Boolean(item.id && item.filePath)
}

function appendGroups(
  output: DuplicateGroup[],
  remaining: Set<DuplicateCandidate>,
  kind: DuplicateEvidenceKind,
  keyFor: (item: DuplicateCandidate) => string
): void {
  const buckets = new Map<string, DuplicateCandidate[]>()
  for (const item of remaining) {
    const key = keyFor(item)
    if (!key) continue
    const bucket = buckets.get(key)
    if (bucket) bucket.push(item)
    else buckets.set(key, [item])
  }

  for (const [key, items] of buckets) {
    if (items.length < 2) continue
    for (const item of items) remaining.delete(item)
    output.push({
      key,
      kind,
      confidence:
        kind === 'path' || kind === 'contentHash'
          ? 'exact'
          : kind === 'metadataCandidate'
            ? 'possible'
            : 'probable',
      items: items.sort(compareCandidates)
    })
  }
}

async function resolveContentHashes(
  items: readonly DuplicateCandidate[],
  contentHashForPath: DuplicateDetectionOptions['contentHashForPath'],
  requestedConcurrency: number
): Promise<{ hashes: Map<DuplicateCandidate, string>; unavailableIds: Set<string> }> {
  const hashes = new Map<DuplicateCandidate, string>()
  const unavailableIds = new Set<string>()
  const sizeCounts = new Map<number, number>()
  for (const item of items) {
    if (item.size > 0) sizeCounts.set(item.size, (sizeCounts.get(item.size) ?? 0) + 1)
  }

  const pending = items.filter((item) => {
    const persisted = normalizeContentHash(item.contentHash)
    if (persisted) {
      hashes.set(item, persisted)
      return false
    }
    return item.size > 0 && (sizeCounts.get(item.size) ?? 0) > 1
  })
  if (!contentHashForPath || pending.length === 0) return { hashes, unavailableIds }

  const concurrency = Math.max(1, Math.min(8, Math.floor(requestedConcurrency) || 4))
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++
      if (index >= pending.length) return
      const item = pending[index]
      try {
        const value = normalizeContentHash(await contentHashForPath(item.filePath))
        if (value) hashes.set(item, value)
        else unavailableIds.add(item.id)
      } catch {
        unavailableIds.add(item.id)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker))
  return { hashes, unavailableIds }
}

function canonicalPathKey(item: DuplicateCandidate): string {
  const filePath = item.filePath.trim()
  if (!filePath) return ''
  const canonical = normalize(filePath)
  return sourceEvidenceKey(
    process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical,
    item
  )
}

function sourceEvidenceKey(evidence: string | undefined, item: DuplicateCandidate): string {
  if (!evidence) return ''
  if (!item.subTrack && !item.cueRange) return evidence
  return JSON.stringify([evidence, item.subTrack ?? null, normalizeCueRange(item.cueRange)])
}

function normalizeContentHash(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLocaleLowerCase('en-US')
  return SHA256_PATTERN.test(normalized) ? normalized : undefined
}

function normalizeAudioFingerprint(value: unknown): AcousticFingerprint | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.algorithm !== 'string' || typeof record.value !== 'string') return undefined
  const algorithm = record.algorithm.trim().toLocaleLowerCase('en-US')
  const fingerprint = record.value.trim()
  if (
    !algorithm ||
    !fingerprint ||
    algorithm.length > MAX_FINGERPRINT_ALGORITHM_LENGTH ||
    fingerprint.length > MAX_FINGERPRINT_VALUE_LENGTH
  ) {
    return undefined
  }
  return {
    algorithm,
    value: fingerprint,
    evidence: record.evidence === 'verifiedAcoustic' ? 'verifiedAcoustic' : 'metadataCandidate'
  }
}

function sortGroups(groups: DuplicateGroup[]): DuplicateGroup[] {
  return groups.sort((left, right) => {
    const kindOrder = EVIDENCE_ORDER[left.kind] - EVIDENCE_ORDER[right.kind]
    if (kindOrder !== 0) return kindOrder
    return left.key.localeCompare(right.key)
  })
}

function compareCandidates(left: DuplicateCandidate, right: DuplicateCandidate): number {
  const pathOrder = left.filePath.localeCompare(right.filePath)
  return pathOrder !== 0 ? pathOrder : left.id.localeCompare(right.id)
}

function normalizeLogicalField(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function optionalText(value: unknown): string | undefined {
  const normalized = text(value).trim()
  return normalized || undefined
}

function finiteNonNegative(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0
}

function optionalFinitePositive(value: unknown): number | undefined {
  const numeric = finiteNonNegative(value)
  return numeric > 0 ? numeric : undefined
}
