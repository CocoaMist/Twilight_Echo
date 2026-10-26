import type {
  LocalLibraryScanWorkerMessage,
  LocalLibraryScanWorkerRequest
} from '../../shared/localLibraryScan.ts'
import type {
  LibraryDatabaseScanResult,
  LibraryScanCommit,
  LibraryScanDatabaseApi,
  LibraryScanProgressSnapshot
} from '../../shared/libraryDatabase.ts'
import { LIBRARY_SCAN_DATABASE_METHODS } from '../../shared/libraryDatabase.ts'

const methods = new Set(LIBRARY_SCAN_DATABASE_METHODS)
import { LibraryScanInterruptedError } from '../../shared/coreScan.ts'
export { LibraryScanInterruptedError } from '../../shared/coreScan.ts'
export type DatabaseScanProgressListener = (
  progress: LibraryScanProgressSnapshot,
  phase: 'checking' | 'parsing' | 'committing'
) => void

/** A single scan-process session. Awaiting the database call is its ACK: the
 * metadata process cannot outrun committed SQLite checkpoints. */
export class LibraryDatabaseScanSession {
  readonly result: Promise<LibraryDatabaseScanResult>
  private resolve!: (result: LibraryDatabaseScanResult) => void
  private reject!: (error: Error) => void
  private readonly calls = new Set<Promise<void>>()
  private timer: NodeJS.Timeout | null = null
  private paused = false
  private cacheSuspended = false
  private stopped = false
  readonly jobId: string
  private readonly database: LibraryScanDatabaseApi
  private readonly send: (request: LocalLibraryScanWorkerRequest) => void
  private readonly stopWorker: () => void
  private readonly watchdogMs: number
  private readonly onProgress?: DatabaseScanProgressListener
  private readonly prepareBatch?: (batch: LibraryScanCommit) => Promise<LibraryScanCommit>
  constructor(
    jobId: string,
    database: LibraryScanDatabaseApi,
    send: (request: LocalLibraryScanWorkerRequest) => void,
    stopWorker: () => void,
    watchdogMs: number,
    onProgress?: DatabaseScanProgressListener,
    prepareBatch?: (batch: LibraryScanCommit) => Promise<LibraryScanCommit>
  ) {
    this.jobId = jobId
    this.database = database
    this.send = send
    this.stopWorker = stopWorker
    this.watchdogMs = watchdogMs
    this.onProgress = onProgress
    this.prepareBatch = prepareBatch
    this.result = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    this.touch()
  }
  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
  private touch(): void {
    this.clearTimer()
    // Backpressure and deliberate pauses are not metadata timeouts.
    if (this.stopped || this.paused || this.cacheSuspended || this.calls.size) return
    this.timer = setTimeout(
      () =>
        this.fail(
          new Error(
            `SQLite scan worker stopped responding after ${this.watchdogMs}ms; committed results are retained`
          )
        ),
      this.watchdogMs
    )
  }
  handle(message: LocalLibraryScanWorkerMessage): void {
    if (message.kind === 'ready' || message.requestId !== this.jobId || this.stopped) return
    this.touch()
    if (message.kind === 'database-call') {
      const { call } = message
      const scopedId = call.method === 'commitScanBatch' ? call.args[0]?.jobId : call.args[0]
      if (!methods.has(call.method) || scopedId !== this.jobId || this.calls.size >= 2) {
        this.fail(new Error('Invalid or unbounded scan database request'))
        return
      }
      this.clearTimer()
      const operation = (async () => {
        try {
          const args =
            call.method === 'commitScanBatch' && this.prepareBatch
              ? [await this.prepareBatch(call.args[0])]
              : call.args
          const method = this.database[call.method] as (...args: unknown[]) => Promise<unknown>
          const value = await method.apply(this.database, args)
          if (!this.stopped)
            this.send({
              kind: 'database-response',
              requestId: this.jobId,
              callId: message.callId,
              ok: true,
              value
            })
        } catch (error) {
          if (!this.stopped)
            this.send({
              kind: 'database-response',
              requestId: this.jobId,
              callId: message.callId,
              ok: false,
              error: String(error)
            })
        }
      })()
      this.calls.add(operation)
      void operation
        .catch((error) => this.fail(error))
        .finally(() => {
          this.calls.delete(operation)
          this.touch()
        })
    } else if (message.kind === 'database-progress') {
      this.onProgress?.(message.progress, message.phase)
    } else if (message.kind === 'database-result') {
      this.stopped = true
      this.clearTimer()
      void Promise.allSettled([...this.calls]).then(() => {
        if (message.ok) this.resolve(message.value)
        else this.reject(new Error(message.error))
      })
    }
  }
  pause(): void {
    this.paused = true
    this.clearTimer()
  }
  setCacheSuspended(suspended: boolean): void {
    this.cacheSuspended = suspended
    this.touch()
  }
  resume(): void {
    this.paused = false
    this.touch()
  }
  cancel(): void {
    if (this.stopped) return
    this.stopped = true
    this.clearTimer()
    this.stopWorker()
    // A commit already dispatched may have succeeded even if its ACK was lost.
    void Promise.allSettled([...this.calls])
      .then(async () => {
        this.resolve({
          cancelled: true,
          progress: await this.database.getScanProgress(this.jobId),
          removedFileCount: 0
        })
      })
      .catch(this.reject)
  }
  fail(error: unknown): void {
    if (this.stopped) return
    this.stopped = true
    this.clearTimer()
    this.stopWorker()
    void Promise.allSettled([...this.calls]).then(() => {
      this.reject(
        new LibraryScanInterruptedError(error instanceof Error ? error.message : String(error))
      )
    })
  }
}
