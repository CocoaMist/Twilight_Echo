import type { PlaylistPersistenceState, PlaylistPersistenceStatus } from '../../shared/playlists.ts'
export type { PlaylistPersistenceState, PlaylistPersistenceStatus } from '../../shared/playlists.ts'

export class PlaylistTransactionRejectedError extends Error {}

export interface PlaylistPersistenceOptions<T> {
  /**
   * `base` is the state immediately before `snapshot`'s local transaction.
   * Keeping both lets a domain writer replay the local transaction onto an
   * authoritative CAS snapshot instead of overwriting concurrent updates.
   */
  write(snapshot: T, base: T): Promise<void>
  onStatus?(status: PlaylistPersistenceStatus): void
  flushDelayMs: number
  retryDelayMs: number
  cloneSnapshot?(snapshot: T): T
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
  shouldRetry?(error: unknown): boolean
}

type TimerHandle = ReturnType<typeof globalThis.setTimeout>

function describeError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error || 'Unknown persistence error')
}

/**
 * Serializes playlist writes without serializing every user gesture. Callers
 * provide an immutable snapshot at enqueue time, so later reactive mutations
 * cannot alter a queued persistence transaction.
 */
export class PlaylistPersistence<T> {
  private readonly options: PlaylistPersistenceOptions<T>
  private readonly setTimer: typeof globalThis.setTimeout
  private readonly clearTimer: typeof globalThis.clearTimeout
  private pendingSnapshot: T | null = null
  private pendingBase: T | null = null
  private timer: TimerHandle | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private writing = false
  private dirty = false
  private failureCount = 0
  private lastError: string | null = null
  private retryable = true

  constructor(options: PlaylistPersistenceOptions<T>) {
    this.options = options
    // Browser timer functions require the Window receiver in Chromium. Store
    // bound functions so calling them through this class cannot throw
    // `Illegal invocation` in the real renderer.
    this.setTimer = options.setTimeout ?? globalThis.setTimeout.bind(globalThis)
    this.clearTimer = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis)
  }

  enqueue(snapshot: T, base: T = snapshot): void {
    const clone = this.options.cloneSnapshot ?? cloneForPersistence
    // A debounce window represents one transaction: preserve the first base
    // and replace only its desired final state.
    if (this.pendingSnapshot === null) this.pendingBase = clone(base)
    this.pendingSnapshot = clone(snapshot)
    this.dirty = true
    if (this.retryable) this.schedule(this.options.flushDelayMs)
    else this.publish('error')
  }

  async flush(): Promise<boolean> {
    this.clearScheduledFlush()
    // A timer callback may have started an async commit in this same turn.
    // Yield once so flush joins that write chain instead of observing only its
    // cleared pending slot.
    await Promise.resolve()
    if (!this.retryable) return false
    const failuresAtStart = this.failureCount
    do {
      await this.commitPending()
      await this.writeChain
      // A failed transaction schedules a retry and leaves the latest desired
      // state dirty. Do not turn an explicit flush into an unbounded retry loop.
      if (this.failureCount > failuresAtStart) break
      this.clearScheduledFlush()
    } while (this.pendingSnapshot !== null)
    return !this.dirty
  }

  dispose(): void {
    this.clearScheduledFlush()
  }

  /** Read authority first. Check, queue reset and publication share one turn. */
  async discardPending(check: () => void, apply: () => void): Promise<void> {
    await this.writeChain
    check()
    this.clearScheduledFlush()
    this.pendingSnapshot = null
    this.pendingBase = null
    this.dirty = false
    this.retryable = true
    this.failureCount = 0
    this.lastError = null
    apply()
    if (!this.dirty) this.publish('idle')
  }

  private schedule(delayMs: number, publishPending = true): void {
    this.clearScheduledFlush()
    if (publishPending) this.publish('pending')
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.commitPending()
    }, delayMs)
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      ;(this.timer as { unref(): void }).unref()
    }
  }

  private async commitPending(): Promise<void> {
    if (!this.retryable) return
    if (this.writing) {
      await this.writeChain
      return
    }
    const snapshot = this.pendingSnapshot
    const base = this.pendingBase
    if (snapshot === null || base === null) {
      if (!this.dirty) this.publish('idle')
      return
    }

    this.pendingSnapshot = null
    this.pendingBase = null
    this.writing = true
    this.writeChain = Promise.resolve()
      .then(async () => {
        try {
          await this.options.write(snapshot, base)
          if (this.pendingSnapshot === null) {
            this.dirty = false
            this.failureCount = 0
            this.lastError = null
            this.publish('idle')
          }
        } catch (error) {
          // A later local state still depends on this failed transaction. Its
          // captured base describes the failed optimistic snapshot, which was
          // never committed. Rebase the pending final state from this older
          // base so retry retains every local change.
          if (this.pendingSnapshot === null) {
            this.pendingSnapshot = snapshot
            this.pendingBase = base
          } else {
            this.pendingBase = base
          }
          this.dirty = true
          this.failureCount += 1
          this.lastError = describeError(error)
          this.retryable = this.options.shouldRetry?.(error) !== false
          this.publish('error')
          if (this.retryable) this.schedule(this.options.retryDelayMs, false)
          else this.clearScheduledFlush()
        }
      })
      .finally(() => {
        this.writing = false
        if (this.retryable && this.pendingSnapshot !== null && this.timer === null) {
          this.schedule(this.options.flushDelayMs)
        }
      })

    await this.writeChain
  }

  private clearScheduledFlush(): void {
    if (this.timer === null) return
    this.clearTimer(this.timer)
    this.timer = null
  }

  private publish(state: PlaylistPersistenceState): void {
    this.options.onStatus?.({
      state,
      dirty: this.dirty,
      failureCount: this.failureCount,
      lastError: this.lastError,
      ...(!this.retryable ? { canRetry: false as const } : {})
    })
  }
}

function cloneForPersistence<T>(snapshot: T): T {
  return JSON.parse(JSON.stringify(snapshot)) as T
}
