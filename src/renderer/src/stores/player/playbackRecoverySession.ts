import type { Track } from '../../types/music'
import { getTrackSource } from '../../utils/playerTrackUtils.ts'

const MAX_PLAYBACK_SOURCE_ATTEMPTS = 6
const PLAYBACK_SOURCE_RECOVERY_TIMEOUT_MS = 30_000

/** One user playback request owns every automatic source retry beneath it. */
export class PlaybackRecoverySession {
  readonly rootTrack: Track
  readonly signal: AbortSignal
  pendingRematch = false
  notice: { kind: 'switched' | 'rematched'; reason?: unknown } | null = null
  private readonly attempted = new Set<string>()
  private readonly controller = new AbortController()
  private readonly maxAttempts: number
  private readonly timer: ReturnType<typeof setTimeout>
  private closed = false

  constructor(track: Track, options: { maxAttempts?: number; timeoutMs?: number } = {}) {
    this.rootTrack = track
    this.signal = this.controller.signal
    this.maxAttempts = options.maxAttempts ?? MAX_PLAYBACK_SOURCE_ATTEMPTS
    this.timer = setTimeout(
      () => this.cancel(new Error('Playback source recovery timed out')),
      options.timeoutMs ?? PLAYBACK_SOURCE_RECOVERY_TIMEOUT_MS
    )
  }

  canAttempt(track: Track): boolean {
    return this.canAttemptSearch() && !this.attempted.has(this.trackKey(track))
  }

  canAttemptSearch(): boolean {
    return !this.closed && !this.signal.aborted && this.attempted.size < this.maxAttempts
  }

  beginAttempt(track: Track): boolean {
    if (!this.canAttempt(track)) return false
    this.attempted.add(this.trackKey(track))
    return true
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.signal.aborted) {
      throw this.signal.reason ?? new Error('Playback source recovery ended')
    }
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(this.signal.reason)
      this.signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([operation(), aborted])
    } finally {
      if (onAbort) this.signal.removeEventListener('abort', onAbort)
    }
  }

  finish(): void {
    this.closed = true
    clearTimeout(this.timer)
  }

  cancel(reason = new Error('Playback request was superseded')): void {
    this.finish()
    this.controller.abort(reason)
  }

  private trackKey(track: Track): string {
    return JSON.stringify([getTrackSource(track), track.id])
  }
}
