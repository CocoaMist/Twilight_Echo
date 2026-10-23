import type {
  LocalMusicLibraryDocument,
  LocalLibraryRemovalMode,
  LocalLibraryTrackSelection
} from '../../shared/localLibrary.ts'
import type { LocalLibraryFileIdentity } from '../../shared/localLibraryScan.ts'
import type { LibraryPlaybackQueueReference } from '../../shared/playbackSession.ts'
import type { DuplicateCandidate } from '../../shared/duplicateDetection.ts'
import type { LibrarySelectionApi } from '../../shared/librarySelection.ts'
import type { CoreStateApi } from '../../shared/coreState.ts'
import type { CoreInboxDatabase } from '../../shared/coreInbox.ts'
import type { CoreVersionsApi } from '../../shared/coreVersions.ts'
import type { CoreStatisticsApi } from '../../shared/coreStatistics.ts'
import type { CorePersonalRestoreApi } from '../../shared/coreBackup.ts'
import type { CoreQueueImportApi } from '../../shared/coreQueueImport.ts'
import type { CoreQueueRestoreApi } from '../../shared/coreQueueRestore.ts'
import type { CoreQueueExtensionApi } from '../../shared/corePersonalized.ts'
import type { CoreHeartQueueApi } from '../../shared/coreHeart.ts'
import type { CoreSourceRecoveryApi } from '../../shared/coreSourceRecovery.ts'
import type { CatalogDatabaseApi } from '../../shared/musicCatalog.ts'
import type {
  LibraryDatabaseApi,
  LibraryMetadata,
  LibraryScanCommit,
  LibraryScanJob,
  LibraryScanStartRequest,
  LibraryScanDirectoryResult,
  LibraryScanDirectoryPage,
  LibraryScanWorkPage,
  LibraryScanFinishResult,
  LibraryScanDatabaseApi
} from '../../shared/libraryDatabase.ts'

