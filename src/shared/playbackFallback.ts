import type { TrackData as Track, TrackSource } from './track.ts'
import type { LogicalTrackModel } from './logicalTrackModel.ts'
import { getTrackSource } from './trackSourceIdentity.ts'

export interface PlaybackFallbackOptions {
  failedTrack: Track
  candidates: Track[]
  unavailableSources?: string[]
  sourceReliability?: Record<string, number | undefined>
}

/** Existing variant selection, bound to the recording preference owner. */
export function createPlaybackFallback(identity: LogicalTrackModel) {
  const {
    getRecordingTrackKey: getLogicalTrackKey,
    preferredSourceKey,
    canShareTrackIdentity,
    compareSourceVariants,
    toSourceVariant
  } = identity
  function findPlaybackFallbackTrack(options: PlaybackFallbackOptions): Track | null {
    if (preferredSourceKey(options.failedTrack)) return null
    const unavailableSources = new Set((options.unavailableSources ?? []).map(normalizeSource))
    const failedSource = getTrackSource(options.failedTrack)
    const failedKey = getLogicalTrackKey(options.failedTrack)

    const candidates = options.candidates
      .filter((candidate) => candidate.id !== options.failedTrack.id)
      .filter((candidate) => getLogicalTrackKey(candidate) === failedKey)
      .filter((candidate) => canShareTrackIdentity(options.failedTrack, candidate))
      .filter((candidate) => !unavailableSources.has(getTrackSource(candidate)))
      .filter((candidate) => getTrackSource(candidate) !== failedSource || failedSource === 'local')
      .sort((left, right) => compareFallbackCandidates(left, right, options.sourceReliability))
    return candidates[0] ?? null
  }
  function compareFallbackCandidates(
    left: Track,
    right: Track,
    sourceReliability: Record<string, number | undefined> = {}
  ): number {
    return compareSourceVariants(
      toSourceVariant({
        track: left,
        providerReliability: getSourceReliability(getTrackSource(left), sourceReliability)
      }),
      toSourceVariant({
        track: right,
        providerReliability: getSourceReliability(getTrackSource(right), sourceReliability)
      })
    )
  }
  return { findPlaybackFallbackTrack }
}

export function clampProviderReliability(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.max(0, Math.min(1, value))
}
function getSourceReliability(
  source: TrackSource,
  sourceReliability: Record<string, number | undefined>
): number {
  if (source === 'local') return 1
  return clampProviderReliability(sourceReliability[normalizeSource(source)])
}
function normalizeSource(source: string): TrackSource {
  return source.trim().toLowerCase() as TrackSource
}
