import type { CoreSleepTimerConfigure, CoreSleepTimerState } from '../../shared/coreSleepTimer.ts'
import {
  createSleepTimerState,
  isActiveSleepTimerState,
  type SleepTimerSettings,
  type SleepTimerState
} from '../../shared/sleepTimer.ts'
import { SleepTimerService } from './sleepTimer.ts'
import { SleepTimerShutdown } from './sleepShutdown.ts'

/** One clock and fade for every client; there is no window ownership handoff. */
export class CoreSleepTimer {
  private revision = 0
  private active = false
  private restored: SleepTimerState | null = null
  private pending = Promise.resolve()
  private readonly persistence = new Set<Promise<void>>()
  private readonly timer: SleepTimerService
  private readonly fade: SleepTimerShutdown
  private readonly options: {
    settings(): SleepTimerSettings
    now(): number
    timers: {
      setInterval(callback: () => void, ms: number): NodeJS.Timeout
      clearInterval(timer: NodeJS.Timeout): void
      setTimeout(callback: () => void, ms: number): NodeJS.Timeout
      clearTimeout(timer: NodeJS.Timeout): void
    }
    playback: {
      read(): { state: string; volume: number }
      quiesce(): Promise<void>
      setGain(gain: number): Promise<void>
      stop(current: () => boolean): Promise<void>
      resumeMaintenance(): void
      persist(): Promise<void>
    }
    changed(): void
    failed(error: unknown): void
  }
  constructor(options: CoreSleepTimer['options']) {
    this.options = options
    this.fade = new SleepTimerShutdown({
      getPlaybackInfo: async () => options.playback.read(),
      quiesce: () => options.playback.quiesce(),
      setGain: (gain) => options.playback.setGain(gain),
      stop: (current) => options.playback.stop(current),
      onStopped: () => options.changed(),
      onError: (error) => options.failed(error),
      now: options.now,
      setTimeout: options.timers.setTimeout,
      clearTimeout: options.timers.clearTimeout
    })
    this.timer = new SleepTimerService({
      owner: 'core',
      now: options.now,
      setInterval: options.timers.setInterval,
      clearInterval: options.timers.clearInterval,
      publish: () => {
        if (!this.active) return
        this.revision++
        options.changed()
        const write = options.playback.persist()
        this.persistence.add(write)
        void write.catch(options.failed).finally(() => this.persistence.delete(write))
      }
    })
    this.timer.claimShutdown({ trigger: (state) => this.fade.begin(state), update: () => {} })
  }
  state(): CoreSleepTimerState {
    return { revision: this.revision, timer: this.active ? this.timer.snapshot() : this.restored }
  }
  persisted(): SleepTimerState | undefined {
    const timer = this.state().timer
    return timer?.active ? { ...timer } : undefined
  }
  restore(state: SleepTimerState | undefined): void {
    this.restored = isActiveSleepTimerState(state, this.options.now()) ? { ...state } : null
  }
  activate(): void {
    this.active = true
    if (isActiveSleepTimerState(this.restored, this.options.now()))
      this.timer.configure(this.restored)
    this.restored = null
  }
  private run<T>(revision: number, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const work = this.pending.then(async () => {
      signal.throwIfAborted()
      if (revision !== this.revision)
        throw Object.assign(new Error('Sleep timer changed'), { code: 'STALE_REVISION' })
      return action()
    })
    this.pending = work.then(
      () => {},
      () => {}
    )
    return work
  }
  configure(request: CoreSleepTimerConfigure, signal: AbortSignal): Promise<void> {
    return this.run(request.revision, signal, async () => {
      await this.fade.cancel()
      this.timer.configure(
        createSleepTimerState(
          request.mode,
          this.options.now(),
          this.options.settings(),
          request.minutes
        )
      )
      this.options.playback.resumeMaintenance()
      await this.flushPersistence()
    })
  }
  cancel(revision: number, signal: AbortSignal): Promise<void> {
    return this.run(revision, signal, async () => {
      this.timer.cancel()
      await this.fade.cancel()
      this.options.playback.resumeMaintenance()
      await this.flushPersistence()
    })
  }
  /** Called synchronously by a new transport intent; an armed timer stays armed. */
  interrupt(): Promise<void> {
    if (!this.timer.snapshot()?.triggered) return Promise.resolve()
    this.timer.cancel()
    return this.fade.cancel()
  }
  triggered(): boolean {
    return this.timer.snapshot()?.triggered === true
  }
  boundary(event: 'trackEnd' | 'queueEnd', occurredAt?: number): void {
    if (this.active) this.timer.boundary(event, occurredAt)
  }
  private async flushPersistence(): Promise<void> {
    await Promise.all([...this.persistence])
  }
  async flush(): Promise<void> {
    await this.pending
    await this.flushPersistence()
  }
  async shutdown(): Promise<void> {
    await this.pending
    this.active = false
    this.restored = this.timer.snapshot()
    this.timer.cancel()
    // A fired timer must reach Stop before temporary gain can return to unity.
    await this.fade.finish()
    await this.flush()
  }
}
