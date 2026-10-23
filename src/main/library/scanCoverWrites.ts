/** Cover maintenance drains filesystem writes, not the metadata parser's timeout
 * wrapper. It does not alter the durable scan's Pause/Cancel state. */
export class ScanCoverWrites {
  private barrier: Promise<void> | null = null
  private release: (() => void) | null = null
  private readonly pending = new Set<Promise<unknown>>()
  private readonly deadlines = new Set<{ pause(): void; resume(): void }>()
  generation = 0

  async use<T>(action: () => Promise<T>): Promise<T> {
    while (this.barrier) await this.barrier
    const work = Promise.resolve().then(action)
    this.pending.add(work)
    try {
      return await work
    } finally {
      this.pending.delete(work)
    }
  }
  suspend(): Promise<unknown> {
    if (this.barrier) throw new Error('Scan cover maintenance is already running')
    this.generation++
    for (const deadline of this.deadlines) deadline.pause()
    this.barrier = new Promise((resolve) => {
      this.release = resolve
    })
    return Promise.allSettled([...this.pending])
  }
  resume(): void {
    this.generation++
    this.barrier = null
    this.release?.()
    this.release = null
    for (const deadline of this.deadlines) deadline.resume()
  }
  /** Only deadlines containing cover waits pause. The audio metadata parser's
   * own IO timeout remains active while cover maintenance is in progress. */
  timeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
      let remaining = timeoutMs,
        started = 0,
        timer: ReturnType<typeof setTimeout> | null = null
      const deadline = {
        pause: () => {
          if (!timer) return
          clearTimeout(timer)
          timer = null
          remaining -= Date.now() - started
        },
        resume: () => {
          if (timer) return
          started = Date.now()
          timer = setTimeout(
            () => {
              this.deadlines.delete(deadline)
              reject(new Error(`${label} timed out after ${timeoutMs}ms`))
            },
            Math.max(0, remaining)
          )
        }
      }
      this.deadlines.add(deadline)
      if (!this.barrier) deadline.resume()
      void operation.then(resolve, reject).finally(() => {
        if (timer) clearTimeout(timer)
        this.deadlines.delete(deadline)
      })
    })
  }
}