/** Main-process-only capabilities. Never expose this transport directly to a renderer. */
export interface LibraryDocumentExportOptions {
  maxBytes?: number
  redactPrivateData?: boolean
}
export interface PersonalLibraryPreview {
  incoming: number
  current: number
  conflicts: number
  revision: number
}
import type {
  LibraryRemovalOperation,
  LibraryRemovalResult
} from '../../shared/coreLibraryMaintenance.ts'
export type {
  LibraryRemovalItem,
  LibraryRemovalOperation,
  LibraryRemovalResult
} from '../../shared/coreLibraryMaintenance.ts'
export interface LibraryDuplicateCandidatePage {
  items: DuplicateCandidate[]
  revision: number
  /** Monotonic physical row cursor; null after the complete snapshot was read. */
  nextCursor: number | null
}
export interface LibraryDatabaseWorkerApi
  extends
    LibraryDatabaseApi,
    LibraryScanDatabaseApi,
    LibrarySelectionApi,
    CoreStateApi,
    CoreInboxDatabase,
    CoreVersionsApi,
    CoreStatisticsApi,
    CorePersonalRestoreApi,
    CoreQueueImportApi,
    CoreQueueRestoreApi,
    CoreQueueExtensionApi,
    CoreHeartQueueApi,
    CoreSourceRecoveryApi,
    CatalogDatabaseApi {
  insertCorePlaybackQueue(id: string, revision: number, edit: Extract<import('../../shared/libraryDatabase.ts').LibraryQueueEdit, { kind: 'insert' }>): Promise<import('../../shared/libraryDatabase.ts').LibraryQueueEditResult>
  /** Current and SQL-selected successor, read together without exporting metadata or holes. */
  readLibraryQueuePlaybackWindow(
    id: string,
    revision: number,
    index: number,
    wrap: boolean
  ): Promise<import('../../shared/libraryDatabase.ts').LibraryQueuePlaybackWindow>
  /** Preview one playable neighbour without moving the durable cursor or
   * hydrating the intervening holes. Main-only renderer-free transport. */
  readLibraryQueueNeighbor(
    id: string,
    revision: number,
    index: number,
    direction: 1 | -1,
    wrap: boolean
  ): Promise<import('../../shared/libraryDatabase.ts').LibraryQueuePage['items'][number] | null>
  buildLibraryQueue(
    command: import('../../shared/libraryQueueBuild.ts').LibraryQueueBuildCommand
  ): Promise<import('../../shared/libraryQueueBuild.ts').LibraryQueueBuildReply>
  repairCandidates(
    command: import('../../shared/playlistRepair.ts').LibraryRepairCandidateCommand
  ): Promise<import('../../shared/playlistRepair.ts').LibraryRepairCandidateReply>
  /** Read-only analysis projection; no lyrics, artwork or arbitrary Track payloads. */
  readDuplicateCandidates(
    after?: number,
    limit?: number,
    expectedRevision?: number
  ): Promise<LibraryDuplicateCandidatePage>
  /** Bounded portable snapshot; deliberately absent from renderer query IPC. */
  exportPlaybackQueue(
    reference: LibraryPlaybackQueueReference,
    maxBytes: number
  ): Promise<{
    queue: Record<string, unknown>[]
    queueIndex: number
    libraryRevision: number
  }>
  setLibraryRoots(folders: string[]): Promise<LibraryMetadata>
  resetLibrary(expectedRevision?: number): Promise<{
    metadata: LibraryMetadata
    removedTrackIds: string[]
    removedFilePaths: string[]
  }>
  clearFileExclusions(
    filePaths: string[],
    expectedRevision?: number
  ): Promise<{ metadata: LibraryMetadata; clearedFilePaths: string[] }>
  beginRemoval(
    id: string,
    mode: LocalLibraryRemovalMode,
    items: LocalLibraryTrackSelection[]
  ): Promise<LibraryRemovalOperation>
  getPendingRemoval(): Promise<LibraryRemovalOperation | null>
  markRemovalAttempting(id: string, filePath: string): Promise<LibraryRemovalOperation>
  settleRemovalItem(
    id: string,
    filePath: string,
    succeeded: boolean,
    error?: string
  ): Promise<LibraryRemovalOperation>
  finishRemoval(id: string): Promise<LibraryRemovalResult>
  recoverRemoval(): Promise<LibraryRemovalResult | null>
  recoverRemovalJournal(
    id: string,
    items: LocalLibraryTrackSelection[]
  ): Promise<LibraryRemovalResult>
  exportDocument(options?: LibraryDocumentExportOptions): Promise<LocalMusicLibraryDocument>
  replaceDocument(
    document: LocalMusicLibraryDocument,
    expectedRevision?: number
  ): Promise<LibraryMetadata>
  updateConfiguration(
    configuration: Pick<LibraryMetadata, 'folders' | 'exclusions'>,
    expectedRevision?: number
  ): Promise<LibraryMetadata>
  backupTo(destination: string): Promise<void>
  restorePersonalLibrary(
    document: LocalMusicLibraryDocument,
    conflict: 'keep-local' | 'use-backup',
    restoreId: string,
    expectedRevision: number
  ): Promise<LibraryMetadata>
  previewPersonalLibrary(document: LocalMusicLibraryDocument): Promise<PersonalLibraryPreview>
  restoreDocument(
    document: LocalMusicLibraryDocument,
    restoreId: string,
    expectedRevision: number
  ): Promise<LibraryMetadata>
  startScan(job: LibraryScanStartRequest): Promise<LibraryScanJob>
  setScanState(id: string, state: LibraryScanJob['state']): Promise<void>
  listScanJobs(): Promise<LibraryScanJob[]>
  getLatestScanJob(): Promise<LibraryScanJob | null>
  getFileIdentities(offset?: number, limit?: number): Promise<LocalLibraryFileIdentity[]>
  commitScanBatch(batch: LibraryScanCommit): Promise<LibraryMetadata>
  resumeScan(id: string): Promise<LibraryScanJob>
  claimScanDirectories(id: string, limit?: number): Promise<LibraryScanDirectoryPage>
  recordScanDirectory(id: string, result: LibraryScanDirectoryResult): Promise<void>
  recordScanFiles(id: string, identities: LocalLibraryFileIdentity[]): Promise<void>
  claimScanFiles(id: string, limit?: number): Promise<LibraryScanWorkPage>
  finishScan(id: string): Promise<LibraryScanFinishResult>
}
export type DatabaseMethod = keyof LibraryDatabaseWorkerApi
export const DATABASE_METHODS = new Set<DatabaseMethod>([
  'catalogStatus', 'catalogAdvance', 'catalogQuery', 'catalogDetail', 'catalogSources',
  'catalogSync', 'catalogProjectVersions', 'catalogResolve',
  'corePersonalRestore',
  'coreStateOpen',
  'coreStateStatus',
  'coreStateRead',
  'coreStateWrite',
  'coreVersionsReplace',
  'coreInboxWrite',
  'coreStatisticsStatus',
  'coreStatisticsBegin',
  'coreStatisticsStage',
  'coreStatisticsCommit',
  'coreStatisticsAbort',
  'coreMigrationBegin',
  'coreMigrationStage',
  'coreMigrationCommit',
  'coreMigrationAbort',
  'createTrackSelection',
  'readTrackSelection',
  'closeTrackSelection',
  'repairCandidates',
  'syncPlaylistView',
  'lookupPlaylistTracks',
  'lookupTracksByPaths',
  'readDuplicateCandidates',
  'syncListeningHistory',
  'getMetadata',
  'setLibraryRoots',
  'resetLibrary',
  'clearFileExclusions',
  'beginRemoval',
  'getPendingRemoval',
  'markRemovalAttempting',
  'settleRemovalItem',
  'finishRemoval',
  'recoverRemoval',
  'recoverRemovalJournal',
  'queryTracks',
  'queryCollections',
  'getTracksByIds',
  'patchTracks',
  'createLibraryQueue',
  'buildLibraryQueue',
  'importLegacyPlaybackQueue',
  'restoreNamedPlaybackQueue',
  'extendPlaybackQueue',
  'insertCorePlaybackQueue',
  'restoreHeartBaseQueue',
  'replacePlaybackQueueSource',
  'readLibraryQueue',
  'readLibraryQueueNeighbor',
  'readLibraryQueuePlaybackWindow',
  'getLibraryQueue',
  'editLibraryQueue',
  'deleteLibraryQueue',
  'syncLibraryQueueReferences',
  'collectLibraryQueueGarbage',
  'exportPlaybackQueue',
  'exportDocument',
  'replaceDocument',
  'backupTo',
  'restoreDocument',
  'restorePersonalLibrary',
  'previewPersonalLibrary',
  'startScan',
  'setScanState',
  'listScanJobs',
  'getLatestScanJob',
  'getFileIdentities',
  'commitScanBatch',
  'resumeScan',
  'claimScanDirectories',
  'recordScanDirectory',
  'recordScanFiles',
  'claimScanFiles',
  'finishScan',
  'getScanProgress',
  'getScanAudioMetadata',
  'getScanCueDefinition',
  'putScanCueDefinition',
  'updateConfiguration'
])
export type LibraryDatabaseWorkerRequest =
  | { kind: 'open'; libraryFilePath?: string; coreStateFilePath?: string; coverCacheDir?: string }
  | { kind: 'call'; requestId: string; method: DatabaseMethod; args: unknown[] }
  | { kind: 'close'; requestId: string }
export type LibraryDatabaseWorkerMessage =
  | { kind: 'library-changed'; revision: number }
  | { kind: 'ready' }
  | { kind: 'opened' }
  | { kind: 'open-error'; error: string }
  | { kind: 'response'; requestId: string; ok: true; value: unknown }
  | { kind: 'response'; requestId: string; ok: false; error: string; errorCode?: string }
