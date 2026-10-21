import { opendir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { LocalLibraryFileIdentity } from '../../shared/localLibraryScan.ts'
import type {
  LibraryDatabaseScanResult,
  LibraryScanCommit,
  LibraryScanDatabaseApi,
  LibraryScanProgressSnapshot,
  LibraryTrackRecord
} from '../../shared/libraryDatabase.ts'
import { SUPPORTED_EXTENSIONS } from './libraryFiles.ts'
import { normalizeLibraryFilePath } from './libraryRepository.ts'

export interface DirectoryScanPage {
  identities: LocalLibraryFileIdentity[]
  children: string[]
}
export interface DatabaseScannerOptions {
  jobId: string
  database: LibraryScanDatabaseApi
  enumerate(directory: string): AsyncIterable<DirectoryScanPage>
  parse(
    identity: LocalLibraryFileIdentity,
    audioMetadata?: LibraryTrackRecord
  ): Promise<LibraryScanCommit['files'][number]>
  forceParse?: boolean
  waitUntilRunnable(): Promise<void>
  cancelled(): boolean
  onProgress(
    progress: LibraryScanProgressSnapshot,
    phase: 'checking' | 'parsing' | 'committing'
  ): void
  onActivity?(identities: LocalLibraryFileIdentity[]): void
  flushIntervalMs?: number
}

/** At most four stat calls and one 256-entry page; no whole-library snapshot. */
export async function* enumerateDatabaseDirectory(
  directory: string,
  readCueSignature: (directory: string) => Promise<string | Map<string, string> | undefined>
): AsyncGenerator<DirectoryScanPage> {
  const cueSignature = await readCueSignature(directory)
  let page: DirectoryScanPage = { identities: [], children: [] }
  let paths: string[] = []
  const readIdentities = async () => {
    const identities = await Promise.all(
      paths.map(async (filePath) => {
        const info = await stat(filePath)
        const signature =
          cueSignature instanceof Map
            ? cueSignature.get(normalizeLibraryFilePath(filePath))
            : cueSignature
        return info.isFile()
          ? {
              filePath,
              size: info.size,
              mtimeMs: info.mtimeMs,
              ...(signature ? { cueSignature: signature } : {})
            }
          : undefined
      })
    )
    for (const identity of identities) if (identity) page.identities.push(identity)
    paths = []
  }
  const handle = await opendir(directory)
  for await (const entry of handle) {
    const filePath = join(directory, entry.name)
    if (entry.isDirectory()) page.children.push(filePath)
    else if (entry.isFile() && SUPPORTED_EXTENSIONS.includes(extname(entry.name).toLowerCase()))
      paths.push(filePath)
    if (paths.length === 4 || page.identities.length + page.children.length + paths.length === 256)
      await readIdentities()
    if (page.identities.length + page.children.length === 256) {
      yield page
      page = { identities: [], children: [] }
    }
  }
  if (paths.length) await readIdentities()
  if (page.identities.length || page.children.length) yield page
}

/** One unacknowledged result batch is sufficient; a second is never required.
 * At most 256 buffered files plus four active parsers are retained. */
class ScanBatchWriter {
  private files: LibraryScanCommit['files'] = []
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<void> = Promise.resolve()
  private failure: unknown
  private sequence: number
  private readonly options: DatabaseScannerOptions
  private readonly publish: DatabaseScannerOptions['onProgress']
  constructor(
    options: DatabaseScannerOptions,
    lastBatch: number,
    publish: DatabaseScannerOptions['onProgress']
  ) {
    this.options = options
    this.sequence = lastBatch
    this.publish = publish
  }
  private async confirmed(): Promise<void> {
    await this.inFlight
    if (this.failure) throw this.failure
  }
  async add(files: LibraryScanCommit['files']): Promise<void> {
    await this.confirmed()
    for (const file of files) {
      this.files.push(file)
      if (!this.timer)
        this.timer = setTimeout(() => {
          this.timer = null
          void this.flush().catch(() => {}) // confirmed()/close() surface the original failure.
        }, this.options.flushIntervalMs ?? 1_000)
      if (this.files.length === 256) await this.flush()
    }
  }
  flush(): Promise<void> {
    // Snapshot synchronously so the timer and the parse loop cannot enqueue the
    // same files, assign duplicate sequences, or grow a second pending batch.
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.files.length) return this.confirmed()
    const files = this.files
    this.files = []
    const previous = this.inFlight
    this.inFlight = (async () => {
      await previous
      if (this.failure) throw this.failure
      if (this.options.cancelled()) return
      await this.options.database.commitScanBatch({
        jobId: this.options.jobId,
        sequence: ++this.sequence,
        files
      })
      const progress = await this.options.database.getScanProgress(this.options.jobId)
      this.publish(progress, 'committing')
    })().catch((error) => {
      this.failure = error
      throw error
    })
    // A timer may initiate this promise before the next add()/close() awaits it.
    void this.inFlight.catch(() => {})
    return this.inFlight
  }
  async close(commitPending: boolean): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!commitPending) this.files = []
    if (commitPending) await this.flush()
    await this.confirmed()
  }
}

