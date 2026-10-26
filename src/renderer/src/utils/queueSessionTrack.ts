import * as portable from '../../../core/workspace/tracks.ts'
import type { TrackData as Track } from '../../../shared/track.ts'
import type { PlayMode } from '../../../shared/audioEngineTypes.ts'
import type { LibraryPlaybackQueueReference } from '../../../shared/playbackSession.ts'
const runtime = { now: Date.now, newId: () => crypto.randomUUID() }
export { restoreQueueTrackIdentity } from '../../../core/workspace/tracks.ts'
export function saveQueueTrack(track: Track) {
  return portable.saveQueueTrack(track, runtime.newId)
}
export function captureQueueSession(
  name: string,
  queue: readonly Track[],
  original: readonly Track[],
  current: Track | null,
  position: number,
  mode: PlayMode,
  id?: string
) {
  return portable.captureQueueSession(runtime, name, queue, original, current, position, mode, id)
}
export function captureLibraryQueueSession(
  name: string,
  reference: LibraryPlaybackQueueReference,
  position: number,
  mode: PlayMode,
  id?: string
) {
  return portable.captureLibraryQueueSession(runtime, name, reference, position, mode, id)
}
