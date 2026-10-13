import { Worker } from 'node:worker_threads'
import { PersistentJsonFileError } from '../persistence/jsonFile.ts'
import {
  replaceActiveLibraryExclusions,
  type LoadedMusicLibraryDocument
} from './libraryRepository.ts'
import type { LibraryPersistenceOperation } from './libraryPersistenceWorker.ts'
import type { LoadedLocalLibraryFileIndex } from './fileIndex.ts'
import type { LocalLibraryFileIndexDocument } from '../../shared/localLibraryScan.ts'
import type {
  LocalMusicLibraryDocument,
  LocalLibraryTrackSelection,
  LocalLibraryRemoveResult
} from '../../shared/localLibrary.ts'

type Job = {
  id: number
  operation: LibraryPersistenceOperation
  args: unknown[]
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** Keep whole-file JSON and backup I/O off Electron's main event loop. */
export class LibraryPersistenceClient {
  private readonly entry: string | URL
  private worker: Worker | null = null
  private retiring: Promise<number> | null = null
  private readonly queue: Job[] = []
  private active: Job | null = null
  private sequence = 0
  private closed = false
  private timeout: NodeJS.Timeout | null = null
  private idleTimer: NodeJS.Timeout | null = null

  constructor(entry: string | URL) {
    this.entry = entry
  }

  async load(filePath: string): Promise<LoadedMusicLibraryDocument> {
    const loaded = await this.run<LoadedMusicLibraryDocument>('load', [filePath])
    replaceActiveLibraryExclusions(loaded.document.exclusions)
    return loaded
  }
  validate(value: unknown): Promise<void> {
    return this.run('validate', [null, value])
  }
  async persist(filePath: string, document: LocalMusicLibraryDocument): Promise<void> {
    await this.run('persist', [filePath, document])
    replaceActiveLibraryExclusions(document.exclusions)
  }
  loadIndex(filePath: string): Promise<LoadedLocalLibraryFileIndex> {
    return this.run('loadIndex', [filePath])
  }
  persistIndex(filePath: string, document: LocalLibraryFileIndexDocument): Promise<void> {
    return this.run('persistIndex', [filePath, document])
  }
  resetIndex(filePath: string, revision: number): Promise<void> {
    return this.run('resetIndex', [filePath, revision])
  }
  alignIndex(filePath: string, revision: number): Promise<void> {
    return this.run('alignIndex', [filePath, revision])
  }
  recoverRemoval(
    filePath: string
  ): Promise<{ recovered: boolean; removedTrackIds: string[]; removedFilePaths: string[] }> {
    return this.run('recoverRemoval', [filePath])
  }
  async recoverRemovalResult(
    filePath: string,
    document: LocalMusicLibraryDocument,
    items: LocalLibraryTrackSelection[]
  ): Promise<LocalLibraryRemoveResult | null> {
    const result = await this.run<LocalLibraryRemoveResult | null>('recoverRemovalResult', [
      filePath,
      document,
      items
    ])
    if (result) replaceActiveLibraryExclusions(result.library.exclusions)
    return result
  }

  async close(): Promise<void> {
    this.closed = true
    this.fail(new Error('Music library persistence worker closed'))
    await this.retiring
  }

  private run<T>(operation: LibraryPersistenceOperation, args: unknown[]): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Music library persistence worker closed'))
    if (this.queue.length + Number(this.active !== null) >= 8) {
      return Promise.reject(new Error('Music library persistence is busy'))
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        id: ++this.sequence,
        operation,
        args,
        resolve: (value) => resolve(value as T),
        reject
      })
      this.dispatch()
    })
  }

  private dispatch(): void {
    if (this.active || this.retiring || !this.queue.length) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (!this.worker) {
      try {
        const worker = new Worker(this.entry)
        this.worker = worker
        worker.on('message', (response) => {
          if (this.worker !== worker || response.id !== this.active?.id) return
          if (this.timeout) clearTimeout(this.timeout)
          this.timeout = null
          const job = this.active!
          this.active = null
          if (response.ok) job.resolve(response.result)
          else {
            const error = Object.assign(new Error(response.error.message), response.error)
            if (response.error.code === 'ERR_PERSISTENT_JSON_CORRUPT') {
              Object.setPrototypeOf(error, PersistentJsonFileError.prototype)
            }
            job.reject(error)
          }
          this.dispatch()
          if (!this.active) {
            worker.unref()
            this.idleTimer = setTimeout(() => {
              if (this.worker !== worker || this.active) return
              this.worker = null
              void worker.terminate()
            }, 30_000)
            this.idleTimer.unref()
          }
        })
        worker.on('error', (error) => {
          if (this.worker === worker) this.fail(error)
        })
        worker.on('exit', () => {
          if (this.worker === worker)
            this.fail(new Error('Music library persistence worker exited'))
        })
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
        return
      }
    }
    const worker = this.worker
    this.active = this.queue.shift()!
    worker.ref()
    this.timeout = setTimeout(() => {
      if (this.worker !== worker) return
      this.fail(new Error('Music library persistence timed out; reload before retrying a write'))
    }, 60_000)
    const job = this.active
    void this.postJob(worker, job).catch((error) => {
      if (this.worker !== worker || this.active !== job) return
      this.fail(error instanceof Error ? error : new Error(String(error)))
    })
  }

  private async postJob(worker: Worker, job: Job): Promise<void> {
    const value = job.args[1] as { tracks?: unknown[] } | undefined
    const tracks = value?.tracks
    if (
      (job.operation === 'persist' || job.operation === 'validate') &&
      Array.isArray(tracks) &&
      tracks.length > 2000
    ) {
      // postMessage also clones synchronously on the sender. Yield between
      // bounded batches so moving JSON off-thread does not replace its freeze
      // with a single whole-library clone on the main thread.
      worker.postMessage({
        id: job.id,
        operation: job.operation,
        kind: 'begin',
        args: [job.args[0], { ...value, tracks: [] }]
      })
      for (let offset = 0; offset < tracks.length; offset += 2000) {
        if (this.worker !== worker || this.active !== job) return
        worker.postMessage({
          id: job.id,
          kind: 'tracks',
          tracks: tracks.slice(offset, offset + 2000)
        })
        await new Promise<void>((done) => setImmediate(done))
      }
      if (this.worker !== worker || this.active !== job) return
      worker.postMessage({ id: job.id, kind: 'finish' })
    } else {
      worker.postMessage({ id: job.id, operation: job.operation, args: job.args })
    }
  }

  private fail(error: Error): void {
    const worker = this.worker
    if (this.timeout) clearTimeout(this.timeout)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.timeout = null
    this.idleTimer = null
    this.worker = null
    this.active?.reject(error)
    this.active = null
    for (const job of this.queue.splice(0)) job.reject(error)
    if (worker) {
      const retiring = worker.terminate()
      this.retiring = retiring
      void retiring.finally(() => {
        if (this.retiring === retiring) this.retiring = null
        if (!this.closed) this.dispatch()
      })
    }
  }
}
