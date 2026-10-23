import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import type {
  LibraryDatabaseWorkerApi,
  LibraryDocumentExportOptions,
  DatabaseMethod,
  LibraryDatabaseWorkerRequest,
  LibraryDatabaseWorkerMessage
} from './libraryDatabaseProtocol.ts'
import type {
  LibraryQuery,
  LibraryCollectionKind,
  LibraryTrackPatch,
  LibraryScanCommit,
  LibraryScanJob,
  LibraryScanStartRequest,
  LibraryScanDirectoryResult,
  LibraryMetadata,
  LibraryCueDefinitionRecord
} from '../../shared/libraryDatabase.ts'
import type { LocalLibraryFileIdentity } from '../../shared/localLibraryScan.ts'
import type {
  LocalMusicLibraryDocument,
  LocalLibraryRemovalMode,
  LocalLibraryTrackSelection
} from '../../shared/localLibrary.ts'

const require = createRequire(import.meta.url)
export interface DatabaseUtilityProcess {
  postMessage(message: LibraryDatabaseWorkerRequest): void
  kill(): void
  on(event: 'message', listener: (message: LibraryDatabaseWorkerMessage) => void): void
  on(event: 'exit', listener: (code: number | null) => void): void
  on(event: 'error', listener: (error: unknown) => void): void
}
export interface DatabaseServiceOptions {
  changed?(revision: number): void
  serviceEntry: string
  /** Omit only for Core state in development JSON-library mode. */
  libraryFilePath?: string
  /** Reopened with the service connection after a crash, never as a business-write replay. */
  coreStateFilePath?: string
  coverCacheDir?: string
  startupTimeoutMs?: number
  requestTimeoutMs?: number
  maxPendingRequests?: number
  /** Injection point for the actual worker integration test, not a storage fallback. */
  fork?: (entry: string) => DatabaseUtilityProcess
}
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

/** Bounded asynchronous transport. Mutations are never automatically replayed. */
export class LibraryDatabaseServiceClient implements LibraryDatabaseWorkerApi {
  catalogStatus() { return this.call('catalogStatus') }
  catalogAdvance(limit?: number) { return this.call('catalogAdvance', limit) }
  catalogQuery(...args: Parameters<LibraryDatabaseWorkerApi['catalogQuery']>) { return this.call('catalogQuery', ...args) }
  catalogDetail(...args: Parameters<LibraryDatabaseWorkerApi['catalogDetail']>) { return this.call('catalogDetail', ...args) }
  catalogSources(...args: Parameters<LibraryDatabaseWorkerApi['catalogSources']>) { return this.call('catalogSources', ...args) }
  catalogSync(...args: Parameters<LibraryDatabaseWorkerApi['catalogSync']>) { return this.call('catalogSync', ...args) }
  catalogProjectVersions(...args: Parameters<LibraryDatabaseWorkerApi['catalogProjectVersions']>) { return this.call('catalogProjectVersions', ...args) }
  catalogResolve(...args: Parameters<LibraryDatabaseWorkerApi['catalogResolve']>) { return this.call('catalogResolve', ...args) }
  corePersonalRestore() {
    return this.call('corePersonalRestore')
  }
  private readonly options: DatabaseServiceOptions
  private child: DatabaseUtilityProcess | null = null
  private ready: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private startupTimer: NodeJS.Timeout | null = null
  private readonly pending = new Map<string, Pending>()
  private reservations = 0
  private stopped = false
  private closing = false
  private coreStateFilePath: string | undefined

  constructor(options: DatabaseServiceOptions) {
    this.options = options
    this.coreStateFilePath = options.coreStateFilePath
  }

