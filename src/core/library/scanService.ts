import type { CoreScanDatabase, CoreScanRunner, CoreScanStatus } from '../../shared/coreScan.ts'
import type { LibraryScanJob } from '../../shared/libraryDatabase.ts'
import { LibraryDatabaseScanCoordinator } from './scanCoordinator.ts'

export interface CoreScanServiceOptions {
  coordinator: LibraryDatabaseScanCoordinator
  database: CoreScanDatabase
  scanner: Pick<CoreScanRunner, 'destroy'>
  authorizeDirectory(path: string): Promise<string>
  changed(): void
  failed(error: unknown): void
  directoryQueue?: { load(): Promise<string[]>; save(roots: string[]): Promise<void> }
}
interface ScanTask {
  completion: Promise<void>
  jobId: string | null
}

/** A durable background task belongs to Core, not to the client that starts it. */
export class CoreScanService {
  private status: CoreScanStatus | null = null
  private task: ScanTask | null = null
  private control: Promise<unknown> = Promise.resolve()
  private activated = false
  private recovery: LibraryScanJob | null = null
  private stopped = false
  private shutdownWork: Promise<void> | null = null
  private reservations = 0
  private maintenanceRecovery: string | null = null
  private readonly pendingDirectories = new Map<string, number>()
  private directoryGeneration = 0
  private directoryWork: Promise<unknown> = Promise.resolve()
  private backgroundScheduled = false
  private backgroundWork: Promise<void> | null = null
  private readonly options: CoreScanServiceOptions
  constructor(options: CoreScanServiceOptions) {
    this.options = options
    options.coordinator.on('status', this.onStatus)
  }
  private readonly onStatus = (status: CoreScanStatus | null) => {
    this.status = status
    this.options.changed()
  }
  snapshot(): CoreScanStatus | null {
    return this.status ? { ...this.status } : null
  }
  async initialize(): Promise<void> {
    for (const root of (await this.options.directoryQueue?.load()) ?? [])
      this.pendingDirectories.set(root, ++this.directoryGeneration)
    const job = await this.options.database.getLatestScanJob()
    this.recovery = job && (job.state === 'interrupted' || job.state === 'running') ? job : null
    if (job)
      this.status = {
        ...(await this.options.database.getScanProgress(job.id)),
        phase: 'idle',
        error: ''
      }
  }
  /** Called only after migration/readiness. Deliberately paused jobs stay paused. */
  activate(): void {
    if (this.activated || this.stopped) return
    this.activated = true
    const job = this.recovery
    this.recovery = null
    if (job)
      void this.begin(async () => {
        await this.authorize(job.roots)
        this.ensureRunning()
        return () => this.options.coordinator.continueScan(job.id)
      }).catch(this.options.failed)
    this.scheduleDirectories()
  }

  private userSuspended(): boolean {
    return this.status?.state === 'paused' || this.status?.state === 'cancelled'
  }
  /** Once per Core activation, after recovery has reserved any interrupted task. */
  async startup(): Promise<void> {
    if (!this.activated || this.stopped || this.task || this.reservations || this.userSuspended())
      return
    await this.begin(async () => {
      const roots = (await this.options.database.getMetadata()).folders
      if (!roots.length) return null
      const authorized = await this.authorize(roots)
      return () => this.options.coordinator.start('startup', authorized, 'core-startup')
    })
  }
  /** Completion-driven fallback polling neither overlaps nor queues an explicit scan. */
  async poll(directory: string): Promise<boolean | undefined> {
    if (!this.activated || this.stopped || this.task || this.reservations || this.userSuspended())
      return undefined
    let before = 0
    const started = this.begin(async () => {
      before = (await this.options.database.getMetadata()).revision
      const roots = await this.authorize([directory])
      return () => this.options.coordinator.start('watch', roots, 'core-poll')
    })
    const task = this.task!
    await started
    await task.completion
    if (this.stopped || this.userSuspended()) return undefined
    if (this.status?.error) throw new Error(this.status.error)
    return (await this.options.database.getMetadata()).revision !== before
  }