/** Runs in the existing metadata process. Every checkpoint comes from SQLite;
 * the scan process has no full-library tracks or identity list. */
export async function runDatabaseScan(
  options: DatabaseScannerOptions
): Promise<LibraryDatabaseScanResult> {
  const { database: db, jobId } = options
  let work = await db.claimScanFiles(jobId, 256)
  let audioMetadata: Record<string, LibraryTrackRecord> =
    options.forceParse || !work.identities.length
      ? {}
      : await db.getScanAudioMetadata(jobId, work.identities)
  let lastProgressAt = -Infinity
  let lastPhase: 'checking' | 'parsing' | 'committing' | undefined
  const publish: DatabaseScannerOptions['onProgress'] = (progress, phase) => {
    lastProgressAt = performance.now()
    lastPhase = phase
    options.onProgress(progress, phase)
  }
  const writer = new ScanBatchWriter(options, work.lastBatch, publish)
  const report = async (phase: 'checking' | 'parsing') => {
    // Each checkpoint remains durable. Only the progress snapshot is coalesced:
    // counting an ever-growing scan_items index on every page is quadratic.
    // Phase transitions, committed batches and the terminal result stay exact.
    if (phase === 'checking' && lastPhase === phase && performance.now() - lastProgressAt < 250)
      return
    publish(await db.getScanProgress(jobId), phase)
  }
  const parsePending = async () => {
    let reported = false
    while (true) {
      await options.waitUntilRunnable()
      if (options.cancelled()) return
      if (!work.identities.length) {
        work = await db.claimScanFiles(jobId, 256)
        audioMetadata =
          options.forceParse || !work.identities.length
            ? {}
            : await db.getScanAudioMetadata(jobId, work.identities)
      }
      if (work.state === 'paused') continue
      if (!work.identities.length) return
      if (!reported) {
        await report('parsing')
        reported = true
      }
      const identities = work.identities.splice(0, 4)
      options.onActivity?.(identities)
      const files = await Promise.all(
        identities.map(async (identity) => {
          try {
            return await options.parse(
              identity,
              audioMetadata[normalizeLibraryFilePath(identity.filePath)]
            )
          } catch (error) {
            return { identity, tracks: [], metadataRead: false, error: String(error) }
          }
        })
      )
      if (options.cancelled()) return
      await writer.add(files)
    }
  }
  try {
    await parsePending()
    while (true) {
      await options.waitUntilRunnable()
      if (options.cancelled()) break
      await parsePending()
      if (options.cancelled()) break
      await writer.flush()
      const page = await db.claimScanDirectories(jobId, 1)
      // A cross-process pause is not an exhausted task queue. Keep that state
      // in the claim response even if the user has already resumed meanwhile.
      if (page.state === 'paused') continue
      if (!page.directories.length) {
        await options.waitUntilRunnable()
        if (options.cancelled()) break
        const finished = await db.finishScan(jobId)
        if (!finished.completed) continue
        await writer.close(true)
        return {
          cancelled: false,
          progress: await db.getScanProgress(jobId),
          removedFileCount: finished.removedFileCount
        }
      }
      const directory = page.directories[0]
      try {
        for await (const page of options.enumerate(directory)) {
          await options.waitUntilRunnable()
          if (options.cancelled()) break
          await db.recordScanFiles(jobId, page.identities)
          await db.recordScanDirectory(jobId, {
            path: directory,
            children: page.children,
            complete: false
          })
          await report('checking')
          await parsePending()
        }
        if (options.cancelled()) break
        await db.recordScanDirectory(jobId, { path: directory, children: [] })
      } catch (error) {
        // An incomplete directory must never authorize missing-file cleanup.
        await db.recordScanDirectory(jobId, { path: directory, children: [], error: String(error) })
        throw error
      }
      await writer.flush()
    }
    await writer.close(false)
    return {
      cancelled: true,
      progress: await db.getScanProgress(jobId),
      removedFileCount: 0
    }
  } catch (error) {
    await writer.close(false).catch(() => {})
    throw error
  }
}
