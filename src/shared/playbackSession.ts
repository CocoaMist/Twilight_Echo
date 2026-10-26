import type { CoreHeartContext } from './coreHeart.ts'
import { playbackSessionCueRangesAreValid } from './cue.ts'
import type { PlaybackResumeMode } from './appSettings.ts'
import type { PlayMode } from './audioEngineTypes.ts'
import type { SleepTimerState } from './sleepTimer.ts'
import { MAX_QUEUE_OCCURRENCE_ID_LENGTH } from './nativeQueue.ts'
import { isCorePersonalizedContext, type CorePersonalizedContext } from './corePersonalized.ts'

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
    record.entryId.length <= MAX_QUEUE_OCCURRENCE_ID_LENGTH &&
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
  personalizedStream?: CorePersonalizedContext
  heart?: CoreHeartContext
  /** A recommendation can finish outside the restored liked queue. */
  detachedHeartTrack?: true
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
        ((track as Record<string, unknown>).queueEntryId === record.libraryQueue.entryId ||
          record.detachedHeartTrack === true))) &&
    (record.personalizedStream === undefined ||
      (isCorePersonalizedContext(record.personalizedStream) &&
        isLibraryPlaybackQueueReference(record.libraryQueue) &&
        record.personalizedStream.queueId === record.libraryQueue.id)) &&
    (record.heart === undefined ||
      (!!record.heart &&
        typeof record.heart === 'object' &&
        !Array.isArray(record.heart) &&
        isLibraryPlaybackQueueReference(record.libraryQueue) &&
        (record.heart as CoreHeartContext).queueId === record.libraryQueue.id &&
        Number.isSafeInteger((record.heart as CoreHeartContext).likedPlaylistId) &&
        (record.heart as CoreHeartContext).likedPlaylistId > 0 &&
        ((record.heart as CoreHeartContext).baseQueue === undefined ||
          (isLibraryPlaybackQueueReference((record.heart as CoreHeartContext).baseQueue) &&
            (record.heart as CoreHeartContext).baseQueue!.id !== record.libraryQueue.id &&
            record.playMode === 'heart')))) &&
    (record.detachedHeartTrack === undefined ||
      (record.detachedHeartTrack === true &&
        !!record.heart &&
        !(record.heart as CoreHeartContext).baseQueue &&
        record.playMode !== 'heart' &&
        typeof (track as Record<string, unknown>).queueEntryId === 'string' &&
        String((track as Record<string, unknown>).queueEntryId).length > 0 &&
        String((track as Record<string, unknown>).queueEntryId).length <=
          MAX_QUEUE_OCCURRENCE_ID_LENGTH)) &&
    playbackSessionCueRangesAreValid(value)
  )
}