  /** Downloads/watchers coalesce directories behind an existing explicit scan. */
  enqueueDirectories(roots: readonly string[]): Promise<void> {
    this.ensureRunning()
    const work = this.directoryWork.then(async () => {
      for (const root of roots) this.pendingDirectories.set(root, ++this.directoryGeneration)
      await this.saveDirectories()
      this.scheduleDirectories()
    })
    this.directoryWork = work.catch(this.options.failed)
    return work
  }
  private saveDirectories(): Promise<void> {
    return (
      this.options.directoryQueue?.save([...this.pendingDirectories.keys()]) ?? Promise.resolve()
    )
  }
  private scheduleDirectories(): void {
    if (
      !this.activated ||
      this.stopped ||
      this.task ||
      this.reservations ||
      this.backgroundScheduled ||
      this.userSuspended() ||
      !this.pendingDirectories.size
    )
      return
    this.backgroundScheduled = true
    queueMicrotask(() => {
      if (
        this.stopped ||
        this.task ||
        this.reservations ||
        this.userSuspended() ||
        !this.pendingDirectories.size
      ) {
        this.backgroundScheduled = false
        return
      }
      const selected = new Map(this.pendingDirectories)
      let handedOff = false
      this.backgroundWork = this.begin(async () => {
        const authorized = await this.authorize([...selected.keys()])
        return () => this.options.coordinator.start('watch', authorized, 'core-file-changes')
      })
        .then((status) => {
          // The scan's durable ACK now owns this batch. New changes in the same directory remain queued.
          if (!status) return
          const work = this.directoryWork.then(async () => {
            for (const [root, generation] of selected)
              if (this.pendingDirectories.get(root) === generation)
                this.pendingDirectories.delete(root)
            await this.saveDirectories()
            handedOff = true
          })
          this.directoryWork = work.catch(this.options.failed)
          return work
        })
        .catch(this.options.failed)
        .finally(() => {
          this.backgroundScheduled = false
          // On a failed authorization keep persisted roots for explicit retry/restart, not a retry loop.
          if (handedOff) this.scheduleDirectories()
        })
    })
  }
  async start(
    request: { mode: LibraryScanJob['mode']; roots?: string[]; restoreExcluded?: boolean },
    signal?: AbortSignal
  ): Promise<CoreScanStatus> {
    const status = await this.begin(async () => {
      signal?.throwIfAborted()
      const roots = await this.authorize(
        request.roots ?? (await this.options.database.getMetadata()).folders,
        signal
      )
      signal?.throwIfAborted()
      this.ensureRunning()
      return () =>
        this.options.coordinator.start(request.mode, roots, 'core-command', request.restoreExcluded)
    })
    return status!
  }
  private async authorize(roots: string[], signal?: AbortSignal): Promise<string[]> {
    if (!roots.length) throw new Error('No library folders are configured for scanning')
    // A bounded sequential capability stream; never fill main's platform queue.
    const authorized: string[] = []
    for (const root of roots) {
      this.ensureRunning()
      signal?.throwIfAborted()
      authorized.push(await this.options.authorizeDirectory(root))
    }
    return [...new Set(authorized)]
  }
  private ensureRunning(): void {
    if (this.stopped) throw new Error('Core scan service is shutting down')
  }
  private async begin(
    prepare: () => Promise<(() => Promise<unknown>) | null>
  ): Promise<CoreScanStatus | null> {
    this.ensureRunning()
    if (this.reservations)
      throw Object.assign(new Error('Library maintenance is active'), { code: 'BUSY' })
    if (this.task) throw Object.assign(new Error('A Core scan is already active'), { code: 'BUSY' })
    let resolve!: (status: CoreScanStatus | null) => void, reject!: (error: unknown) => void
    const initial = new Promise<CoreScanStatus | null>((done, fail) => {
      resolve = done
      reject = fail
    })
    let announced = false
    const onStatus = (status: CoreScanStatus) => {
      if (this.task === task) task.jobId = status.jobId
      if (!announced) {
        announced = true
        resolve({ ...status })
      }
    }
    const task: ScanTask = { completion: Promise.resolve(), jobId: null }
    this.task = task
    this.options.coordinator.on('status', onStatus)
    task.completion = (async () => {
      try {
        const execute = await prepare()
        this.ensureRunning()
        if (execute) await execute()
        if (!announced) resolve(null)
      } catch (error) {
        reject(error)
        if (!this.stopped && !announced && this.status)
          this.onStatus({
            ...this.status,
            error: error instanceof Error ? error.message : String(error)
          })
        if (!this.stopped && announced) this.options.failed(error)
      } finally {
        this.options.coordinator.off('status', onStatus)
        if (this.task === task) this.task = null
        this.scheduleDirectories()
      }
    })()
    // Return the durable job's first ACK, not the entire scan's eventual result.
    // From this point a cancelled IPC/client disconnect does not cancel the job.
    return initial
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.control.then(() => {
      this.ensureRunning()
      return operation()
    })
    this.control = work.catch(() => {})
    return work
  }
  /** Reserve the existing scanner while file mutations/repair use its resources.
   * Playback controls have a separate lane and remain responsive. */
  async maintain<T>(action: () => Promise<T>, resume = true): Promise<T> {
    this.ensureRunning()
    this.reservations++
    try {
      return await this.enqueue(async () => {
        const task = this.task
        if (task) {
          this.options.coordinator.interrupt()
          await task.completion
          if (resume && this.status?.state === 'interrupted') this.maintenanceRecovery = task.jobId
        }
        const result = await action()
        if (!resume) {
          this.maintenanceRecovery = null
          this.pendingDirectories.clear()
          await this.saveDirectories()
          if (this.status)
            this.onStatus({
              ...(await this.options.database.getScanProgress(this.status.jobId)),
              phase: 'idle',
              error: ''
            })
        }
        return result
      })
    } finally {
      this.reservations--
      if (!this.reservations && !this.stopped && this.maintenanceRecovery) {
        const id = this.maintenanceRecovery
        this.maintenanceRecovery = null
        // Preserve the interrupted full/startup scope before draining tag changes.
        if (this.status?.jobId === id && this.status.state === 'interrupted')
          void this.begin(async () => {
            const job = (await this.options.database.listScanJobs()).find((item) => item.id === id)
            if (!job || job.state !== 'interrupted') return null
            await this.authorize(job.roots)
            return () => this.options.coordinator.continueScan(id)
          }).catch(this.options.failed)
      }
      this.scheduleDirectories()
    }
  }
  pause(jobId: string): Promise<boolean> {
    return this.enqueue(async () =>
      this.task?.jobId === jobId ? this.options.coordinator.pause() : false
    )
  }
  resume(jobId: string): Promise<CoreScanStatus | null> {
    return this.enqueue(async () => {
      if (this.task) {
        if (this.task.jobId !== jobId) throw new Error('Another scan is active')
        await this.options.coordinator.resume()
        return this.snapshot()
      }
      return this.begin(async () => {
        const job = (await this.options.database.listScanJobs()).find((item) => item.id === jobId)
        if (!job) throw new Error('Scan job does not exist or is already completed')
        await this.authorize(job.roots)
        return () => this.options.coordinator.continueScan(jobId)
      })
    })
  }
  cancel(jobId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const task = this.task
      if (task) {
        if (task.jobId !== jobId) return false
        const cancelled = this.options.coordinator.cancel()
        await task.completion
        return cancelled
      }
      const job = (await this.options.database.listScanJobs()).find((item) => item.id === jobId)
      if (!job || job.state === 'cancelled') return false
      await this.options.database.setScanState(jobId, 'cancelled')
      this.onStatus({
        ...(await this.options.database.getScanProgress(jobId)),
        phase: 'idle',
        error: ''
      })
      this.scheduleDirectories()
      return true
    })
  }
  shutdown(): Promise<void> {
    if (this.shutdownWork) return this.shutdownWork
    this.stopped = true
    this.options.coordinator.interrupt()
    this.options.scanner.destroy()
    this.shutdownWork = (async () => {
      await this.control
      await this.task?.completion
      await this.backgroundWork
      await this.directoryWork
      this.options.coordinator.off('status', this.onStatus)
    })()
    return this.shutdownWork
  }
}
