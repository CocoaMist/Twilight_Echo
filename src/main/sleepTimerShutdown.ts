import type { SleepTimerShutdownHandoff, SleepTimerState } from '../shared/sleepTimer.ts'

interface SleepTimerShutdownOptions {
  getPlaybackInfo(): Promise<{ state: string; volume: number }>
  setGain(gain: number): Promise<void>
  /** Restores the renderer's pre-fade preference after temporary gain is ready. */
  setUserVolume?(volume: number, isCurrent: () => boolean): Promise<void>
  /** Immediately revokes previews and drains any already-issued handoff. */
  quiesce(): Promise<void>
  /** Uses the existing transport lane, checking current before dispatch. */
  stop(isCurrent: () => boolean): Promise<void>
  onStopped(): void
  onError(error: unknown): void
  now?: () => number
  setTimeout?: (callback: () => void, ms: number) => NodeJS.Timeout
  clearTimeout?: (timer: NodeJS.Timeout) => void
}

/** One fade step in flight, no per-tick promise backlog. Logical/user volume
 * remains unchanged; only the main engine's temporary gain is attenuated. */
export class SleepTimerShutdown {
  private epoch = 0
  private active = false
  private finishing = false
  private timer: NodeJS.Timeout | null = null
  private ready: Promise<void> = Promise.resolve()
  private gainDrain: Promise<void> = Promise.resolve()
  private completion: Promise<void> | null = null
  private gainTouched = false
  private gainRevision = 0
  private deadline = 0
  private fadeMs = 0
  private preparationFailed = false
  private readonly options: SleepTimerShutdownOptions

  constructor(options: SleepTimerShutdownOptions) {
    this.options = options
  }

  isActive(): boolean {
    return this.active
  }

  begin(state: SleepTimerState): void {
    this.start(state)
  }

  /** Resolves once main owns attenuation and the original user volume. */
  adopt(state: SleepTimerState, handoff: SleepTimerShutdownHandoff): Promise<void> {
    if (!this.options.setUserVolume) throw new Error('Sleep shutdown cannot restore user volume')
    this.start(state, handoff)
    const epoch = this.epoch
    const current = () => this.active && epoch === this.epoch
    return this.ready.then(async () => {
      // A failed gain/preference ACK cannot authorize restoring the renderer's
      // full volume while output might still be playing. Drain the one guarded
      // fallback stop; an unconfirmed stop keeps the handoff visibly unresolved.
      if (current() && this.preparationFailed) await this.complete(current)
    })
  }

  private start(state: SleepTimerState, handoff?: SleepTimerShutdownHandoff): void {
    if (this.active) return
    this.active = true
    this.finishing = false
    this.completion = null
    this.preparationFailed = false
    const epoch = ++this.epoch
    const current = () => this.active && epoch === this.epoch
    this.fadeMs = state.fadeSeconds * 1_000
    this.deadline = (handoff?.startedAt ?? (this.options.now ?? Date.now)()) + this.fadeMs
    // Quiesce synchronously cancels provider previews before any await.
    this.ready = this.options
      .quiesce()
      .then(async () => {
        if (!handoff || !current()) return
        // Never restore the user's full preference before attenuation is ACKed.
        await this.applyGain(this.remainingRatio())
        if (current()) await this.options.setUserVolume!(handoff.volume, current)
      })
      .catch((error) => {
        if (!current()) return
        this.preparationFailed = true
        this.options.onError(error)
      })
    void this.advance(current).catch((error) => {
      if (current()) this.options.onError(error)
    })
  }

  /** Explicit playback/configuration wins. Do not await a queued stop on the
   * same transport lane; its current guard will reject the cancelled shutdown. */
  cancel(): Promise<void> {
    this.active = false
    this.finishing = false
    this.epoch++
    this.clearTimer()
    this.completion = null
    return this.gainTouched ? this.applyGain(1) : this.gainDrain
  }

  /** Restoring the UI during a fade finishes shutdown now, before adoption. */
  finish(): Promise<void> {
    if (!this.active) return this.gainDrain
    this.finishing = true
    this.clearTimer()
    const epoch = this.epoch
    return this.complete(() => this.active && epoch === this.epoch)
  }

  private async advance(current: () => boolean): Promise<void> {
    let stop = false
    try {
      await this.ready
      if (!current() || this.finishing) return
      const info = await this.options.getPlaybackInfo()
      if (!current() || this.finishing) return
      const ratio = this.remainingRatio()
      stop =
        this.preparationFailed || this.fadeMs <= 0 || info.state !== 'playing' || info.volume <= 0
      if (!stop) {
        await this.applyGain(ratio)
        stop = ratio <= 0
      }
    } catch (error) {
      if (!current() || this.finishing) return
      this.options.onError(error)
      // If attenuation failed, stop rather than continuing at full volume.
      stop = true
    }
    if (!current() || this.finishing) return
    if (stop) return this.complete(current)
    this.timer = (this.options.setTimeout ?? setTimeout)(() => {
      this.timer = null
      void this.advance(current).catch((error) => {
        if (current()) this.options.onError(error)
      })
    }, 250)
    this.timer.unref?.()
  }

  private remainingRatio(): number {
    return this.fadeMs > 0
      ? Math.max(0, Math.min(1, (this.deadline - (this.options.now ?? Date.now)()) / this.fadeMs))
      : 0
  }

  private complete(current: () => boolean): Promise<void> {
    if (this.completion) return this.completion
    this.clearTimer()
    const completion = (async () => {
      await this.ready
      // A fade ACK may still be in flight when restore requests immediate stop.
      try {
        await this.gainDrain
      } catch {
        /* Stop still owns recovery. */
      }
      if (!current()) return
      await this.options.stop(current)
      if (!current()) return
      if (this.gainTouched) await this.applyGain(1)
      if (!current()) return
      this.active = false
      this.options.onStopped()
    })()
    this.completion = completion
    return completion
  }

  private applyGain(gain: number): Promise<void> {
    this.gainTouched = true
    const revision = ++this.gainRevision
    const applied = this.gainDrain.catch(() => {}).then(() => this.options.setGain(gain))
    this.gainDrain = applied
    return applied.then(() => {
      // An older reset ACK cannot declare a newer, queued fade step clean.
      if (revision === this.gainRevision) this.gainTouched = gain !== 1
    })
  }

  private clearTimer(): void {
    if (this.timer) (this.options.clearTimeout ?? clearTimeout)(this.timer)
    this.timer = null
  }
}
