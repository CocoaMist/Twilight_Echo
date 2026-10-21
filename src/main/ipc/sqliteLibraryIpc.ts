import type { IpcMain } from 'electron'
import type { LibraryDatabaseRuntime } from '../library/libraryDatabaseRuntime.ts'
import type {
  LocalLibrarySnapshotInput,
  LocalLibraryRemoveRequest,
  LocalLibraryRestoreRequest
} from '../../shared/localLibrary.ts'
import { IPC } from '../../shared/ipcChannels.ts'
import { runtime } from '../core/runtime'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import { stringifyJsonForIpcStorage } from '../security/ipcValidation.ts'
import { filterAuthorizedLibraryRoots } from '../security/localPaths'
import { MAX_MUSIC_LIBRARY_BYTES } from '../library/libraryRepository.ts'
import { getLibraryWatcherStatusSnapshot } from '../library/watcher.ts'
import { redactSensitiveText } from '../security/secureStorage.ts'

/** Existing document IPC keeps its full-document meaning. It is not the
 * paginated API, and it never reads or writes retained migration JSON. */
export function registerSqliteLibraryIpc(
  ipc: IpcMain,
  owner: LibraryDatabaseRuntime,
  normalize: {
    normalizeSnapshot(value: unknown): LocalLibrarySnapshotInput
    normalizeRemove(value: unknown): LocalLibraryRemoveRequest
    normalizeExclusions(value: unknown): LocalLibraryRestoreRequest
  }
): void {
  owner.on('changed', (revision: number) =>
    runtime.mainWindow?.webContents.send(IPC.library.changed, { kind: 'database', revision })
  )
  owner.on('status', (status) =>
    runtime.mainWindow?.webContents.send(IPC.library.scanStatus, {
      ...status,
      error: redactSensitiveText(status.error)
    })
  )
  owner.on('scan-error', (error) =>
    console.warn('[library-db]', redactSensitiveText(String(error)))
  )
  const snapshot = async (value: unknown) => {
    const document = normalize.normalizeSnapshot(value)
    document.folders = await filterAuthorizedLibraryRoots(document.folders)
    stringifyJsonForIpcStorage(
      document,
      'music library compatibility snapshot',
      MAX_MUSIC_LIBRARY_BYTES
    )
    return document
  }
  ipc.handle('data:loadMusicLibrary', async (event) => {
    assertTrustedIpcSender(event, 'data IPC')
    return owner.loadLegacyDocument()
  })
  ipc.handle('data:saveMusicLibrary', async (event, value: unknown) => {
    assertTrustedIpcSender(event, 'data IPC')
    return owner.saveLegacyDocument(await snapshot(value))
  })
  ipc.handle(IPC.library.removeTracks, async (event, value: unknown) => {
    assertTrustedIpcSender(event, 'library mutation IPC')
    const request = normalize.normalizeRemove(value)
    request.library = await snapshot(request.library)
    stringifyJsonForIpcStorage(request, 'library removal request', MAX_MUSIC_LIBRARY_BYTES)
    return owner.removeLegacy(request)
  })
  ipc.handle(IPC.library.clearExclusions, async (event, value: unknown) => {
    assertTrustedIpcSender(event, 'library mutation IPC')
    const request = normalize.normalizeExclusions(value)
    request.library = await snapshot(request.library)
    stringifyJsonForIpcStorage(request, 'library exclusion clear request', MAX_MUSIC_LIBRARY_BYTES)
    return owner.clearLegacyExclusions(request.library, request.filePaths)
  })
  ipc.handle(IPC.library.restoreExclusions, async (event, value: unknown) => {
    assertTrustedIpcSender(event, 'library mutation IPC')
    const request = normalize.normalizeExclusions(value)
    request.library = await snapshot(request.library)
    stringifyJsonForIpcStorage(
      request,
      'library exclusion restore request',
      MAX_MUSIC_LIBRARY_BYTES
    )
    const result = await owner.clearLegacyExclusions(request.library, request.filePaths)
    return { library: result.library, restoredFilePaths: result.clearedFilePaths }
  })
  ipc.handle(IPC.library.reset, async (event) => {
    assertTrustedIpcSender(event, 'library reset IPC')
    return owner.reset()
  })
  ipc.handle(IPC.library.scanStartup, async (event) => {
    assertTrustedIpcSender(event, 'library scan IPC')
    return owner.scan('startup')
  })
  ipc.handle(IPC.library.scanFull, async (event) => {
    assertTrustedIpcSender(event, 'library scan IPC')
    return owner.scan('full')
  })
  ipc.handle(IPC.library.getScanStatus, (event) => {
    assertTrustedIpcSender(event, 'library scan IPC')
    const status = owner.getStatus()
    return { ...status, error: redactSensitiveText(status.error) }
  })
  ipc.handle(IPC.library.getWatcherStatus, (event) => {
    assertTrustedIpcSender(event, 'library scan IPC')
    return getLibraryWatcherStatusSnapshot(
      runtime.appSettings.libraryFolders,
      runtime.appSettings.watchLibrary
    )
  })
  ipc.handle(IPC.library.pauseScan, async (event) => {
    assertTrustedIpcSender(event, 'library scan IPC')
    return owner.pause()
  })
  ipc.handle(IPC.library.resumeScan, async (event) => {
    assertTrustedIpcSender(event, 'library scan IPC')
    return owner.resume()
  })
  ipc.handle(IPC.library.cancelScan, (event) => {
    assertTrustedIpcSender(event, 'library scan IPC')
    return owner.cancel()
  })
}
