import { playbackSessionCueRangesAreValid } from './cue.ts'
import type { PlaybackResumeMode } from './appSettings.ts'
import type { PlayMode } from './audioEngineTypes.ts'
import type { SleepTimerState } from './sleepTimer.ts'

/** Profile-local durable queue; portable backups embed the queue instead. */
export interface LibraryPlaybackQueueReference {
  id: string
  revision: number
  entryId: string
  index: number
}

export function isLibraryPlaybackQueueReference(
  value: unknown
): value is LibraryPlaybackQueueReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    record.id.length <= 128 &&
    typeof record.entryId === 'string' &&
    record.entryId.length > 0 &&
    record.entryId.length <= 128 &&
    Number.isSafeInteger(record.revision) &&
    Number(record.revision) >= 0 &&
    Number.isSafeInteger(record.index) &&
    Number(record.index) >= 0
  )
}

export interface PlaybackSessionData<TTrack> {
  version: 1
  savedAt: string
  mode: PlaybackResumeMode
  playMode?: PlayMode
  track: TTrack
  position: number
  queue?: TTrack[]
  queueIndex?: number
  queueRevision?: number
  libraryQueue?: LibraryPlaybackQueueReference
  sleepTimer?: SleepTimerState
}

export function isPlaybackSession(value: unknown): value is PlaybackSessionData<{ id: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const track = record.track
  return (
    record.version === 1 &&
    typeof record.savedAt === 'string' &&
    (record.mode === 'off' || record.mode === 'track' || record.mode === 'trackAndPosition') &&
    !!track &&
    typeof track === 'object' &&
    !Array.isArray(track) &&
    typeof (track as Record<string, unknown>).id === 'string' &&
    typeof record.position === 'number' &&
    Number.isFinite(record.position) &&
    record.position >= 0 &&
    (record.queueRevision === undefined ||
      (Number.isSafeInteger(record.queueRevision) && Number(record.queueRevision) >= 0)) &&
    (record.queue === undefined || Array.isArray(record.queue)) &&
    (record.libraryQueue === undefined ||
      (isLibraryPlaybackQueueReference(record.libraryQueue) &&
        record.queue === undefined &&
        record.queueRevision === undefined &&
        record.queueIndex === undefined &&
        (track as Record<string, unknown>).queueEntryId === record.libraryQueue.entryId)) &&
    playbackSessionCueRangesAreValid(value)
  )
}
