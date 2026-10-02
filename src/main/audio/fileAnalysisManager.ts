import { stat } from 'node:fs/promises'

export type FileAnalysisRequestResult<Analysis, Unavailable = never> =
  | { status: 'completed'; analysis: Analysis }
  | { status: 'cached'; analysis: Analysis }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }
  | Unavailable

interface FileAnalysisRequest {
  trackId: string
  filePath: string
}
interface AnalysisCache<Identity, Analysis> {
  get: (identity: Identity) => Promise<Analysis | null>
  set: (identity: Identity, analysis: Analysis) => Promise<void>
  deleteIfMatches: (identity: Identity, analysis: Analysis) => Promise<boolean>
}
interface FileAnalysisManagerOptions<
  Request extends FileAnalysisRequest,
  Analysis,
  Identity,
  Unavailable
> {
  cache: AnalysisCache<Identity, Analysis>
  analyzeFile: (request: Request) => Promise<Analysis | null>
  cancelFile?: (filePath?: string) => void
  failureCooldownMs?: number
  now?: () => number
  onComplete?: (event: { trackId: string; filePath: string; analysis: Analysis }) => void
  buildIdentity: (request: Request, size: number, mtimeMs: number) => Identity
  rejectAnalysis?: (analysis: Analysis) => Unavailable | null
}

/** One owner for deduplication, cooldown, cancellation and cache rollback. */
export class FileAnalysisManager<
  Request extends FileAnalysisRequest,
  Analysis,
  Identity,
  Unavailable = never
