export type ListeningStatsPersistenceState = 'idle' | 'pending' | 'error'

export interface ListeningStatsPersistenceStatus {
  state: ListeningStatsPersistenceState
  dirty: boolean
  failureCount: number
  lastError: string | null
  lastFlush?: ListeningStatsFlushMeasurement
}

export interface ListeningStatsFlushMeasurement {
  preparationMs: number
  serializationMs: number
  storageWriteMs: number
  totalMs: number
  characters: number
}

export interface ListeningStatsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface EventTargetLike {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

interface VisibilityDocumentLike extends EventTargetLike {
  visibilityState?: string
}

export interface ListeningStatsPersistenceOptions<T> {
  key: string
  storage: ListeningStatsStorage
  persistSnapshot?: (snapshot: T) => Promise<void>
  getSnapshot(): T
  beforePersist(): void
  onStatus(status: ListeningStatsPersistenceStatus): void
  flushDelayMs: number
  retryDelayMs: number
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
  document?: VisibilityDocumentLike
  window?: EventTargetLike
}

type TimerHandle = ReturnType<typeof globalThis.setTimeout>

function describePersistenceError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error || 'Unknown persistence error')
}

/**
 * Batches full-snapshot writes so real-time playback can update memory without
 * synchronously serializing localStorage on every progress tick.
 */
export class ListeningStatsPersistence<T> {
  private readonly options: ListeningStatsPersistenceOptions<T>
  private dirty = false
  private timer: TimerHandle | null = null
  private failureCount = 0
  private lastError: string | null = null
  private lastFlush: ListeningStatsFlushMeasurement | undefined
  private lifecycleAttached = false
  private generation = 0
  private inFlight: Promise<boolean> | null = null
  private readonly setTimer: typeof globalThis.setTimeout
  private readonly clearTimer: typeof globalThis.clearTimeout

  constructor(options: ListeningStatsPersistenceOptions<T>) {
    this.options = options
    // Detached timer references must keep the global receiver: in the Electron
    // renderer, calling window.setTimeout through a plain member reference
    // throws "Illegal invocation" instead of scheduling a flush.
    this.setTimer = (options.setTimeout ?? globalThis.setTimeout).bind(globalThis)
    this.clearTimer = (options.clearTimeout ?? globalThis.clearTimeout).bind(globalThis)
  }

  markDirty(): void {
    this.dirty = true
    this.generation++
    this.attachLifecycle()
    // A checkpoint is anchored to the first dirty event. Continuous five
    // second playback ticks must not postpone it forever.
    if (this.timer === null) this.schedule(this.options.flushDelayMs)
  }

  flush(): boolean | Promise<boolean> {
    this.clearScheduledFlush()
    if (this.inFlight) {
      return this.inFlight.then((success) => (success && this.dirty ? this.flush() : success))
    }
    if (!this.dirty) {
      this.publish('idle')
      return true
    }

    if (this.options.persistSnapshot) {
      const generation = this.generation
      this.inFlight = this.flushAsync(generation).finally(() => {
        this.inFlight = null
      })
      return this.inFlight.then((success) => (success && this.dirty ? this.flush() : success))
    }

    try {
      const started = performance.now()
      this.options.beforePersist()
      const prepared = performance.now()
      const serialized = JSON.stringify(this.options.getSnapshot())
      const encoded = performance.now()
      this.options.storage.setItem(this.options.key, serialized)
      const written = performance.now()
      this.lastFlush = {
        preparationMs: prepared - started,
        serializationMs: encoded - prepared,
        storageWriteMs: written - encoded,
        totalMs: written - started,
        characters: serialized.length
      }
      this.dirty = false
      this.failureCount = 0
      this.lastError = null
      this.publish('idle')
      return true
    } catch (error) {
      // Keep the authoritative in-memory snapshot. A future timer or lifecycle
      // flush can recover once storage is available again.
      this.dirty = true
      this.failureCount += 1
      this.lastError = describePersistenceError(error)
      this.schedule(this.options.retryDelayMs, false)
      this.publish('error')
      return false
    }
  }

  private async flushAsync(generation: number): Promise<boolean> {
    try {
      const started = performance.now()
      this.options.beforePersist()
      const prepared = performance.now()
      await this.options.persistSnapshot!(this.options.getSnapshot())
      const written = performance.now()
      this.lastFlush = {
        preparationMs: prepared - started,
        serializationMs: 0,
        storageWriteMs: written - prepared,
        totalMs: written - started,
        characters: 0
      }
      this.dirty = this.generation !== generation
      this.failureCount = 0
      this.lastError = null
      if (this.dirty && this.timer === null) this.schedule(this.options.flushDelayMs)
      this.publish(this.dirty ? 'pending' : 'idle')
      return true
    } catch (error) {
      this.dirty = true
      this.failureCount++
      this.lastError = describePersistenceError(error)
      this.schedule(this.options.retryDelayMs, false)
      this.publish('error')
      return false
    }
  }

  resetForTest(): void {
    this.clearScheduledFlush()
    this.dirty = false
    this.failureCount = 0
    this.lastError = null
    this.lastFlush = undefined
    this.publish('idle')
  }

  dispose(): void {
    this.clearScheduledFlush()
    if (!this.lifecycleAttached) return
    this.options.window?.removeEventListener('pagehide', this.flushOnPageHide)
    this.options.document?.removeEventListener('visibilitychange', this.flushOnVisibilityChange)
    this.lifecycleAttached = false
  }

  private schedule(delayMs: number, publishPending = true): void {
    this.clearScheduledFlush()
    if (publishPending) this.publish('pending')
    this.timer = this.setTimer(() => {
      this.timer = null
      this.flush()
    }, delayMs)

    // Node tests use the browser store module directly. Do not keep the test
    // process alive solely for a browser persistence timer.
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      ;(this.timer as { unref(): void }).unref()
    }
  }

  private clearScheduledFlush(): void {
    if (this.timer === null) return
    this.clearTimer(this.timer)
    this.timer = null
  }

  private attachLifecycle(): void {
    if (this.lifecycleAttached) return
    this.options.window?.addEventListener('pagehide', this.flushOnPageHide)
    this.options.document?.addEventListener('visibilitychange', this.flushOnVisibilityChange)
    this.lifecycleAttached = true
  }

  private readonly flushOnPageHide = (): void => {
    this.flush()
  }

  private readonly flushOnVisibilityChange = (): void => {
    if (this.options.document?.visibilityState === 'hidden') this.flush()
  }

  private publish(state: ListeningStatsPersistenceState): void {
    this.options.onStatus({
      state,
      dirty: this.dirty,
      failureCount: this.failureCount,
      lastError: this.lastError,
      ...(this.lastFlush ? { lastFlush: this.lastFlush } : {})
    })
  }
}
