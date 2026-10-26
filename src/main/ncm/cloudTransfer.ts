import { randomUUID } from 'node:crypto'
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { runtime } from '../core/runtime.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import { normalizeIpcString } from '../security/ipcValidation.ts'
import { normalizeCloudSongId } from './cloudTransferHelpers.ts'
import { CoreNcmCloudTransferService } from '../../core/ncm/cloudTransferService.ts'
import { chooseNcmCloudDownloadFile, chooseNcmCloudUploadFiles } from './cloudTransferPlatform.ts'
import { NCM_CLOUD_TRANSFER_PROGRESS_CHANNEL } from '../../shared/ncmCloud.ts'

// Compatibility composition until the single production Core switch.
const clients = new Map<string, WebContents>()
const transfers = new CoreNcmCloudTransferService({
  chooseUploadFiles: (clientId) => chooseNcmCloudUploadFiles(clients.get(clientId)),
  chooseDownloadFile: (clientId, fileName) =>
    chooseNcmCloudDownloadFile(fileName, clients.get(clientId)),
  callProvider: async <T>(method, args, signal, idempotencyKey): Promise<T> => {
    await runtime.pluginManagerReady
    if (!runtime.pluginManager) throw new Error('网易云 Provider 尚未就绪')
    return (await runtime.pluginManager.callProvider('ncm', method, args, {
      signal,
      idempotencyKey
    })) as T
  },
  now: Date.now,
  newId: randomUUID,
  changed: () => {},
  progress: (clientId, update) => {
    const sender = clients.get(clientId)
    if (sender && !sender.isDestroyed()) sender.send(NCM_CLOUD_TRANSFER_PROGRESS_CHANNEL, update)
  }
})

function client(event: IpcMainInvokeEvent): string {
  assertTrustedIpcSender(event, 'NCM cloud IPC')
  const id = String(event.sender.id)
  if (!clients.has(id)) {
    clients.set(id, event.sender)
    event.sender.once('destroyed', () => {
      clients.delete(id)
      transfers.disconnect(id)
    })
  }
  return id
}

export function setupNcmCloudTransferIpc(): void {
  ipcMain.handle('ncmCloud:chooseUploadFiles', (event) =>
    transfers.chooseUploadFiles(client(event))
  )
  ipcMain.handle('ncmCloud:upload', (event, rawHandle: unknown) => {
    const id = client(event)
    return transfers.upload(id, normalizeIpcString(rawHandle, 'NCM cloud file handle', 128))
  })
  ipcMain.handle('ncmCloud:download', (event, rawRequest: unknown) => {
    const id = client(event)
    if (!rawRequest || typeof rawRequest !== 'object') throw new Error('云盘下载参数无效')
    const input = rawRequest as Record<string, unknown>
    return transfers.download(id, {
      cloudSongId: normalizeCloudSongId(input.cloudSongId),
      fileName: normalizeIpcString(input.fileName, 'NCM cloud file name', 255)
    })
  })
  ipcMain.handle('ncmCloud:cancel', (event, rawTransferId: unknown) => {
    const id = client(event)
    return transfers.cancel(normalizeIpcString(rawTransferId, 'NCM cloud transfer id', 128), id)
  })
}

export function shutdownNcmCloudTransfers(): Promise<void> {
  return transfers.shutdown()
}
