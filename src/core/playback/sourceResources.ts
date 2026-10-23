/** Source preparation holds a read lease through native acknowledgement. Cache
 * maintenance waits for those leases and blocks new ones, never the transport
 * lane. Automatic pruning is scheduled, not awaited inside a read lease. */
export class SourceResources {
  private barrier: Promise<unknown> = Promise.resolve()
  private readonly readers = new Set<Promise<unknown>>()
  private readonly pins = new Set<readonly string[]>()

  /** Publish inside use(); inspect inside maintain() so cache deletion sees a
   * stable set. A remote renderer can open new Range requests between samples. */
  pin(sources: readonly string[]): () => void {
    this.pins.add(sources)
    return () => this.pins.delete(sources)
  }

  protectedSources(): string[] {
    return [...this.pins].flat()
  }

  use<T>(action: () => Promise<T>): Promise<T> {
    const work = this.barrier.then(action)
    this.readers.add(work)
    void work.finally(() => this.readers.delete(work)).catch(() => {})
    return work
  }

  maintain<T>(action: () => Promise<T>): Promise<T> {
    const work = Promise.allSettled([this.barrier, ...this.readers]).then(action)
    this.barrier = work.catch(() => {})
    return work
  }
}
