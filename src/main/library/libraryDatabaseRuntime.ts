import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import type {
  LocalLibrarySnapshotInput,
  LocalLibraryTrackSelection,
  LocalLibraryRemovalMode,
  LocalLibraryRemoveRequest,
  LocalMusicLibraryDocument
} from '../../shared/localLibrary.ts'
import type {
  LibraryDatabaseApi,
  LibraryMetadata,
  LibraryScanJob,
  LibraryDatabaseScanResult,
  LibraryTrackPatch
} from '../../shared/libraryDatabase.ts'
import { LIBRARY_MAX_PAGE_SIZE } from '../../shared/libraryDatabase.ts'
import type { LibraryDirectoryScanRequest } from '../../shared/libraryDatabase.ts'
import type { DuplicateCandidate } from '../../shared/duplicateDetection.ts'
import { validateLibraryDirectoryScan } from './libraryDatabaseValidation.ts'
import type {
  LocalLibraryScanStatus,
  LocalLibraryScanUpdate,
  LocalLibraryWatchChange
} from '../../shared/localLibraryScan.ts'
import type { LibraryDatabaseWorkerApi, LibraryRemovalResult } from './libraryDatabaseProtocol.ts'
import {
  LibraryDatabaseScanCoordinator,
  type DatabaseScanStatus
} from './libraryDatabaseScanCoordinator.ts'
import {
  assertMusicLibraryRevision,
  applySuccessfulLibraryRemoval,
  clearLibraryExclusions,
  collectLibraryTrackPathKeys,
  createMusicLibraryDocument,
  normalizeLibraryFilePath,
  replaceActiveLibraryExclusions
} from './libraryRepository.ts'
import { commitDatabaseLibraryRemoval } from './libraryDatabaseRemovalCoordinator.ts'
import { recoverLocalLibraryRemovalFromDatabase } from './removal.ts'
import { applyPendingPersonalRestoreFromDatabase } from '../persistence/personalBackup.ts'
import { LibraryPlaylistRepairService } from './libraryPlaylistRepairService.ts'
import { LibrarySelectionService } from './librarySelectionService.ts'
import { LibraryQueueBuildService } from './libraryQueueBuildService.ts'
import type { LocalLibraryScanServiceClient } from './libraryScanServiceClient.ts'

type Options = {
  root: string
  libraryFilePath: string
  database: LibraryDatabaseWorkerApi
  scanner: ConstructorParameters<typeof LibraryDatabaseScanCoordinator>[0]['scanner'] &
    Partial<Pick<LocalLibraryScanServiceClient, 'scanRepair'>>
  coverCacheDir: string
  resolveRoots(): Promise<string[]>
  authorizeRemoval(filePath: string, mode: LocalLibraryRemovalMode): Promise<void>
  authorizeRepairDirectory?(path: string): Promise<string>
  authorizeRepairFile?(path: string): Promise<string>
  prepareTrash(filePaths: string[]): Promise<void>
  trashItem(filePath: string): Promise<void>
  normalizeCoverHandle?: (handle: string) => Promise<string>
  readSacdIsoMetadata?: ConstructorParameters<
    typeof LibraryDatabaseScanCoordinator
  >[0]['readSacdIsoMetadata']
  closeDatabase(): void
  watcherDebounceMs?: number
}
function inside(path: string, root: string): boolean {
  const key = normalizeLibraryFilePath(path),
    base = normalizeLibraryFilePath(root).replace(/[\\/]+$/, '')
  return key === base || key.startsWith(base + '/') || key.startsWith(base + '\\')
}
function mergeDirectoryScopes(directories: string[]): string[] {
  const scopes: string[] = []
  for (const directory of directories) {
    if (scopes.some((scope) => inside(directory, scope))) continue
    for (let index = scopes.length - 1; index >= 0; index--)
      if (inside(scopes[index], directory)) scopes.splice(index, 1)
    scopes.push(directory)
  }
  return scopes
}

