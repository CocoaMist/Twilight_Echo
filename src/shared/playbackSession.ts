import { playbackSessionCueRangesAreValid } from './cue.ts'
import type { PlaybackResumeMode } from './appSettings.ts'
import type { PlayMode } from './audioEngineTypes.ts'
import type { SleepTimerState } from './sleepTimer.ts'

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
    playbackSessionCueRangesAreValid(value)
  )
}
