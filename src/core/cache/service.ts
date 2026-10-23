interface Maintenance {
  <T>(action: () => Promise<T>): Promise<T>
}
interface Options {
  authorize(): Promise<void>
  maintainSources<T>(action: (sources: readonly string[]) => Promise<T>): Promise<T>
  maintainResources: Maintenance
  maintainNetwork: Maintenance
  maintainProvider: Maintenance
  maintainScanner: Maintenance
  clearFiles(sources: readonly string[], signal: AbortSignal): Promise<void>
  clearPlatform(signal: AbortSignal): Promise<void>
  info(): Promise<{ sizeBytes: number }>
  clearNetwork(signal: AbortSignal): Promise<{ sizeBytes: number }>
}

/** One cache command owner, including the narrower network-cache operation.
 * Source cancellation precedes provider barriers so an existing source reader
 * cannot wait on a barrier held by maintenance waiting for that same reader. */
export class CoreMusicCacheService {
  private work: Promise<unknown> | null = null
  private readonly options: Options
  constructor(options: Options) {
    this.options = options
  }

  async info(): Promise<{ sizeBytes: number }> {
    await this.options.authorize()
    return this.options.info()
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    if (this.work) throw new Error('Music cache maintenance is already running')
    const work = Promise.resolve()
      .then(action)
      .finally(() => {
        this.work = null
      })
    this.work = work
    return work
  }
  clearNetwork(signal: AbortSignal): Promise<{ sizeBytes: number }> {
    return this.run(() => this.options.clearNetwork(signal))
  }
  clear(signal: AbortSignal): Promise<{ sizeBytes: number }> {
    return this.run(async () => {
      signal.throwIfAborted()
      await this.options.authorize()
      signal.throwIfAborted()
      await this.options.maintainSources((sources) =>
        this.options.maintainResources(() =>
          this.options.maintainNetwork(() =>
            this.options.maintainProvider(() =>
              this.options.maintainScanner(async () => {
                signal.throwIfAborted()
                await this.options.clearFiles(sources, signal)
                signal.throwIfAborted()
                await this.options.clearPlatform(signal)
              })
            )
          )
        )
      )
      return this.options.info()
    })
  }
  async flush(): Promise<void> {
    await this.work
  }
}