/** One application owner for the database, recovery and durable scan pipeline.
 * Queries stay independent from the bounded mutation lane; a scan never holds
 * that lane while parsing files. Full documents are compatibility calls only. */
export class LibraryDatabaseRuntime extends EventEmitter {
  readonly database: LibraryDatabaseWorkerApi
  readonly api: LibraryDatabaseApi
  readonly scanner: LibraryDatabaseScanCoordinator
  readonly playlistRepair?: LibraryPlaylistRepairService
  readonly selections: LibrarySelectionService
  readonly queueBuilds: LibraryQueueBuildService
  private readonly options: Options
  private opening: Promise<void> | null = null
  private chain: Promise<void> = Promise.resolve()
  private waitingWrites = 0
  private stopped = false
  private scanTask: Promise<LibraryDatabaseScanResult | null> | null = null
  private scanRequested = false
  private repairScanning = false
  private scanGeneration = 0
  private revision = -1
  private knownRoots: string[] = []
  private lastMode: LibraryScanJob['mode'] = 'startup'
  private retainedStatus: DatabaseScanStatus | null = null
  private readonly pendingDirectories = new Map<string, string>()
  private watcherTimer: NodeJS.Timeout | null = null
  private watcherDraining = false
  private watcherSuspended = false

  constructor(options: Options) {
    super()
    this.options = options
    this.database = options.database
    this.selections = new LibrarySelectionService(this.database)
    this.queueBuilds = new LibraryQueueBuildService(this.database)
    if (
      options.scanner.scanRepair &&
      options.authorizeRepairDirectory &&
      options.authorizeRepairFile
    )
      this.playlistRepair = new LibraryPlaylistRepairService({
        ...options,
        scanner: { scanRepair: (...args) => options.scanner.scanRepair!(...args) },
        authorizeDirectory: options.authorizeRepairDirectory,
        authorizeFile: options.authorizeRepairFile,
        reserveScan: async (action) => {
          if (this.stopped || this.scanRequested || this.scanTask || this.repairScanning)
            throw new Error('曲库扫描正在运行，请结束后再修复歌单')
          this.repairScanning = true
          try {
            await this.initialize()
            return await action()
          } finally {
            this.repairScanning = false
            this.scheduleWatcher()
          }
        }
      })
    this.scanner = new LibraryDatabaseScanCoordinator({
      ...options,
      onPrepared: (metadata) => {
        if (metadata.revision >= this.revision) this.configurationChanged(metadata)
      }
    })
    this.scanner.on('status', (status: DatabaseScanStatus) => {
      this.emit('status', this.getStatus())
      this.emit('database-status', status)
      this.notifyRevision(status.revision)
    })
    this.api = {
      syncPlaylistView: (request) => this.database.syncPlaylistView(request),
      syncListeningHistory: (request) =>
        this.write(() => this.database.syncListeningHistory(request)),
      getMetadata: () => this.database.getMetadata(),
      lookupTracksByPaths: (paths, revision) => this.database.lookupTracksByPaths(paths, revision),
      lookupPlaylistTracks: (request, revision) =>
        this.database.lookupPlaylistTracks(request, revision),
      queryTracks: (query) => this.database.queryTracks(query),
      queryCollections: (kind, query) => this.database.queryCollections(kind, query),
      getTracksByIds: (ids, revision) => this.database.getTracksByIds(ids, revision),
      patchTracks: (patches) => this.patchTracks(patches),
      createLibraryQueue: (query, selectedId) =>
        this.database.createLibraryQueue(query, selectedId),
      readLibraryQueue: (id, offset, limit) => this.database.readLibraryQueue(id, offset, limit),
      getLibraryQueue: (id) => this.database.getLibraryQueue(id),
      editLibraryQueue: (id, revision, edit) => this.database.editLibraryQueue(id, revision, edit),
      deleteLibraryQueue: (id, revision) => this.database.deleteLibraryQueue(id, revision),
      syncLibraryQueueReferences: (owner, ids) =>
        this.database.syncLibraryQueueReferences(owner, ids),
      collectLibraryQueueGarbage: (olderThanMs) =>
        this.database.collectLibraryQueueGarbage(olderThanMs)
    }
  }
  initialize(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('SQLite library owner stopped'))
    return (this.opening ??= (async () => {
      await this.database.getMetadata() // Opens/migrates the sole database worker.
      await this.database.recoverRemoval()
      await recoverLocalLibraryRemovalFromDatabase(this.options.libraryFilePath, this.database)
      await applyPendingPersonalRestoreFromDatabase(this.options.root, this.database)
      this.configurationChanged(await this.database.getMetadata())
      const job = await this.database.getLatestScanJob()
      if (job) {
        this.watcherSuspended = ['cancelled', 'paused'].includes(job.state)
        this.lastMode = job.mode
        this.retainedStatus = {
          ...(await this.database.getScanProgress(job.id)),
          phase: 'idle',
          error: ''
        }
      }
    })())
  }
  private write<T>(action: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('SQLite library owner stopped'))
    if (this.waitingWrites >= 16) return Promise.reject(new Error('曲库修改队列已满，请稍后再试'))
    this.waitingWrites++
    const task = this.chain.then(async () => {
      if (this.stopped) throw new Error('SQLite library owner stopped')
      await this.initialize()
      // A previous RPC may have lost its reply. Recover the durable outcome
      // before accepting another mutation; never repeat an external trash call.
      const recovered = await this.database.recoverRemoval()
      if (recovered) this.configurationChanged(recovered.metadata)
      return action()
    })
    this.chain = task.then(
      () => {},
      () => {}
    )
    return task.finally(() => {
      this.waitingWrites--
    })
  }
  private configurationChanged(metadata: LibraryMetadata): void {
    this.knownRoots = metadata.folders
    replaceActiveLibraryExclusions(metadata.exclusions)
    this.notifyRevision(metadata.revision)
  }
  private notifyRevision(revision: number): void {
    if (revision <= this.revision) return
    this.revision = revision
    this.emit('changed', revision)
  }
  refreshRoots(): Promise<LibraryMetadata> {
    return this.write(() => this.refreshRootsInLane())
  }
  private async refreshRootsInLane(): Promise<LibraryMetadata> {
    const metadata = await this.database.getMetadata(),
      folders = await this.options.resolveRoots()
    if (JSON.stringify(folders) === JSON.stringify(metadata.folders)) return metadata
    const next = await this.database.setLibraryRoots(folders)
    this.configurationChanged(next)
    return next
  }
  patchTracks(patches: LibraryTrackPatch[]) {
    return this.write(async () => {
      const page = await this.database.patchTracks(patches)
      this.notifyRevision(page.revision)
      return page
    })
  }
  async loadLegacyDocument(): Promise<LocalMusicLibraryDocument> {
    await this.initialize()
    return this.database.exportDocument()
  }
  async *duplicateCandidatePages(): AsyncGenerator<DuplicateCandidate[]> {
    await this.initialize()
    let cursor = 0,
      revision: number | undefined
    do {
      const page = await this.database.readDuplicateCandidates(
        cursor,
        LIBRARY_MAX_PAGE_SIZE,
        revision
      )
      revision = page.revision
      yield page.items
      if (page.nextCursor === null) return
      cursor = page.nextCursor
    } while (!this.stopped)
    throw new Error('SQLite library owner stopped')
  }
  private async replaceLegacy(
    snapshot: LocalLibrarySnapshotInput
  ): Promise<LocalMusicLibraryDocument> {
    await this.cancelAndWait()
    const previous = await this.database.getMetadata()
    assertMusicLibraryRevision(snapshot.revision, previous.revision)
    const document = createMusicLibraryDocument(snapshot, previous.exclusions)
    const metadata = await this.database.replaceDocument(document, previous.revision)
    document.revision = metadata.revision
    this.configurationChanged(metadata)
    return document
  }
  saveLegacyDocument(snapshot: LocalLibrarySnapshotInput) {
    return this.write(() => this.replaceLegacy(snapshot))
  }
  private async remove(
    items: LocalLibraryTrackSelection[],
    mode: LocalLibraryRemovalMode
  ): Promise<LibraryRemovalResult> {
    if (items.length > 10_000) throw new Error('每次最多删除 10000 个文件')
    const unique = [
      ...new Map(items.map((item) => [normalizeLibraryFilePath(item.filePath), item])).values()
    ]
    const id = randomUUID(),
      removedTrackIds: string[] = [],
      removedFilePaths: string[] = [],
      failures: LibraryRemovalResult['failures'] = []
    for (let offset = 0; offset < unique.length; offset += 256) {
      const batch = unique.slice(offset, offset + 256)
      if (mode === 'trash') {
        await this.cancelAndWait()
        await this.options.prepareTrash(batch.map((item) => item.filePath))
      }
      const result = await commitDatabaseLibraryRemoval({
        database: this.database,
        id: `${id}-${offset}`,
        mode,
        items: batch,
        authorize: (path) => this.options.authorizeRemoval(path, mode),
        trashItem: this.options.trashItem
      })
      removedTrackIds.push(...result.removedTrackIds)
      removedFilePaths.push(...result.removedFilePaths)
      failures.push(...result.failures)
      this.configurationChanged(result.metadata)
    }
    return {
      id,
      mode,
      removedTrackIds,
      removedFilePaths,
      failures,
      metadata: await this.database.getMetadata()
    }
  }
  removeFiles(items: LocalLibraryTrackSelection[], mode: LocalLibraryRemovalMode) {
    return this.write(() => this.remove(items, mode))
  }
  removeLegacy(request: LocalLibraryRemoveRequest) {
    return this.write(async () => {
      await this.cancelAndWait()
      const previous = await this.database.getMetadata()
      assertMusicLibraryRevision(request.library.revision, previous.revision)
      const document = createMusicLibraryDocument(request.library, previous.exclusions)
      const suppliedPaths = collectLibraryTrackPathKeys(document)
      const result = await this.remove(
        request.items.filter((item) => suppliedPaths.has(normalizeLibraryFilePath(item.filePath))),
        request.mode
      )
      result.failures.push(
        ...request.items
          .filter((item) => !suppliedPaths.has(normalizeLibraryFilePath(item.filePath)))
          .map((item) => ({ filePath: item.filePath, message: '曲目已不在本地音乐库中' }))
      )
      // Preserve caller edits only when a removal succeeded, as the original
      // snapshot API did. Failed selections must never seed new persisted files.
      if (result.removedFilePaths.length) {
        const successful = new Set(result.removedFilePaths.map(normalizeLibraryFilePath))
        const mutation = applySuccessfulLibraryRemoval(
          document,
          request.items.filter((item) => successful.has(normalizeLibraryFilePath(item.filePath))),
          false
        )
        mutation.document.exclusions = result.metadata.exclusions
        result.metadata = await this.database.replaceDocument(
          mutation.document,
          result.metadata.revision
        )
        this.configurationChanged(result.metadata)
      }
      return { ...result, library: await this.database.exportDocument() }
    })
  }
  clearLegacyExclusions(snapshot: LocalLibrarySnapshotInput, filePaths: string[]) {
    return this.write(async () => {
      await this.cancelAndWait()
      const previous = await this.database.getMetadata()
      assertMusicLibraryRevision(snapshot.revision, previous.revision)
      const cleared = clearLibraryExclusions(
        createMusicLibraryDocument(snapshot, previous.exclusions),
        filePaths
      )
      if (cleared.clearedFilePaths.length) {
        const metadata = await this.database.replaceDocument(cleared.document, previous.revision)
        this.configurationChanged(metadata)
      }
      return {
        library: await this.database.exportDocument(),
        clearedFilePaths: cleared.clearedFilePaths
      }
    })
  }
  reset() {
    return this.write(async () => {
      await this.cancelAndWait()
      const result = await this.database.resetLibrary()
      this.configurationChanged(result.metadata)
      return {
        ...result,
        library: {
          version: 2 as const,
          revision: result.metadata.revision,
          tracks: [],
          folders: result.metadata.folders,
          exclusions: result.metadata.exclusions
        }
      }
    })
  }
  getStatus(): LocalLibraryScanStatus & Partial<Omit<DatabaseScanStatus, 'jobId' | 'state'>> {
    const status = this.scanner.getStatus() ?? this.retainedStatus
    return {
      ...status,
      jobId: status?.jobId ?? null,
      mode: status ? this.lastMode : null,
      state: status?.state === 'interrupted' ? 'failed' : (status?.state ?? 'idle'),
      current: (status?.committedFiles ?? 0) + (status?.failedFiles ?? 0),
      total: status?.checkedFiles ?? 0,
      parsedFileCount: status?.parsedFiles ?? 0,
      skippedUnchanged: Math.max(0, (status?.committedFiles ?? 0) - (status?.parsedFiles ?? 0)),
      error: status?.error ?? '',
      databaseProgress: status
        ? {
            jobId: status.jobId,
            state: status.state,
            phase: status.phase,
            checkedFiles: status.checkedFiles,
            parsedFiles: status.parsedFiles,
            committedFiles: status.committedFiles,
            failedFiles: status.failedFiles,
            trackCount: status.trackCount,
            revision: status.revision
          }
        : undefined
    }
  }
  scan(mode: LibraryScanJob['mode'], scopes?: string[]): Promise<LocalLibraryScanUpdate> {
    return this.runScan(mode, scopes)
  }
  scanDirectories(request: LibraryDirectoryScanRequest): Promise<LocalLibraryScanUpdate> {
    validateLibraryDirectoryScan(request)
    const scopes = mergeDirectoryScopes(request.directories.map((path) => resolve(path)))
    return this.runScan('watch', scopes, request.reason)
  }
  private async runScan(
    mode: LibraryScanJob['mode'],
    scopes?: string[],
    reason?: LibraryDirectoryScanRequest['reason']
  ): Promise<LocalLibraryScanUpdate> {
    if (this.repairScanning) throw new Error('歌单修复正在运行，请结束后再扫描曲库')
    if (this.scanRequested || this.scanTask) throw new Error('曲库扫描正在运行')
    this.scanRequested = true
    const generation = this.scanGeneration
    try {
      // Reserve and prepare in the same mutation lane as root removal/reset.
      // Return the task in an object so the lane does not await media parsing.
      const prepared = await this.write(async () => {
        let metadata = await this.refreshRootsInLane()
        if (reason) {
          if (!scopes!.every((scope) => metadata.folders.some((root) => inside(scope, root))))
            throw new Error('扫描目录未获授权，请重新选择当前曲库中的文件夹')
          const canonicalScopes: string[] = []
          for (const scope of scopes!) {
            if (!(await stat(scope)).isDirectory()) throw new Error('扫描路径不是文件夹')
            const canonical = await realpath(scope)
            if (!metadata.folders.some((root) => inside(canonical, root)))
              throw new Error('扫描目录的实际位置未获授权')
            canonicalScopes.push(canonical)
          }
          scopes = mergeDirectoryScopes(canonicalScopes)
          // Directory I/O can yield to settings changes. Recheck before the
          // atomic job/exclusion preparation, never unexclude an offline scope.
          metadata = await this.refreshRootsInLane()
          if (!scopes!.every((scope) => metadata.folders.some((root) => inside(scope, root))))
            throw new Error('扫描目录授权已更改，请重新选择文件夹')
        }
        const roots =
          scopes?.filter((scope) => metadata.folders.some((root) => inside(scope, root))) ??
          metadata.folders
        let previous = await this.database.getLatestScanJob()
        if (generation !== this.scanGeneration || this.stopped) return {}
        if (reason === 'tags' && previous && previous.state !== 'completed')
          throw new Error('已有未完成的扫描，请先继续原任务，或开始新的所选目录导入')
        if (
          previous &&
          (mode !== 'startup' ||
            !previous.roots.every((scope) => metadata.folders.some((root) => inside(scope, root))))
        ) {
          if (['running', 'paused', 'interrupted', 'failed'].includes(previous.state))
            await this.database.setScanState(previous.id, 'cancelled')
          previous = null
        }
        if (!roots.length || generation !== this.scanGeneration || this.stopped) return {}
        if (previous && ['cancelled', 'paused'].includes(previous.state)) {
          this.watcherSuspended = true
          return {
            result: {
              cancelled: true,
              progress: await this.database.getScanProgress(previous.id),
              removedFileCount: 0
            }
          }
        }
        this.watcherSuspended = false
        const recover =
          previous && ['running', 'interrupted'].includes(previous.state) ? previous : null
        this.lastMode = recover?.mode ?? mode
        // Consume only changes already queued before this scan. Events arriving
        // during parsing must remain pending for the next incremental check.
        for (const [key, directory] of this.pendingDirectories)
          if (roots.some((scope) => inside(directory, scope))) this.pendingDirectories.delete(key)
        const task = recover
          ? this.scanner.continueScan(recover.id)
          : this.scanner.start(
              mode,
              roots,
              reason ?? (mode === 'watch' ? 'filesystem-change' : 'user'),
              reason === 'import'
            )
        this.scanTask = task
        return { task }
      })
      const result = prepared.task ? await prepared.task : prepared.result
      const cancelled = generation !== this.scanGeneration || this.stopped
      const current = await this.database.getMetadata()
      if (current.revision >= this.revision) this.configurationChanged(current)
      return {
        jobId: result?.progress.jobId ?? '',
        mode,
        state: cancelled || result?.cancelled ? 'cancelled' : 'completed',
        libraryRevision: current.revision,
        exclusions: current.exclusions,
        addedTracks: [],
        updatedTracks: [],
        removedFilePaths: [],
        parsedFileCount: result?.progress.parsedFiles ?? 0,
        skippedUnchanged: Math.max(
          0,
          (result?.progress.committedFiles ?? 0) - (result?.progress.parsedFiles ?? 0)
        ),
        reloadRequired: true
      }
    } finally {
      this.scanTask = null
      this.scanRequested = false
      this.scheduleWatcher()
    }
  }
  async resume(): Promise<boolean> {
    if (this.repairScanning) return false
    if (this.scanTask) return this.scanner.resume()
    if (this.scanRequested) return false
    this.scanRequested = true
    const generation = this.scanGeneration
    try {
      const metadata = await this.refreshRoots()
      const job = await this.database.getLatestScanJob()
      if (
        !job ||
        !['cancelled', 'paused', 'interrupted', 'failed'].includes(job.state) ||
        generation !== this.scanGeneration ||
        this.stopped
      )
        return false
      if (!job.roots.every((scope) => metadata.folders.some((root) => inside(scope, root))))
        throw new Error('原扫描范围的目录授权已更改，请对当前目录开始新扫描')
      this.lastMode = job.mode
      this.watcherSuspended = false
      const task = this.scanner.continueScan(job.id)
      this.scanTask = task
      void task
        .catch((error) => this.emit('scan-error', error))
        .finally(() => {
          if (this.scanTask === task) this.scanTask = null
          this.scanRequested = false
          this.scheduleWatcher()
        })
      return true
    } finally {
      if (!this.scanTask) this.scanRequested = false
    }
  }
  pause(): Promise<boolean> {
    return this.scanner.pause()
  }
  cancel(): boolean {
    this.watcherSuspended = true
    return this.cancelScan()
  }
  private cancelScan(): boolean {
    this.scanGeneration++
    this.pendingDirectories.clear()
    if (this.watcherTimer) {
      clearTimeout(this.watcherTimer)
      this.watcherTimer = null
    }
    return this.scanner.cancel() || this.scanRequested
  }
  async cancelAndWait(): Promise<void> {
    this.cancelScan()
    await this.scanTask?.catch(() => {})
  }
  /** Fallback polling never queues behind another scan or restarts a user stop. */
  async poll(directory: string): Promise<boolean | undefined> {
    if (
      this.stopped ||
      this.watcherSuspended ||
      this.scanRequested ||
      this.scanTask ||
      this.repairScanning
    )
      return undefined
    const before = this.revision
    await this.scan('watch', [directory])
    return this.revision !== before
  }
  enqueueWatcherChanges(changes: LocalLibraryWatchChange[]): void {
    if (this.stopped) return
    for (const change of changes) {
      const directory = change.kind === 'reconcile' ? change.path : dirname(change.path)
      if (!this.knownRoots.some((root) => inside(directory, root))) continue
      this.pendingDirectories.set(normalizeLibraryFilePath(directory), directory)
    }
    if (this.pendingDirectories.size > 256) {
      const directories = [...this.pendingDirectories.values()]
      this.pendingDirectories.clear()
      for (const root of this.knownRoots)
        if (directories.some((directory) => inside(directory, root)))
          this.pendingDirectories.set(normalizeLibraryFilePath(root), root)
    }
    this.scheduleWatcher()
  }
  private scheduleWatcher(): void {
    if (
      this.stopped ||
      this.watcherSuspended ||
      this.scanRequested ||
      this.repairScanning ||
      this.scanTask ||
      this.watcherDraining ||
      this.watcherTimer ||
      !this.pendingDirectories.size
    )
      return
    this.watcherTimer = setTimeout(() => {
      this.watcherTimer = null
      void this.drainWatcher().catch((error) => this.emit('scan-error', error))
    }, this.options.watcherDebounceMs ?? 350)
  }
  private async drainWatcher(): Promise<void> {
    if (
      this.stopped ||
      this.scanRequested ||
      this.scanTask ||
      this.repairScanning ||
      this.watcherDraining
    )
      return
    this.watcherDraining = true
    let reschedule = true
    const generation = this.scanGeneration
    let directories: string[] = []
    try {
      const roots = await this.options.resolveRoots()
      directories = [...this.pendingDirectories.values()]
      if (
        generation !== this.scanGeneration ||
        this.scanRequested ||
        this.scanTask ||
        this.repairScanning ||
        this.stopped
      )
        return
      const scopes: string[] = []
      for (let directory of directories) {
        while (roots.some((root) => inside(directory, root))) {
          try {
            if ((await stat(directory)).isDirectory()) break
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          const parent = dirname(directory)
          if (parent === directory) break
          directory = parent
        }
        if (
          !roots.some((root) => inside(directory, root)) ||
          scopes.some((scope) => inside(directory, scope))
        )
          continue
        for (let index = scopes.length - 1; index >= 0; index--)
          if (inside(scopes[index], directory)) scopes.splice(index, 1)
        scopes.push(directory)
      }
      // Stat/authorization may have yielded to a manual scan or mutation. Keep
      // the coalesced work until we can synchronously reserve the scanner.
      if (
        generation !== this.scanGeneration ||
        this.scanRequested ||
        this.scanTask ||
        this.repairScanning ||
        this.stopped
      )
        return
      for (const directory of directories)
        this.pendingDirectories.delete(normalizeLibraryFilePath(directory))
      if (scopes.length) await this.scan('watch', scopes)
    } catch (error) {
      // Retain the work, but don't spin on an offline disk/permission failure.
      // The next filesystem event or fallback poll supplies the retry trigger.
      reschedule = false
      if (generation === this.scanGeneration && !this.stopped) {
        for (const directory of directories)
          this.pendingDirectories.set(normalizeLibraryFilePath(directory), directory)
      }
      throw error
    } finally {
      this.watcherDraining = false
      if (reschedule) this.scheduleWatcher()
    }
  }
  destroy(): void {
    this.stopped = true
    this.selections.destroy()
    this.queueBuilds.destroy()
    this.playlistRepair?.destroy()
    if (this.watcherTimer) clearTimeout(this.watcherTimer)
    this.pendingDirectories.clear()
    this.scanner.cancel()
    this.options.closeDatabase()
  }
}
