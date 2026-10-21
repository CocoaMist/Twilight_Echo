import type { EventEmitter } from 'node:events'
import type { SleepTimerService } from '../sleepTimerCore.ts'
import type { NativeNaturalPlaybackBoundaries } from '../../shared/audioEngineTypes.ts'

export interface NativeSleepTimerBoundary {
  boundary: 'trackEnd' | 'queueEnd'
  occurredAt?: number
}

/** A single snapshot retains both counts even if several natural boundaries
 * passed between polls. No unbounded event backlog or position heuristics. */
export class NativeSleepTimerBoundaryCursor {
  private previous: NativeNaturalPlaybackBoundaries | null = null

  consume(value: unknown): NativeSleepTimerBoundary[] | null {
    // Only old bindings without this contract use the legacy inference path.
    if (value === undefined) return null
    if (!value || typeof value !== 'object') return []
    const next = value as NativeNaturalPlaybackBoundaries
    if (
      ![next.trackSerial, next.queueSerial, next.trackTimeMs, next.queueTimeMs].every(
        (n) => Number.isSafeInteger(n) && n >= 0
      ) ||
      next.queueSerial > next.trackSerial ||
      (next.trackSerial === 0) !== (next.trackTimeMs === 0) ||
      (next.queueSerial === 0) !== (next.queueTimeMs === 0) ||
      next.queueTimeMs > next.trackTimeMs
    )
      return []
    let previous = this.previous
    // A replacement audio service has a fresh counter epoch. Time filtering in
    // the timer authority prevents an old snapshot from triggering a new timer.
    if (
      previous &&
      (next.trackSerial < previous.trackSerial || next.queueSerial < previous.queueSerial)
    )
      previous = null
    this.previous = { ...next }
    const result: NativeSleepTimerBoundary[] = []
    if (next.trackSerial > (previous?.trackSerial ?? 0))
      result.push({ boundary: 'trackEnd', occurredAt: next.trackTimeMs })
    if (next.queueSerial > (previous?.queueSerial ?? 0))
      result.push({ boundary: 'queueEnd', occurredAt: next.queueTimeMs })
    return result
  }
}

interface NativeBoundaryEmitter extends EventEmitter {
  on(event: 'sleep-timer-boundary', listener: (event: NativeSleepTimerBoundary) => void): this
}

/** Bridges native delegated-queue boundaries into the main timer authority. */
export function registerNativeSleepTimerBoundaries(
  audioEngine: NativeBoundaryEmitter,
  sleepTimer: Pick<SleepTimerService, 'boundary'>
): void {
  audioEngine.on('sleep-timer-boundary', ({ boundary, occurredAt }) => {
    sleepTimer.boundary(boundary, occurredAt)
  })
}
