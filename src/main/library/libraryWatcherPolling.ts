export const LIBRARY_POLL_MIN_MS = 15_000
export const LIBRARY_POLL_MAX_MS = 5 * 60_000

type Options = {
  /** true: changed, false: unchanged, undefined: another task/user stop deferred it. */
  check(): Promise<boolean | undefined>
  onError(error: unknown): void
  schedule?: (callback: () => void, delay: number) => () => void
}

/** Completion-driven timers avoid overlapping checks, even on slow/offline disks. */
export class LibraryWatcherPoller {
  private readonly options: Options
  private stopped = true
  private running = false
  private cancelTimer: (() => void) | null = null
  private delay = LIBRARY_POLL_MIN_MS
  private idleChecks = 0
  constructor(options: Options) {
    this.options = options
  }
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    if (!this.running) void this.tick()
  }
  stop(): void {
    this.stopped = true
    this.cancelTimer?.()
    this.cancelTimer = null
  }
  private async tick(): Promise<void> {
    this.running = true
    this.cancelTimer = null
    try {
      const changed = await this.options.check()
      if (changed === true) {
        this.idleChecks = 0
        this.delay = LIBRARY_POLL_MIN_MS
      } else if (changed === false) this.backoff()
    } catch (error) {
      this.backoff()
      this.options.onError(error)
    }
    this.running = false
    if (this.stopped) return
    const schedule =
      this.options.schedule ??
      ((callback, delay) => {
        const timer = setTimeout(callback, delay)
        return () => clearTimeout(timer)
      })
    this.cancelTimer = schedule(() => {
      void this.tick()
    }, this.delay)
  }
  private backoff(): void {
    this.idleChecks = Math.min(this.idleChecks + 1, 6)
    this.delay = Math.min(LIBRARY_POLL_MAX_MS, LIBRARY_POLL_MIN_MS * 2 ** (this.idleChecks - 1))
  }
}
