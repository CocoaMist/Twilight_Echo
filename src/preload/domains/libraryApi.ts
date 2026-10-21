import { IPC } from '../../shared/ipcChannels.ts'
import { ipcRenderer } from 'electron'
import type {
  DuplicateDetectionReadApi,
  DuplicateDetectionResult,
  LibraryChange,
  LocalLibraryClearExclusionsRequest,
  LocalLibraryClearExclusionsResult,
  LocalLibraryRemoveRequest,
  LocalLibraryRemoveResult,
  LocalLibraryResetResult,
  LocalLibraryRestoreRequest,
  LocalLibraryRestoreResult,
  LocalLibraryScanProgress,
  LocalLibraryScanStatus,
  LocalLibraryScanUpdate,
  LocalLibraryTagRestoreRequest,
  LocalLibraryTagRestoreResult,
  LocalLibraryTagWriteRequest,
  LocalLibraryTagWriteResult,
  LibraryWatcherStatusSnapshot
} from '../types'
import type {
  LibraryQuery,
  LibraryTrackPatch,
  LibraryCollectionKind
} from '../../shared/libraryDatabase.ts'

const duplicateDetectionApi: DuplicateDetectionReadApi = {
  detectDuplicates: (): Promise<DuplicateDetectionResult> =>
    ipcRenderer.invoke(IPC.library.detectDuplicates)
}

