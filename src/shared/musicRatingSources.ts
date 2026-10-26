import type { MetadataAttribution } from './entityMetadata.ts'
import {
  intersectMetadataUsage,
  metadataPageUrl,
  validMetadataProvider,
  validMetadataUsage,
  type MetadataUsage
} from './musicMetadata.ts'
import { validMusicRatingSteps } from './musicRatings.ts'

export type MusicExternalRatingTargetKind = 'recording' | 'release' | 'album_project'
export type MusicExternalRatingMechanism = 'editorial' | 'community'
export type MusicExternalRatingConversion = 'unavailable' | 'identity_1_5' | 'divide_0_100_by_20'

/** A native ID belongs to this provider and this kind, not to a related release or song. */
export interface MusicExternalRatingTarget {
  kind: MusicExternalRatingTargetKind
  id: string
}
export interface MusicExternalRatingScale {
  id: string
  minimum: number
  maximum: number
}
/** Raw facts remain useful even when their provider has no approved five-star conversion. */
export interface MusicExternalRating {
  provider: string
  nativeTarget: MusicExternalRatingTarget
  mechanism: MusicExternalRatingMechanism
  rawValue: number
  scale: MusicExternalRatingScale
  conversion: MusicExternalRatingConversion
  /** null means not reported; zero means a reported count of zero. */
  voteCount: number | null
  ratedAt: number | null
  attribution: MetadataAttribution
  usage: MetadataUsage
  /** Restricted platform facts retain the same account/source fence as metadata facts. */
  sourceProvider?: string
  providerContext?: string
}
/** Trusted deployment configuration, never an approval supplied by a provider or a client. */
export interface MusicExternalRatingApproval {
  provider: string
  targetKind: MusicExternalRatingTargetKind
  mechanism: MusicExternalRatingMechanism
  scale: MusicExternalRatingScale
  conversion: Exclude<MusicExternalRatingConversion, 'unavailable'>
  usage: MetadataUsage
}
/** Editorial and community values from the same provider are separate selections. */
export interface MusicRatingBaseSelection {
  provider: string
  targetKind: MusicExternalRatingTargetKind
  mechanism: MusicExternalRatingMechanism
}
export interface MusicExternalRatingReadContext {
  now: number
  sourceProvider?: string
  platformContexts?: Readonly<Record<string, string>>
}
export interface MusicNormalizedExternalRating {
  rating: MusicExternalRating
  /** Preserve precision. The personal half-star step constraint does not apply here. */
  stars: number
  usage: MetadataUsage
}
export type MusicRatingMode = 'personal' | 'base' | 'effective'
export interface MusicResolvedRating {
  value: number | null
  origin: 'personal' | 'base' | null
  personalUnrated: boolean
  base: MusicNormalizedExternalRating | null
}

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Record<string, unknown>, allowed: string[]): boolean =>
  Object.keys(v).every((key) => allowed.includes(key))
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && !!v.trim() && v.length <= max && !v.includes('\0')
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const timestamp = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0
const targetKind = (v: unknown): v is MusicExternalRatingTargetKind =>
  v === 'recording' || v === 'release' || v === 'album_project'
const mechanism = (v: unknown): v is MusicExternalRatingMechanism =>
  v === 'editorial' || v === 'community'

export function validMusicExternalRatingTarget(v: unknown): v is MusicExternalRatingTarget {
  return record(v) && keys(v, ['kind', 'id']) && targetKind(v.kind) && text(v.id, 512)
}
export function validMusicExternalRatingScale(v: unknown): v is MusicExternalRatingScale {
  return (
    record(v) &&
    keys(v, ['id', 'minimum', 'maximum']) &&
    text(v.id, 128) &&
    finite(v.minimum) &&
    finite(v.maximum) &&
    v.minimum < v.maximum
  )
}
function validConversionScale(
  conversion: unknown,
  scale: MusicExternalRatingScale
): conversion is MusicExternalRatingConversion {
  return (
    conversion === 'unavailable' ||
    (conversion === 'identity_1_5' && scale.minimum === 1 && scale.maximum === 5) ||
    (conversion === 'divide_0_100_by_20' && scale.minimum === 0 && scale.maximum === 100)
  )
}
function validAttribution(v: unknown): v is MetadataAttribution {
  return (
    record(v) &&
    keys(v, [
      'provider',
      'externalId',
      'url',
      'license',
      'licenseUrl',
      'attribution',
      'revision',
      'retrievedAt'
    ]) &&
    validMetadataProvider(v.provider) &&
    text(v.externalId, 512) &&
    metadataPageUrl(v.url) &&
    text(v.license, 256) &&
    (v.licenseUrl === '' || metadataPageUrl(v.licenseUrl)) &&
    text(v.attribution, 2048) &&
    typeof v.revision === 'string' &&
    v.revision.length <= 256 &&
    !v.revision.includes('\0') &&
    timestamp(v.retrievedAt)
  )
}
export function validMusicExternalRating(v: unknown): v is MusicExternalRating {
  if (!record(v) || !validMusicExternalRatingScale(v.scale)) return false
  return (
    keys(v, [
      'provider',
      'nativeTarget',
      'mechanism',
      'rawValue',
      'scale',
      'conversion',
      'voteCount',
      'ratedAt',
      'attribution',
      'usage',
      'sourceProvider',
      'providerContext'
    ]) &&
    validMetadataProvider(v.provider) &&
    validMusicExternalRatingTarget(v.nativeTarget) &&
    mechanism(v.mechanism) &&
    finite(v.rawValue) &&
    v.rawValue >= v.scale.minimum &&
    v.rawValue <= v.scale.maximum &&
    validConversionScale(v.conversion, v.scale) &&
    (v.voteCount === null || (Number.isSafeInteger(v.voteCount) && Number(v.voteCount) >= 0)) &&
    (v.ratedAt === null || timestamp(v.ratedAt)) &&
    validAttribution(v.attribution) &&
    v.attribution.provider === v.provider &&
    v.attribution.externalId === v.nativeTarget.id &&
    validMetadataUsage(v.usage) &&
    (v.sourceProvider === undefined
      ? v.providerContext === undefined
      : validMetadataProvider(v.sourceProvider) && text(v.providerContext, 512))
  )
}
export function validMusicExternalRatingApproval(v: unknown): v is MusicExternalRatingApproval {
  return (
    record(v) &&
    keys(v, ['provider', 'targetKind', 'mechanism', 'scale', 'conversion', 'usage']) &&
    validMetadataProvider(v.provider) &&
    targetKind(v.targetKind) &&
    mechanism(v.mechanism) &&
    validMusicExternalRatingScale(v.scale) &&
    v.conversion !== 'unavailable' &&
    validConversionScale(v.conversion, v.scale) &&
    validMetadataUsage(v.usage)
  )
}
export function validMusicRatingBaseSelection(v: unknown): v is MusicRatingBaseSelection {
  return (
    record(v) &&
    keys(v, ['provider', 'targetKind', 'mechanism']) &&
    validMetadataProvider(v.provider) &&
    targetKind(v.targetKind) &&
    mechanism(v.mechanism)
  )
}

