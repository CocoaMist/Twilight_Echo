import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../shared/ipcChannels.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import type {
  LibraryDatabaseApi,
  LibraryQuery,
  LibraryCollectionKind,
  LibraryTrackPatch
} from '../../shared/libraryDatabase.ts'
import type { LibraryFileMutationApi } from '../../shared/libraryDatabase.ts'
import type { LibraryPlaylistRepairService } from '../library/libraryPlaylistRepairService.ts'
import type { LibrarySelectionService } from '../library/librarySelectionService.ts'
import type { LibraryQueueBuildService } from '../library/libraryQueueBuildService.ts'
import {
  validateLibraryFileRemoval,
  validateLibraryDirectoryScan,
  validateLibraryHistorySync,
  validateLibraryPlaylistViewSync,
  validateLibraryQueueReadOptions,
  validateLibraryQueueEdit
} from '../library/libraryDatabaseValidation.ts'

/**
 * The lifecycle injects the sole application owner in SQLite preview mode.
 * Default/release JSON profiles reject these calls without opening another
 * worker or creating a second library authority.
 */
export function setupLibraryDatabaseIpc(
  ipc: IpcMain,
  database?: LibraryDatabaseApi,
  mutations?: LibraryFileMutationApi,
  repair?: LibraryPlaylistRepairService,
  selections?: Pick<LibrarySelectionService, 'handle'>,
  queueBuilds?: Pick<LibraryQueueBuildService, 'handle'>
): void {
  ipc.handle(IPC.library.getStorageMode, (event) => {
    assertTrustedIpcSender(event, 'library storage mode IPC')
    return database ? 'sqlite' : 'json'
  })
  const unavailable = async (event: IpcMainInvokeEvent): Promise<never> => {
    assertTrustedIpcSender(event, 'library database IPC')
    throw new Error('SQLite 曲库尚未启用；当前曲库仍使用 JSON，请使用现有曲库接口')
  }
  const ready = (event: IpcMainInvokeEvent) => {
    assertTrustedIpcSender(event, 'library database IPC')
    return database!
  }
  ipc.handle(
    IPC.library.databaseBuildQueue,
    database && queueBuilds
      ? (event, command: unknown) => {
          assertTrustedIpcSender(event, 'library queue build IPC')
          return queueBuilds.handle(event.sender, command)
        }
      : unavailable
  )
  ipc.handle(
    IPC.library.databaseSelection,
    database && selections
      ? (event, request: unknown) => {
          assertTrustedIpcSender(event, 'library selection IPC')
          return selections.handle(event.sender, request)
        }
      : unavailable
  )
  ipc.handle(
    IPC.library.databaseRepairPlaylist,
    database && repair
      ? (event, request: unknown) => {
          assertTrustedIpcSender(event, 'library playlist repair IPC')
          return repair.handle(event.sender, request)
        }
      : unavailable
  )
  ipc.handle(
    IPC.library.databaseMetadata,
    database ? (event) => ready(event).getMetadata() : unavailable
  )
  ipc.handle(
    IPC.library.databaseSyncPlaylistView,
    database
      ? (event, request: unknown) => {
          const api = ready(event)
          validateLibraryPlaylistViewSync(request)
          return api.syncPlaylistView(request)
        }
      : unavailable
  )
  ipc.handle(
    IPC.library.databaseSyncListeningHistory,
    database
      ? (event, request: unknown) => {
          const api = ready(event)
          validateLibraryHistorySync(request)
          return api.syncListeningHistory(request)
        }
      : unavailable
  )
  ipc.handle(
    IPC.library.databaseQueryTracks,
    database ? (event, query?: LibraryQuery) => ready(event).queryTracks(query) : unavailable
  )
  ipc.handle(
    IPC.library.databaseQueryCollections,
    database
      ? (event, kind: LibraryCollectionKind, query?: LibraryQuery) =>
          ready(event).queryCollections(kind, query)
      : unavailable
  )
  ipc.handle(
    IPC.library.databaseTracksByIds,
    database
      ? (event, ids: string[], revision?: number) => {
          const api = ready(event)
          return revision === undefined
            ? api.getTracksByIds(ids)
            : api.getTracksByIds(ids, revision)
        }
      : unavailable
  )
  ipc.handle(
    IPC.library.databaseLookupPaths,
    database
      ? (event, paths: string[], revision?: number) =>
          ready(event).lookupTracksByPaths(paths, revision)
      : unavailable
  )
  ipc.handle(
    IPC.library.databaseLookupPlaylist,
    database
      ? (
          event,
          request: import('../../shared/libraryDatabase.ts').LibraryPlaylistLookupRequest,
          revision?: number
        ) => ready(event).lookupPlaylistTracks(request, revision)
      : unavailable
  )
  ipc.handle(
    IPC.library.databasePatchTracks,
    database
      ? (event, patches: LibraryTrackPatch[]) => ready(event).patchTracks(patches)
      : unavailable
  )
  ipc.handle(
    IPC.library.databaseScanDirectories,
    database && mutations
      ? (event, request: unknown) => {
          assertTrustedIpcSender(event, 'library database scoped scan IPC')
          validateLibraryDirectoryScan(request)
          return mutations.scanDirectories(request)
        }
      : unavailable
  )
  ipc.handle(
    IPC.library.databaseRemoveFiles,
    database && mutations
      ? (event, request: unknown) => {
          assertTrustedIpcSender(event, 'library database removal IPC')
          validateLibraryFileRemoval(request)
          return mutations.removeFiles(request)
        }
      : unavailable
  )
  ipc.handle(
    IPC.library.databaseCreateQueue,
    database
      ? (event, query: LibraryQuery, selectedId?: string) =>
          ready(event).createLibraryQueue(query, selectedId)
      : unavailable
  )
  ipc.handle(
    IPC.library.databaseReadQueue,
    database
      ? (
          event,
          id: string,
          offset?: number,
          limit?: number,
          options?: import('../../shared/libraryDatabase.ts').LibraryQueueReadOptions
        ) => (
          validateLibraryQueueReadOptions(options),
          options === undefined
            ? ready(event).readLibraryQueue(id, offset, limit)
            : ready(event).readLibraryQueue(id, offset, limit, options)
        )
      : unavailable
  )
  ipc.handle(
    IPC.library.databaseGetQueue,
    database ? (event, id: string) => ready(event).getLibraryQueue(id) : unavailable
  )
  ipc.handle(
    IPC.library.databaseEditQueue,
    database
      ? (
          event,
          id: string,
          revision: number,
          edit: import('../../shared/libraryDatabase.ts').LibraryQueueEdit
        ) => (validateLibraryQueueEdit(edit), ready(event).editLibraryQueue(id, revision, edit))
      : unavailable
  )
  ipc.handle(
    IPC.library.databaseDeleteQueue,
    database
      ? (event, id: string, revision: number) => ready(event).deleteLibraryQueue(id, revision)
      : unavailable
  )
  ipc.handle(
    IPC.library.databaseSyncQueueReferences,
    database
      ? (event, owner: string, ids: string[]) => ready(event).syncLibraryQueueReferences(owner, ids)
      : unavailable
  )
  ipc.handle(
    IPC.library.databaseCollectQueueGarbage,
    database
      ? (event, olderThanMs?: number) => ready(event).collectLibraryQueueGarbage(olderThanMs)
      : unavailable
  )
}
