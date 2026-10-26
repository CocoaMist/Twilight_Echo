import { EventEmitter } from 'node:events'
import {
  LibraryScanInterruptedError,
  type CoreScanDatabase,
  type CoreScanRunner,
  type CoreScanStatus
} from '../../shared/coreScan.ts'
import { expandSacdIsoTracks, type SacdIsoMetadataReader } from './sacdIsoTracks.ts'
import type {
  LibraryDatabaseScanResult,
  LibraryScanCommit,
  LibraryScanJob,
  LibraryScanStartRequest,
  LibraryScanProgressSnapshot,
  LibraryTrackRecord
} from '../../shared/libraryDatabase.ts'
import type { LibraryMetadata } from '../../shared/libraryDatabase.ts'
import { normalizeReleaseDate } from '../../shared/releaseDate.ts'

export interface CoreScanCoordinatorOptions {
  now(): number
  newId(): string
  database: CoreScanDatabase
  scanner: Pick<CoreScanRunner, 'scanDatabase' | 'pause' | 'resume'>
  coverCacheDir: string
  normalizeCoverHandle?: (handle: string, signal?: AbortSignal) => Promise<string>
  readSacdIsoMetadata?: (path: string, signal?: AbortSignal) => ReturnType<SacdIsoMetadataReader>
  log?: (event: string, detail: Record<string, unknown>) => void
  onPrepared?: (metadata: LibraryMetadata) => void
}
export type DatabaseScanStatus = CoreScanStatus

/** Core owner for durable scans. It never loads or rewrites the full
 * library and is deliberately separate from the legacy JSON coordinator. */
