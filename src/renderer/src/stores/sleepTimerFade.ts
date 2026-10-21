import type { SleepTimerState } from '../../../shared/sleepTimer.ts'

export interface SleepTimerFadeOptions {
  getVolume: () => number
  setVolume: (value: number) => void
  stop: () => void
  now?: () => number
  setInterval?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void
}

/** An explicit running fade, not a terminal timer snapshot. Kept in memory. */
export interface SleepTimerFadeExecution {
  state: SleepTimerState
  startedAt: number
  volume: number
}

export function createSleepTimerFadeController(options: SleepTimerFadeOptions) {
  const now = options.now ?? Date.now
  const scheduleInterval = options.setInterval ?? setInterval
  const cancelInterval = options.clearInterval ?? clearInterval
  let timer: ReturnType<typeof setInterval> | null = null
  let shutdownStarted = false
  let execution: SleepTimerFadeExecution | null = null
  let lastWrittenVolume: number | null = null
  let generation = 0
  let suspended = false

  function clearTimer(): void {
    generation++
    if (timer !== null) cancelInterval(timer)
    timer = null
  }

  function restoreVolume(): void {
    // A user volume change made after our last step wins over cancellation.
    if (execution && lastWrittenVolume === options.getVolume()) {
      options.setVolume(execution.volume)
    }
    lastWrittenVolume = null
  }

  function clear(reset: { restoreVolume?: boolean } = {}): void {
    clearTimer()
    // Explicit cancellation can restore our last write. Teardown retains the
    // original no-output-write contract while another owner may be taking over.
    if (reset.restoreVolume) restoreVolume()
    else lastWrittenVolume = null
    execution = null
    suspended = false
    shutdownStarted = false
  }

  function startSteps(executing: SleepTimerFadeExecution): void {
    const token = generation
    const step = () => {
      // clearInterval cannot revoke a callback which is already queued.
      if (token !== generation || execution !== executing || suspended) return
      const ratio = Math.max(
        0,
        1 - (now() - executing.startedAt) / (executing.state.fadeSeconds * 1000)
      )
      lastWrittenVolume = executing.volume * ratio
      options.setVolume(lastWrittenVolume)
      if (ratio <= 0) {
        clearTimer()
        options.stop()
        restoreVolume()
        execution = null
      }
    }
    // Resuming a rejected handoff keeps the original wall-clock deadline.
    step()
    if (execution === executing && !suspended) timer = scheduleInterval(step, 250)
  }

  function begin(state: SleepTimerState): boolean {
    if (shutdownStarted) return false
    shutdownStarted = true
    const startVolume = options.getVolume()
    if (state.fadeSeconds <= 0 || startVolume <= 0) {
      options.stop()
      return true
    }

    execution = { state: { ...state }, startedAt: now(), volume: startVolume }
    startSteps(execution)
    return true
  }

  /** Freeze before asking another owner to adopt. Only an explicit acceptance
   * retires this execution; a rejection resumes it at its original deadline. */
  function prepareHandoff() {
    if (!execution || suspended) return null
    clearTimer()
    suspended = true
    const prepared = execution
    const token = generation
    const isCurrent = () => generation === token && execution === prepared && suspended
    return {
      snapshot: { ...prepared, state: { ...prepared.state } },
      isCurrent,
      accept(): void {
        if (!isCurrent()) return
        restoreVolume()
        execution = null
        suspended = false
        generation++
        // Keep duplicate trigger events idempotent until an explicit reset.
      },
      resume(): void {
        if (!isCurrent()) return
        suspended = false
        startSteps(prepared)
      }
    }
  }

  return { begin, clear, prepareHandoff, isActive: () => execution !== null }
}