export const libraryAndFileSystemApi = {
  library: {
    getStorageMode: (): Promise<'json' | 'sqlite'> =>
      ipcRenderer.invoke(IPC.library.getStorageMode),
    removeTracks: (request: LocalLibraryRemoveRequest): Promise<LocalLibraryRemoveResult> =>
      ipcRenderer.invoke(IPC.library.removeTracks, request),
    clearExclusions: (
      request: LocalLibraryClearExclusionsRequest
    ): Promise<LocalLibraryClearExclusionsResult> =>
      ipcRenderer.invoke(IPC.library.clearExclusions, request),
    restoreExclusions: (request: LocalLibraryRestoreRequest): Promise<LocalLibraryRestoreResult> =>
      ipcRenderer.invoke(IPC.library.restoreExclusions, request),
    reset: (): Promise<LocalLibraryResetResult> => ipcRenderer.invoke(IPC.library.reset),
    ...duplicateDetectionApi,
    writeTags: (request: LocalLibraryTagWriteRequest): Promise<LocalLibraryTagWriteResult> =>
      ipcRenderer.invoke(IPC.library.writeTags, request),
    restoreTags: (request: LocalLibraryTagRestoreRequest): Promise<LocalLibraryTagRestoreResult> =>
      ipcRenderer.invoke(IPC.library.restoreTags, request),
    scanStartup: (): Promise<LocalLibraryScanUpdate> => ipcRenderer.invoke(IPC.library.scanStartup),
    scanFull: (): Promise<LocalLibraryScanUpdate> => ipcRenderer.invoke(IPC.library.scanFull),
    getScanStatus: (): Promise<LocalLibraryScanStatus> =>
      ipcRenderer.invoke(IPC.library.getScanStatus),
    getWatcherStatus: (): Promise<LibraryWatcherStatusSnapshot> =>
      ipcRenderer.invoke(IPC.library.getWatcherStatus),
    pauseScan: (): Promise<boolean> => ipcRenderer.invoke(IPC.library.pauseScan),
    resumeScan: (): Promise<boolean> => ipcRenderer.invoke(IPC.library.resumeScan),
    cancelScan: (): Promise<boolean> => ipcRenderer.invoke(IPC.library.cancelScan),
    database: {
      buildQueue: (
        command: import('../../shared/libraryQueueBuild.ts').LibraryQueueBuildCommand
      ): Promise<import('../../shared/libraryQueueBuild.ts').LibraryQueueBuildReply> =>
        ipcRenderer.invoke(IPC.library.databaseBuildQueue, command),
      selection: (
        command: import('../../shared/librarySelection.ts').LibrarySelectionCommand
      ): Promise<import('../../shared/librarySelection.ts').LibrarySelectionReply> =>
        ipcRenderer.invoke(IPC.library.databaseSelection, command),
      repairPlaylist: (
        request: import('../../shared/playlistRepair.ts').LibraryPlaylistRepairRequest
      ): Promise<import('../../shared/playlistRepair.ts').LibraryPlaylistRepairResponse> =>
        ipcRenderer.invoke(IPC.library.databaseRepairPlaylist, request),
      syncPlaylistView: (
        request: import('../../shared/libraryDatabase.ts').LibraryPlaylistViewSync
      ) => ipcRenderer.invoke(IPC.library.databaseSyncPlaylistView, request),
      syncListeningHistory: (
        request: import('../../shared/libraryDatabase.ts').LibraryHistorySyncRequest
      ) => ipcRenderer.invoke(IPC.library.databaseSyncListeningHistory, request),
      scanDirectories: (
        request: Parameters<
          import('../../shared/libraryDatabase.ts').LibraryFileMutationApi['scanDirectories']
        >[0]
      ): Promise<LocalLibraryScanUpdate> =>
        ipcRenderer.invoke(IPC.library.databaseScanDirectories, request),
      removeFiles: (
        request: Parameters<
          import('../../shared/libraryDatabase.ts').LibraryFileMutationApi['removeFiles']
        >[0]
      ) => ipcRenderer.invoke(IPC.library.databaseRemoveFiles, request),
      getMetadata: () => ipcRenderer.invoke(IPC.library.databaseMetadata),
      queryTracks: (query?: LibraryQuery) =>
        ipcRenderer.invoke(IPC.library.databaseQueryTracks, query),
      queryCollections: (kind: LibraryCollectionKind, query?: LibraryQuery) =>
        ipcRenderer.invoke(IPC.library.databaseQueryCollections, kind, query),
      getTracksByIds: (ids: string[], revision?: number) =>
        ipcRenderer.invoke(IPC.library.databaseTracksByIds, ids, revision),
      lookupTracksByPaths: (paths: string[], revision?: number) =>
        ipcRenderer.invoke(IPC.library.databaseLookupPaths, paths, revision),
      lookupPlaylistTracks: (
        request: import('../../shared/libraryDatabase.ts').LibraryPlaylistLookupRequest,
        revision?: number
      ) => ipcRenderer.invoke(IPC.library.databaseLookupPlaylist, request, revision),
      patchTracks: (patches: LibraryTrackPatch[]) =>
        ipcRenderer.invoke(IPC.library.databasePatchTracks, patches),
      createQueue: (query: LibraryQuery, selectedId?: string) =>
        ipcRenderer.invoke(IPC.library.databaseCreateQueue, query, selectedId),
      readQueue: (
        id: string,
        offset?: number,
        limit?: number,
        options?: import('../../shared/libraryDatabase.ts').LibraryQueueReadOptions
      ) =>
        options === undefined
          ? ipcRenderer.invoke(IPC.library.databaseReadQueue, id, offset, limit)
          : ipcRenderer.invoke(IPC.library.databaseReadQueue, id, offset, limit, options),
      getQueue: (id: string) => ipcRenderer.invoke(IPC.library.databaseGetQueue, id),
      editQueue: (
        id: string,
        revision: number,
        edit: import('../../shared/libraryDatabase.ts').LibraryQueueEdit
      ) => ipcRenderer.invoke(IPC.library.databaseEditQueue, id, revision, edit),
      deleteQueue: (id: string, revision: number) =>
        ipcRenderer.invoke(IPC.library.databaseDeleteQueue, id, revision),
      syncQueueReferences: (owner: string, ids: string[]) =>
        ipcRenderer.invoke(IPC.library.databaseSyncQueueReferences, owner, ids),
      collectQueueGarbage: (olderThanMs?: number) =>
        ipcRenderer.invoke(IPC.library.databaseCollectQueueGarbage, olderThanMs)
    },
    onChanged: (cb: (change: LibraryChange | undefined) => void): (() => void) => {
      const handler = (_event, change: LibraryChange | undefined): void => cb(change)
      ipcRenderer.on(IPC.library.changed, handler)
      return () => ipcRenderer.removeListener(IPC.library.changed, handler)
    },
    onCoversMissing: (cb: (info: { dirtyCount: number }) => void): (() => void) => {
      const handler = (_event, info: { dirtyCount: number }): void => cb(info)
      ipcRenderer.on(IPC.library.coversMissing, handler)
      return () => ipcRenderer.removeListener(IPC.library.coversMissing, handler)
    },
    onScanProgress: (cb: (progress: LocalLibraryScanProgress) => void): (() => void) => {
      const handler = (_event, progress: LocalLibraryScanProgress): void => cb(progress)
      ipcRenderer.on(IPC.library.scanProgress, handler)
      return () => ipcRenderer.removeListener(IPC.library.scanProgress, handler)
    },
    onScanStatus: (cb: (status: LocalLibraryScanStatus) => void): (() => void) => {
      const handler = (_event, status: LocalLibraryScanStatus): void => cb(status)
      ipcRenderer.on(IPC.library.scanStatus, handler)
      return () => ipcRenderer.removeListener(IPC.library.scanStatus, handler)
    }
  },
  fs: {
    scanMusicFiles: (folderPath: string): Promise<unknown[]> =>
      ipcRenderer.invoke('fs:scanMusicFiles', folderPath),
    getAudioFileUrl: (filePath: string): Promise<string> =>
      ipcRenderer.invoke('fs:getAudioFileUrl', filePath),
    isAudioFileAuthorized: (filePath: string): Promise<boolean> =>
      ipcRenderer.invoke('fs:isAudioFileAuthorized', filePath),
    areAudioFilesAuthorized: (filePaths: string[]): Promise<boolean[]> =>
      ipcRenderer.invoke('fs:areAudioFilesAuthorized', filePaths),
    onScanProgress: (cb: (progress: { current: number; total: number }) => void): (() => void) => {
      const handler = (_event, data: { current: number; total: number }): void => cb(data)
      ipcRenderer.on('fs:scanProgress', handler)
      return () => ipcRenderer.removeListener('fs:scanProgress', handler)
    }
  }
}