/** Normalize an approved, usable cached fact. No scale-based guessing or rounding. */
export function normalizeMusicExternalRating(
  rating: MusicExternalRating,
  approval: MusicExternalRatingApproval | null,
  context: MusicExternalRatingReadContext
): MusicNormalizedExternalRating | null {
  if (
    !validMusicExternalRating(rating) ||
    !validMusicExternalRatingApproval(approval) ||
    !Number.isSafeInteger(context.now) ||
    context.now < 0 ||
    rating.provider !== approval.provider ||
    rating.nativeTarget.kind !== approval.targetKind ||
    rating.mechanism !== approval.mechanism ||
    rating.conversion !== approval.conversion ||
    rating.scale.id !== approval.scale.id ||
    rating.scale.minimum !== approval.scale.minimum ||
    rating.scale.maximum !== approval.scale.maximum
  )
    return null
  const usage = intersectMetadataUsage(approval.usage, rating.usage)
  if (
    !usage.display ||
    !usage.cache ||
    (usage.expiresAt !== undefined && usage.expiresAt <= context.now)
  )
    return null
  if (!usage.crossSource && context.sourceProvider !== (rating.sourceProvider ?? rating.provider))
    return null
  if (
    rating.sourceProvider &&
    context.platformContexts?.[rating.sourceProvider] !== rating.providerContext
  )
    return null
  const stars = rating.conversion === 'divide_0_100_by_20' ? rating.rawValue / 20 : rating.rawValue
  return { rating, stars, usage }
}

/** The caller resolves this exact native target; this helper never follows album/track relations. */
export function resolveMusicRating(input: {
  mode: MusicRatingMode
  personalSteps: number | null
  target: MusicExternalRatingTarget
  baseSelection: MusicRatingBaseSelection | null
  ratings: readonly MusicExternalRating[]
  /** No configured approvals means there is no usable external base. */
  approvals?: readonly MusicExternalRatingApproval[]
  context: MusicExternalRatingReadContext
}): MusicResolvedRating {
  if (
    !['personal', 'base', 'effective'].includes(input.mode) ||
    !validMusicRatingSteps(input.personalSteps) ||
    !validMusicExternalRatingTarget(input.target) ||
    (input.target.kind === 'album_project' && input.personalSteps !== null) ||
    (input.baseSelection !== null && !validMusicRatingBaseSelection(input.baseSelection))
  )
    throw new TypeError('Invalid music rating selection')
  const selected = input.baseSelection
  let base: MusicNormalizedExternalRating | null = null
  if (selected && selected.targetKind === input.target.kind) {
    for (const rating of input.ratings) {
      if (
        !validMusicExternalRating(rating) ||
        rating.provider !== selected.provider ||
        rating.mechanism !== selected.mechanism ||
        rating.nativeTarget.kind !== selected.targetKind ||
        rating.nativeTarget.id !== input.target.id
      )
        continue
      for (const approval of input.approvals ?? []) {
        const normalized = normalizeMusicExternalRating(rating, approval, input.context)
        if (!normalized) continue
        // Select one snapshot. Different providers and mechanisms are never averaged.
        if (
          !base ||
          rating.attribution.retrievedAt > base.rating.attribution.retrievedAt ||
          (rating.attribution.retrievedAt === base.rating.attribution.retrievedAt &&
            (rating.ratedAt ?? 0) > (base.rating.ratedAt ?? 0))
        )
          base = normalized
        break
      }
    }
  }
  const personal = input.personalSteps === null ? null : input.personalSteps / 2
  const personalUnrated = input.personalSteps === null
  if (input.mode !== 'base' && personal !== null)
    return { value: personal, origin: 'personal', personalUnrated, base }
  if (input.mode !== 'personal' && base)
    return { value: base.stars, origin: 'base', personalUnrated, base }
  return { value: null, origin: null, personalUnrated, base }
}

/** Query comparisons use the stored precision, not the formatted star label. */
export function musicRatingAtLeast(value: number | null, threshold: number): boolean {
  if (!finite(threshold) || threshold < 0 || threshold > 5)
    throw new TypeError('Invalid rating threshold')
  return value !== null && finite(value) && value >= threshold
}
