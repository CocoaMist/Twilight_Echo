import {
  isActiveSleepTimerState,
  shouldTriggerSleepTimer,
  type SleepTimerState
} from '../../shared/sleepTimer.ts'

export interface SleepTimerServiceOptions {
  now?: () => number
  publish?: (kind: 'status' | 'trigger', state: SleepTimerState | null) => void
  setInterval?: (callback: () => void, ms: number) => NodeJS.Timeout
  clearInterval?: (timer: NodeJS.Timeout) => void
  owner?: 'main' | 'core'
}

/** The unloaded renderer transfers shutdown execution, not trigger authority. */
export interface SleepTimerShutdownOwner {
  trigger(state: SleepTimerState): void
  update(state: SleepTimerState | null): void
}

export class SleepTimerService {
  private state: SleepTimerState | null = null
  private timer: NodeJS.Timeout | null = null
  private triggerRevision = 0
  private armedAt = 0
  private shutdownOwner: SleepTimerShutdownOwner | null = null
  private readonly now: () => number
  private readonly notify: (kind: 'status' | 'trigger', state: SleepTimerState | null) => void
  private readonly schedule: (callback: () => void, ms: number) => NodeJS.Timeout
  private readonly cancelInterval: (timer: NodeJS.Timeout) => void
  private readonly owner: 'main' | 'core'

  constructor(options: SleepTimerServiceOptions = {}) {
    this.now = options.now ?? Date.now
    this.notify = options.publish ?? (() => {})
    this.schedule = options.setInterval ?? setInterval
    this.cancelInterval = options.clearInterval ?? clearInterval
    this.owner = options.owner ?? 'main'
  }

  configure(state: SleepTimerState): SleepTimerState {
    if (!isActiveSleepTimerState(state, this.now())) throw new Error('Invalid sleep timer state')
    this.clearTimer()
    this.state = { ...state }
    this.armedAt = this.now()
    if (this.state.active && this.state.mode === 'minutes') {
      this.timer = this.schedule(() => this.triggerIfDue('tick'), 1_000)
    }
    this.publish('status')
    return { ...this.state }
  }

  cancel(): SleepTimerState | null {
    this.clearTimer()
    this.state = null
    this.publish('status')
    return null
  }

  snapshot(): SleepTimerState | null {
    return this.state ? { ...this.state } : null
  }

  getTriggerRevision(): number {
    return this.triggerRevision
  }

  /** Acknowledges an explicit running renderer fade, never a terminal snapshot. */
  transferShutdown(triggerRevision: number): boolean {
    if (
      !this.shutdownOwner ||
      !this.state?.triggered ||
      this.state.triggerRevision !== triggerRevision
    )
      return false
    if (this.state.shutdownOwner === 'main') return true
    this.state = { ...this.state, shutdownOwner: 'main' }
    this.publish('status')
    return true
  }

  claimShutdown(owner: SleepTimerShutdownOwner): () => void {
    if (this.shutdownOwner) throw new Error('Sleep timer shutdown already has an owner')
    const claimed: SleepTimerShutdownOwner = {
      trigger: (state) => owner.trigger(state),
      update: (state) => owner.update(state)
    }
    this.shutdownOwner = claimed
    claimed.update(this.snapshot())
    return () => {
      if (this.shutdownOwner === claimed) this.shutdownOwner = null
    }
  }

  boundary(event: 'trackEnd' | 'queueEnd', occurredAt?: number): SleepTimerState | null {
    // Native polling can first observe a prior EOF after the user arms a new
    // timer. Its original decision time, not the poll time, determines scope.
    if (
      occurredAt !== undefined &&
      (!Number.isSafeInteger(occurredAt) || occurredAt < this.armedAt)
    )
      return this.snapshot()
    this.triggerIfDue(event)
    return this.snapshot()
  }

  private triggerIfDue(event: 'tick' | 'trackEnd' | 'queueEnd'): void {
    if (!this.state || !shouldTriggerSleepTimer(this.state, this.now(), event)) return
    this.clearTimer()
    this.state = {
      ...this.state,
      active: false,
      triggered: true,
      triggerRevision: ++this.triggerRevision,
      ...(this.shutdownOwner ? { shutdownOwner: this.owner } : {})
    }
    // Do not let the still-alive pre-unload renderer start a second fade.
    if (this.shutdownOwner) this.shutdownOwner.trigger(this.snapshot()!)
    else this.publish('trigger')
    this.publish('status')
  }

  private publish(kind: 'status' | 'trigger'): void {
    if (kind === 'status') this.shutdownOwner?.update(this.snapshot())
    this.notify(kind, this.snapshot())
  }

  private clearTimer(): void {
    if (this.timer) this.cancelInterval(this.timer)
    this.timer = null
  }
}