  coreStateOpen(filePath: string) {
    if (this.coreStateFilePath && this.coreStateFilePath !== filePath)
      return Promise.reject(new Error('Core state path is already bound'))
    this.coreStateFilePath = filePath
    return this.call('coreStateOpen', filePath)
  }
  coreStateStatus() {
    return this.call('coreStateStatus')
  }
  coreStatisticsStatus() {
    return this.call('coreStatisticsStatus')
  }
  coreStatisticsBegin(...args: Parameters<LibraryDatabaseWorkerApi['coreStatisticsBegin']>) {
    return this.call('coreStatisticsBegin', ...args)
  }
  coreStatisticsStage(...args: Parameters<LibraryDatabaseWorkerApi['coreStatisticsStage']>) {
    return this.call('coreStatisticsStage', ...args)
  }
  coreStatisticsCommit(id: string) {
    return this.call('coreStatisticsCommit', id)
  }
  coreStatisticsAbort(id: string) {
    return this.call('coreStatisticsAbort', id)
  }
  coreStateRead(...args: Parameters<LibraryDatabaseWorkerApi['coreStateRead']>) {
    return this.call('coreStateRead', ...args)
  }
  coreStateWrite(...args: Parameters<LibraryDatabaseWorkerApi['coreStateWrite']>) {
    return this.call('coreStateWrite', ...args)
  }
  coreVersionsReplace(...args: Parameters<LibraryDatabaseWorkerApi['coreVersionsReplace']>) {
    return this.call('coreVersionsReplace', ...args)
  }
  coreInboxWrite(...args: Parameters<LibraryDatabaseWorkerApi['coreInboxWrite']>) {
    return this.call('coreInboxWrite', ...args)
  }
  coreMigrationBegin(...args: Parameters<LibraryDatabaseWorkerApi['coreMigrationBegin']>) {
    return this.call('coreMigrationBegin', ...args)
  }
  coreMigrationStage(...args: Parameters<LibraryDatabaseWorkerApi['coreMigrationStage']>) {
    return this.call('coreMigrationStage', ...args)
  }
  coreMigrationCommit(id: string) {
    return this.call('coreMigrationCommit', id)
  }
  coreMigrationAbort(id: string) {
    return this.call('coreMigrationAbort', id)
  }