> {
  private readonly cache: AnalysisCache<Identity, Analysis>
  private readonly analyzeFile: FileAnalysisManagerOptions<
    Request,
    Analysis,
    Identity,
    Unavailable
  >['analyzeFile']
  private readonly cancelFile?: (filePath?: string) => void
  private readonly failureCooldownMs: number
  private readonly now: () => number
  private readonly onComplete?: FileAnalysisManagerOptions<
    Request,
    Analysis,
    Identity,
    Unavailable
  >['onComplete']
  private readonly buildIdentity: FileAnalysisManagerOptions<
    Request,
    Analysis,
    Identity,
    Unavailable
  >['buildIdentity']
  private readonly rejectAnalysis?: FileAnalysisManagerOptions<
    Request,
    Analysis,
    Identity,
    Unavailable
  >['rejectAnalysis']
  private inFlight = new Map<string, Promise<FileAnalysisRequestResult<Analysis, Unavailable>>>()
  private failures = new Map<string, { failedAt: number; reason: string }>()
  private activeGenerations = new Map<string, number>()
  private nextGeneration = 0

  constructor(options: FileAnalysisManagerOptions<Request, Analysis, Identity, Unavailable>) {
    this.cache = options.cache
    this.analyzeFile = options.analyzeFile
    this.cancelFile = options.cancelFile
    this.failureCooldownMs = options.failureCooldownMs ?? 10 * 60 * 1000
    this.now = options.now ?? Date.now
    this.onComplete = options.onComplete
    this.buildIdentity = options.buildIdentity
    this.rejectAnalysis = options.rejectAnalysis
  }

  requestAnalysis(request: Request): Promise<FileAnalysisRequestResult<Analysis, Unavailable>> {
    if (!isLocalFilePath(request.filePath)) {
      return Promise.resolve({ status: 'skipped', reason: 'not-local-file' })
    }
    const existing = this.inFlight.get(request.filePath)
    if (existing) return existing

    const failure = this.failures.get(request.filePath)
    if (failure && this.now() - failure.failedAt < this.failureCooldownMs) {
      return Promise.resolve({ status: 'skipped', reason: failure.reason })
    }

    const generation = ++this.nextGeneration
    this.activeGenerations.set(request.filePath, generation)
    const task = this.run(request, generation).finally(() => {
      this.inFlight.delete(request.filePath)
      if (this.activeGenerations.get(request.filePath) === generation) {
        this.activeGenerations.delete(request.filePath)
      }
    })
    this.inFlight.set(request.filePath, task)
    return task
  }

  cancel(filePath?: string): void {
    if (filePath) {
      this.activeGenerations.delete(filePath)
      this.cancelFile?.(filePath)
      return
    }
    this.activeGenerations.clear()
    this.cancelFile?.()
  }

  private async run(
    request: Request,
    generation: number
  ): Promise<FileAnalysisRequestResult<Analysis, Unavailable>> {
    if (!this.isCurrent(request.filePath, generation)) {
      return { status: 'skipped', reason: 'cancelled' }
    }
    let identity: Identity
    let cacheCandidate: Analysis | null = null
    try {
      const fileStat = await stat(request.filePath)
      if (!this.isCurrent(request.filePath, generation)) {
        return { status: 'skipped', reason: 'cancelled' }
      }
      if (!fileStat.isFile()) return { status: 'skipped', reason: 'not-file' }
      identity = this.buildIdentity(request, fileStat.size, fileStat.mtimeMs)
    } catch (error) {
      if (!this.isCurrent(request.filePath, generation)) {
        return { status: 'skipped', reason: 'cancelled' }
      }
      return { status: 'skipped', reason: error instanceof Error ? error.message : String(error) }
    }

    const cached = await this.cache.get(identity)
    if (!this.isCurrent(request.filePath, generation)) {
      return { status: 'skipped', reason: 'cancelled' }
    }
    if (cached) return { status: 'cached', analysis: cached }

    try {
      if (!this.isCurrent(request.filePath, generation)) {
        return { status: 'skipped', reason: 'cancelled' }
      }
      const analysis = await this.analyzeFile(request)
      if (!this.isCurrent(request.filePath, generation)) {
        return { status: 'skipped', reason: 'cancelled' }
      }
      if (!analysis) {
        this.failures.set(request.filePath, { failedAt: this.now(), reason: 'no-analysis' })
        return { status: 'failed', reason: 'no-analysis' }
      }
      const rejected = this.rejectAnalysis?.(analysis)
      if (rejected) return rejected
      cacheCandidate = analysis
      await this.cache.set(identity, analysis)
      if (!this.isCurrent(request.filePath, generation)) {
        return await this.finishCancelledCacheWrite(identity, analysis)
      }
      this.onComplete?.({ trackId: request.trackId, filePath: request.filePath, analysis })
      return { status: 'completed', analysis }
    } catch (error) {
      if (!this.isCurrent(request.filePath, generation)) {
        return await this.finishCancelledCacheWrite(identity, cacheCandidate ?? undefined)
      }
      const reason = error instanceof Error ? error.message : String(error)
      this.failures.set(request.filePath, { failedAt: this.now(), reason })
      return { status: 'failed', reason }
    }
  }

  private isCurrent(filePath: string, generation: number): boolean {
    return this.activeGenerations.get(filePath) === generation
  }

  private async finishCancelledCacheWrite(
    identity: Identity,
    analysis?: Analysis
  ): Promise<FileAnalysisRequestResult<Analysis, Unavailable>> {
    if (!analysis) return { status: 'skipped', reason: 'cancelled' }
    try {
      await this.cache.deleteIfMatches(identity, analysis)
      return { status: 'skipped', reason: 'cancelled' }
    } catch (error) {
      return {
        status: 'failed',
        reason: `cancelled-cache-rollback-failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      }
    }
  }
  protected async peekCachedAnalysis(request: Request): Promise<Analysis | null> {
    if (!isLocalFilePath(request.filePath)) return null
    try {
      const fileStat = await stat(request.filePath)
      if (!fileStat.isFile()) return null
      const identity = this.buildIdentity(request, fileStat.size, fileStat.mtimeMs)
      return await this.cache.get(identity)
    } catch {
      return null
    }
  }

  protected resetFailures(): void {
    this.failures.clear()
  }
}

function isLocalFilePath(value: string): boolean {
  return !!value && !/^[a-z][a-z\d+.-]*:\/\//i.test(value)
}