export class LibraryDatabaseScanCoordinator extends EventEmitter {
  private active: { id: string; abort: AbortController; interrupted: AbortController } | null = null
  private status: DatabaseScanStatus | null = null
  private readonly options: CoreScanCoordinatorOptions
  constructor(options: CoreScanCoordinatorOptions) {
    super()
    this.options = options
  }
  getStatus(): DatabaseScanStatus | null {
    return this.status ? { ...this.status } : null
  }
  private publish(
    progress: LibraryScanProgressSnapshot,
    phase: DatabaseScanStatus['phase'],
    error = ''
  ): void {
    this.status = { ...progress, phase, error }
    this.emit('status', this.getStatus())
  }
  start(
    mode: LibraryScanJob['mode'],
    roots: string[],
    reason = 'user',
    restoreExcluded = false
  ): Promise<LibraryDatabaseScanResult> {
    return this.execute({ id: this.options.newId(), mode, roots, restoreExcluded }, false, reason)
  }
  continueScan(id: string): Promise<LibraryDatabaseScanResult> {
    return this.execute({ id }, true, 'continue')
  }
  async recoverInterruptedScan(): Promise<LibraryDatabaseScanResult | null> {
    if (this.active) throw new Error('A database scan is already active')
    const job = (await this.options.database.listScanJobs()).find((job) =>
      ['interrupted', 'running'].includes(job.state)
    )
    return job ? this.execute({ id: job.id }, true, 'restart-recovery') : null
  }
  async pause(): Promise<boolean> {
    const active = this.active
    if (!active || this.status?.state !== 'running' || active.abort.signal.aborted) return false
    this.options.scanner.pause(active.id)
    try {
      await this.options.database.setScanState(active.id, 'paused')
      this.publish(await this.options.database.getScanProgress(active.id), this.status.phase)
      return true
    } catch (error) {
      this.options.scanner.resume(active.id)
      throw error
    }
  }
  async resume(): Promise<boolean> {
    const active = this.active
    if (!active || this.status?.state !== 'paused' || active.abort.signal.aborted) return false
    await this.options.database.resumeScan(active.id)
    this.options.scanner.resume(active.id)
    this.publish(await this.options.database.getScanProgress(active.id), this.status.phase)
    return true
  }
  cancel(): boolean {
    if (!this.active) return false
    this.active.abort.abort()
    return true
  }
  /** Shutdown is a recoverable interruption, not a user's durable Cancel. */
  interrupt(): void {
    this.active?.interrupted.abort()
  }
  private async prepareBatch(
    batch: LibraryScanCommit,
    signal: AbortSignal
  ): Promise<LibraryScanCommit> {
    for (const file of batch.files) {
      signal.throwIfAborted()
      if (file.releaseDateOnly) {
        if (file.identity.filePath.toLowerCase().endsWith('.iso')) {
          file.metadataRead = false
          file.error = 'Native ISO metadata reader is required'
          if (this.options.readSacdIsoMetadata) {
            try {
              const metadata = await this.options.readSacdIsoMetadata(file.identity.filePath, signal)
              if (metadata && !metadata.error) {
                file.releaseDate = normalizeReleaseDate(metadata.year || metadata.isoTracks?.[0]?.year)
                file.metadataRead = true
                delete file.error
              }
            } catch (error) { file.error = String(error) }
          }
        }
        signal.throwIfAborted()
        continue
      }
      if (
        file.identity.filePath.toLowerCase().endsWith('.iso') &&
        this.options.readSacdIsoMetadata
      ) {
        const tracks = (await expandSacdIsoTracks(
          file.tracks,
          (path) => this.options.readSacdIsoMetadata!(path, signal),
          this.options.newId
        )) as LibraryTrackRecord[]
        if (tracks.some((track) => typeof track.subTrack === 'string' && track.subTrack)) {
          file.tracks = tracks
          file.metadataRead = true
          delete file.error
        }
      }
      if (this.options.normalizeCoverHandle)
        for (const track of file.tracks) {
          if (typeof track.cover === 'string' && track.cover.startsWith('cover://'))
            track.cover = await this.options.normalizeCoverHandle(track.cover, signal)
        }
    }
    signal.throwIfAborted()
    return batch
  }
  private async execute(
    request: { id: string } & Partial<Omit<LibraryScanStartRequest, 'id'>>,
    continuing: boolean,
    reason: string
  ): Promise<LibraryDatabaseScanResult> {
    if (this.active) throw new Error('A database scan is already active')
    const active = {
      id: request.id,
      abort: new AbortController(),
      interrupted: new AbortController()
    }
    this.active = active
    const db = this.options.database
    const started = this.options.now()
    let phaseStarted = started,
      lastPhase = 'checking'
    const stageMs: Record<string, number> = {}
    const recordPhase = (phase: string) => {
      const now = this.options.now()
      stageMs[lastPhase] = (stageMs[lastPhase] ?? 0) + now - phaseStarted
      phaseStarted = now
      lastPhase = phase
    }
    let job: LibraryScanJob | undefined
    const log =
      this.options.log ?? ((event, detail) => console.info(`[library-db-scan] ${event}`, detail))
    try {
      if (continuing) {
        job = (await db.listScanJobs()).find((item) => item.id === request.id)
        if (!job) throw new Error('Scan job does not exist')
        // With no live metadata process, a paused task may still have claimed
        // files/directories. Re-enumerate identities instead of stranding them.
        if (job.state === 'paused' || job.state === 'running')
          await db.setScanState(job.id, 'interrupted')
        job = await db.resumeScan(job.id)
      } else
        job = await db.startScan({
          id: request.id,
          mode: request.mode!,
          roots: request.roots!,
          restoreExcluded: request.restoreExcluded
        })
      log('started', { jobId: job.id, mode: job.mode, roots: job.roots, reason })
      const initialProgress = await db.getScanProgress(job.id)
      if (this.options.onPrepared) this.options.onPrepared(await db.getMetadata())
      if (active.abort.signal.aborted) {
        await db.setScanState(job.id, 'cancelled')
        const progress = await db.getScanProgress(job.id)
        this.publish(progress, 'idle')
        return { cancelled: true, progress, removedFileCount: 0 }
      }
      if (active.interrupted.signal.aborted)
        throw new LibraryScanInterruptedError('Core shutdown interrupted scan startup')
      const scanning = this.options.scanner.scanDatabase(
        job.id,
        this.options.coverCacheDir,
        db,
        (progress, phase) => {
          recordPhase(phase)
          this.publish(progress, phase)
        },
        (batch) =>
          this.prepareBatch(
            batch,
            AbortSignal.any([active.abort.signal, active.interrupted.signal])
          ),
        AbortSignal.any([active.abort.signal, active.interrupted.signal]),
        job.mode === 'full'
      )
      // Only announce a controllable job after the client reserves its startup.
      this.publish(initialProgress, 'checking')
      const result = await scanning
      result.progress = await db.getScanProgress(job.id)
      if (active.interrupted.signal.aborted && result.progress.state !== 'completed') {
        const state = result.progress.state === 'paused' ? 'paused' : 'interrupted'
        await db.setScanState(job.id, state)
        result.progress = await db.getScanProgress(job.id)
        this.publish(result.progress, 'idle')
        return { ...result, cancelled: false }
      }
      // Finalization can commit before a cross-process cancellation arrives.
      // Completion wins; a successful scan must not become an invalid state transition.
      if (result.cancelled && result.progress.state !== 'completed') {
        await db.setScanState(job.id, 'cancelled')
        result.progress = await db.getScanProgress(job.id)
      }
      result.cancelled = result.progress.state === 'cancelled'
      this.publish(result.progress, 'idle')
      recordPhase('idle')
      log('finished', {
        ...result.progress,
        removedFileCount: result.removedFileCount,
        elapsedMs: this.options.now() - started,
        stageMs
      })
      return result
    } catch (error) {
      if (job) {
        const progress = await db.getScanProgress(job.id).catch(() => null)
        if (progress && progress.state !== 'completed') {
          const state = active.abort.signal.aborted
            ? 'cancelled'
            : active.interrupted.signal.aborted && progress.state === 'paused'
              ? 'paused'
              : active.interrupted.signal.aborted ||
                  error instanceof LibraryScanInterruptedError ||
                  progress.state === 'interrupted'
                ? 'interrupted'
                : 'failed'
          if (progress.state !== state) await db.setScanState(job.id, state)
          const updated = await db.getScanProgress(job.id)
          this.publish(updated, 'idle', state === 'cancelled' ? '' : String(error))
          if (state === 'cancelled')
            return { cancelled: true, progress: updated, removedFileCount: 0 }
        }
      }
      recordPhase('idle')
      log('failed', {
        jobId: request.id,
        reason,
        elapsedMs: this.options.now() - started,
        error: String(error),
        stageMs
      })
      throw error
    } finally {
      if (this.active === active) this.active = null
    }
  }
}