  private open(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Music library database service stopped'))
    if (this.ready) return this.ready
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.ready = ready
    try {
      const child = this.options.fork
        ? this.options.fork(this.options.serviceEntry)
        : (require('electron') as typeof import('electron')).utilityProcess.fork(
            this.options.serviceEntry,
            [],
            { serviceName: 'twilight-library-database', stdio: 'pipe' }
          )
      this.child = child
      child.on('message', (message) => {
        if (this.child !== child) return
        if (message.kind === 'ready')
          child.postMessage({
            kind: 'open',
            libraryFilePath: this.options.libraryFilePath,
            ...(this.coreStateFilePath ? { coreStateFilePath: this.coreStateFilePath } : {}),
            coverCacheDir: this.options.coverCacheDir
          })
        else if (message.kind === 'opened') {
          if (this.startupTimer) clearTimeout(this.startupTimer)
          this.startupTimer = null
          this.readyResolve?.()
          this.readyResolve = null
          this.readyReject = null
        } else if (message.kind === 'open-error') this.fail(new Error(message.error))
        else if (message.kind === 'library-changed') this.options.changed?.(message.revision)
        else if (message.kind === 'response') {
          const pending = this.pending.get(message.requestId)
          if (!pending) return
          clearTimeout(pending.timer)
          this.pending.delete(message.requestId)
          if (message.ok) pending.resolve(message.value)
          else
            pending.reject(
              Object.assign(
                new Error(message.error),
                message.errorCode ? { code: message.errorCode } : {}
              )
            )
        }
      })
      child.on('error', (error) => {
        if (this.child === child)
          this.fail(
            new Error(
              `Music library database process failed: ${String(error)}. Refresh its state before retrying a write.`
            )
          )
      })
      child.on('exit', (code) => {
        if (this.child === child)
          this.fail(
            new Error(
              `Music library database process exited (${code}). Refresh its state before retrying a write.`
            )
          )
      })
      this.startupTimer = setTimeout(
        () => this.fail(new Error('Music library database migration/startup timed out')),
        this.options.startupTimeoutMs ?? 30 * 60_000
      )
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
    return ready
  }

  private fail(error: Error): void {
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = null
    const child = this.child
    this.child = null
    this.readyReject?.(error)
    this.readyReject = null
    this.readyResolve = null
    this.ready = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    child?.kill()
  }

  private async call<M extends DatabaseMethod>(
    method: M,
    ...args: Parameters<LibraryDatabaseWorkerApi[M]>
  ): Promise<Awaited<ReturnType<LibraryDatabaseWorkerApi[M]>>> {
    if (this.closing) throw new Error('Music library database service is closing')
    if (this.reservations >= (this.options.maxPendingRequests ?? 16))
      throw new Error('Music library database request queue is full')
    this.reservations++
    try {
      await this.open()
      if (!this.child) throw new Error('Music library database process is unavailable')
      const requestId = randomUUID()
      const payloadArgs: unknown[] = [...args]
      while (payloadArgs.length && payloadArgs[payloadArgs.length - 1] === undefined)
        payloadArgs.pop()
      return await new Promise<Awaited<ReturnType<LibraryDatabaseWorkerApi[M]>>>(
        (resolve, reject) => {
          const timer = setTimeout(
            () =>
              this.fail(
                new Error(
                  `Music library database request timed out (${method}); its commit outcome is unknown. Refresh before retrying.`
                )
              ),
            this.options.requestTimeoutMs ?? 120_000
          )
          this.pending.set(requestId, {
            resolve: (value) => resolve(value as Awaited<ReturnType<LibraryDatabaseWorkerApi[M]>>),
            reject,
            timer
          })
          try {
            this.child!.postMessage({ kind: 'call', requestId, method, args: payloadArgs })
          } catch (error) {
            this.fail(error instanceof Error ? error : new Error(String(error)))
          }
        }
      )
    } finally {
      this.reservations--
    }
  }

  getMetadata() {
    return this.call('getMetadata')
  }
  syncPlaylistView(request: import('../../shared/libraryDatabase.ts').LibraryPlaylistViewSync) {
    return this.call('syncPlaylistView', request)
  }
  readDuplicateCandidates(after?: number, limit?: number, expectedRevision?: number) {
    return this.call('readDuplicateCandidates', after, limit, expectedRevision)
  }
  syncListeningHistory(
    request: import('../../shared/libraryDatabase.ts').LibraryHistorySyncRequest
  ) {
    return this.call('syncListeningHistory', request)
  }
  setLibraryRoots(folders: string[]) {
    return this.call('setLibraryRoots', folders)
  }
  resetLibrary(expectedRevision?: number) {
    return this.call('resetLibrary', expectedRevision)
  }
  repairCandidates(
    command: import('../../shared/playlistRepair.ts').LibraryRepairCandidateCommand
  ) {
    return this.call('repairCandidates', command)
  }
  beginRemoval(id: string, mode: LocalLibraryRemovalMode, items: LocalLibraryTrackSelection[]) {
    return this.call('beginRemoval', id, mode, items)
  }
  getPendingRemoval() {
    return this.call('getPendingRemoval')
  }
  clearFileExclusions(filePaths: string[], expectedRevision?: number) {
    return this.call('clearFileExclusions', filePaths, expectedRevision)
  }
  markRemovalAttempting(id: string, filePath: string) {
    return this.call('markRemovalAttempting', id, filePath)
  }
  settleRemovalItem(id: string, filePath: string, succeeded: boolean, error?: string) {
    return this.call('settleRemovalItem', id, filePath, succeeded, error)
  }
  finishRemoval(id: string) {
    return this.call('finishRemoval', id)
  }
  recoverRemoval() {
    return this.call('recoverRemoval')
  }
  recoverRemovalJournal(id: string, items: LocalLibraryTrackSelection[]) {
    return this.call('recoverRemovalJournal', id, items)
  }
  queryTracks(query?: LibraryQuery) {
    return this.call('queryTracks', query)
  }
  createTrackSelection(
    request: import('../../shared/librarySelection.ts').LibrarySelectionRequest
  ) {
    return this.call('createTrackSelection', request)
  }
  readTrackSelection(
    id: string,
    cursor?: number,
    projection?: 'tracks' | 'files',
    requireCurrent?: boolean
  ) {
    return this.call('readTrackSelection', id, cursor, projection, requireCurrent)
  }
  closeTrackSelection(id: string) {
    return this.call('closeTrackSelection', id)
  }
  queryCollections(kind: LibraryCollectionKind, query?: LibraryQuery) {
    return this.call('queryCollections', kind, query)
  }
  lookupTracksByPaths(paths: string[], expectedRevision?: number) {
    return this.call('lookupTracksByPaths', paths, expectedRevision)
  }
  lookupPlaylistTracks(
    request: import('../../shared/libraryDatabase.ts').LibraryPlaylistLookupRequest,
    expectedRevision?: number
  ) {
    return this.call('lookupPlaylistTracks', request, expectedRevision)
  }
  getTracksByIds(ids: string[], expectedRevision?: number) {
    return this.call('getTracksByIds', ids, expectedRevision)
  }
  patchTracks(patches: LibraryTrackPatch[]) {
    return this.call('patchTracks', patches)
  }
  createLibraryQueue(query: LibraryQuery, selectedId?: string) {
    return this.call('createLibraryQueue', query, selectedId)
  }
  buildLibraryQueue(command: import('../../shared/libraryQueueBuild.ts').LibraryQueueBuildCommand) {
    return this.call('buildLibraryQueue', command)
  }
  importLegacyPlaybackQueue(
    command: import('../../shared/coreQueueImport.ts').CoreQueueImportCommand
  ) {
    return this.call('importLegacyPlaybackQueue', command)
  }
  restoreNamedPlaybackQueue(
    command: import('../../shared/coreQueueRestore.ts').CoreQueueRestoreCommand
  ) {
    return this.call('restoreNamedPlaybackQueue', command)
  }
  extendPlaybackQueue(
    ...args: Parameters<LibraryDatabaseWorkerApi['extendPlaybackQueue']>
  ): ReturnType<LibraryDatabaseWorkerApi['extendPlaybackQueue']> {
    return this.call('extendPlaybackQueue', ...args)
  }
  insertCorePlaybackQueue(...args: Parameters<LibraryDatabaseWorkerApi['insertCorePlaybackQueue']>): ReturnType<LibraryDatabaseWorkerApi['insertCorePlaybackQueue']> {
    return this.call('insertCorePlaybackQueue', ...args)
  }
  restoreHeartBaseQueue(
    ...args: Parameters<LibraryDatabaseWorkerApi['restoreHeartBaseQueue']>
  ): ReturnType<LibraryDatabaseWorkerApi['restoreHeartBaseQueue']> {
    return this.call('restoreHeartBaseQueue', ...args)
  }
  replacePlaybackQueueSource(
    ...args: Parameters<LibraryDatabaseWorkerApi['replacePlaybackQueueSource']>
  ): ReturnType<LibraryDatabaseWorkerApi['replacePlaybackQueueSource']> {
    return this.call('replacePlaybackQueueSource', ...args)
  }
  readLibraryQueue(
    id: string,
    offset?: number,
    limit?: number,
    options?: import('../../shared/libraryDatabase.ts').LibraryQueueReadOptions
  ) {
    return options === undefined
      ? this.call('readLibraryQueue', id, offset, limit)
      : this.call('readLibraryQueue', id, offset, limit, options)
  }
  getLibraryQueue(id: string) {
    return this.call('getLibraryQueue', id)
  }
  readLibraryQueueNeighbor(
    id: string,
    revision: number,
    index: number,
    direction: 1 | -1,
    wrap: boolean
  ) {
    return this.call('readLibraryQueueNeighbor', id, revision, index, direction, wrap)
  }
  readLibraryQueuePlaybackWindow(id: string, revision: number, index: number, wrap: boolean) {
    return this.call('readLibraryQueuePlaybackWindow', id, revision, index, wrap)
  }
  editLibraryQueue(
    id: string,
    expectedRevision: number,
    edit: import('../../shared/libraryDatabase.ts').LibraryQueueEdit
  ) {
    return this.call('editLibraryQueue', id, expectedRevision, edit)
  }
  deleteLibraryQueue(id: string, expectedRevision: number) {
    return this.call('deleteLibraryQueue', id, expectedRevision)
  }
  syncLibraryQueueReferences(owner: string, ids: string[]) {
    return this.call('syncLibraryQueueReferences', owner, ids)
  }
  collectLibraryQueueGarbage(olderThanMs?: number) {
    return this.call('collectLibraryQueueGarbage', olderThanMs)
  }
  exportPlaybackQueue(
    reference: import('../../shared/playbackSession.ts').LibraryPlaybackQueueReference,
    maxBytes: number
  ) {
    return this.call('exportPlaybackQueue', reference, maxBytes)
  }
  exportDocument(options?: LibraryDocumentExportOptions) {
    return this.call('exportDocument', options)
  }
  replaceDocument(document: LocalMusicLibraryDocument, expectedRevision?: number) {
    return this.call('replaceDocument', document, expectedRevision)
  }
  updateConfiguration(
    configuration: Pick<LibraryMetadata, 'folders' | 'exclusions'>,
    expectedRevision?: number
  ) {
    return this.call('updateConfiguration', configuration, expectedRevision)
  }
  backupTo(destination: string) {
    return this.call('backupTo', destination)
  }
  restoreDocument(
    document: LocalMusicLibraryDocument,
    restoreId: string,
    expectedRevision: number
  ) {
    return this.call('restoreDocument', document, restoreId, expectedRevision)
  }
  restorePersonalLibrary(
    document: LocalMusicLibraryDocument,
    conflict: 'keep-local' | 'use-backup',
    restoreId: string,
    expectedRevision: number
  ) {
    return this.call('restorePersonalLibrary', document, conflict, restoreId, expectedRevision)
  }
  previewPersonalLibrary(document: LocalMusicLibraryDocument) {
    return this.call('previewPersonalLibrary', document)
  }
  startScan(job: LibraryScanStartRequest) {
    return this.call('startScan', job)
  }
  setScanState(id: string, state: LibraryScanJob['state']) {
    return this.call('setScanState', id, state)
  }
  listScanJobs() {
    return this.call('listScanJobs')
  }
  getLatestScanJob() {
    return this.call('getLatestScanJob')
  }
  getFileIdentities(offset?: number, limit?: number) {
    return this.call('getFileIdentities', offset, limit)
  }
  commitScanBatch(batch: LibraryScanCommit) {
    return this.call('commitScanBatch', batch)
  }
  resumeScan(id: string) {
    return this.call('resumeScan', id)
  }
  claimScanDirectories(id: string, limit?: number) {
    return this.call('claimScanDirectories', id, limit)
  }
  recordScanDirectory(id: string, result: LibraryScanDirectoryResult) {
    return this.call('recordScanDirectory', id, result)
  }
  recordScanFiles(id: string, identities: LocalLibraryFileIdentity[]) {
    return this.call('recordScanFiles', id, identities)
  }
  claimScanFiles(id: string, limit?: number) {
    return this.call('claimScanFiles', id, limit)
  }
  finishScan(id: string) {
    return this.call('finishScan', id)
  }
  getScanProgress(id: string) {
    return this.call('getScanProgress', id)
  }
  getScanAudioMetadata(id: string, identities: LocalLibraryFileIdentity[]) {
    return this.call('getScanAudioMetadata', id, identities)
  }
  getScanCueDefinition(id: string, identity: LocalLibraryFileIdentity) {
    return this.call('getScanCueDefinition', id, identity)
  }
  putScanCueDefinition(id: string, record: LibraryCueDefinitionRecord) {
    return this.call('putScanCueDefinition', id, record)
  }

  destroy(): void {
    this.stopped = true
    this.fail(new Error('Music library database service stopped'))
  }

  /** Wait for the serial worker to close both durable connections before reaping it. */
  async close(): Promise<void> {
    if (this.stopped) return
    if (this.closing) throw new Error('Database close already in progress')
    this.closing = true
    try {
      if (!this.child) return
      await this.open()
      const requestId = randomUUID()
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => this.fail(new Error('Database close outcome unknown')),
          this.options.requestTimeoutMs ?? 120_000
        )
        this.pending.set(requestId, { resolve: () => resolve(), reject, timer })
        try {
          this.child!.postMessage({ kind: 'close', requestId })
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)))
        }
      })
    } finally {
      this.destroy()
    }
  }
}
