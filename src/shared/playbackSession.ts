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
