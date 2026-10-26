import type { TrackData } from '../../shared/track.ts'

export type AutomaticPlaybackAllowed = (
  tracks: readonly TrackData[],
  signal?: AbortSignal
) => Promise<readonly boolean[]>

/** Preference reads must preserve batch alignment; an incomplete answer is not permission. */
export async function automaticPlaybackMask(
  tracks: readonly TrackData[],
  allowed?: AutomaticPlaybackAllowed,
  signal?: AbortSignal
): Promise<readonly boolean[]> {
  signal?.throwIfAborted()
  if (!allowed || !tracks.length) return tracks.map(() => true)
  const result = await allowed(tracks, signal)
  signal?.throwIfAborted()
  if (
    !Array.isArray(result) ||
    result.length !== tracks.length ||
    tracks.some((_, index) => typeof result[index] !== 'boolean')
  )
    throw new Error('Automatic playback preferences returned an invalid batch')
  return result
}

export async function automaticPlaybackTracks(
  tracks: TrackData[],
  allowed?: AutomaticPlaybackAllowed,
  signal?: AbortSignal,
  explicitId?: string
): Promise<TrackData[]> {
  const mask = await automaticPlaybackMask(tracks, allowed, signal)
  return tracks.filter((track, index) => mask[index] || track.id === explicitId)
}
