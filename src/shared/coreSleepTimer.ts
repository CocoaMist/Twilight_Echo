import type { SleepTimerMode, SleepTimerState } from './sleepTimer.ts'

export interface CoreSleepTimerState {
  revision: number
  timer: SleepTimerState | null
}
export interface CoreSleepTimerConfigure {
  revision: number
  mode: SleepTimerMode
  minutes?: number
}
