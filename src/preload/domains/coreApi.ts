import { ipcRenderer } from 'electron'
import {
  CORE_WINDOW_IPC,
  type CoreBridgeApi,
  type CoreBridgeMessage,
  type CoreBridgeStatus
} from '../../shared/coreBridge.ts'

export const coreApi: CoreBridgeApi = {
  connect: (connectionId) =>
    ipcRenderer.invoke(CORE_WINDOW_IPC.connect, connectionId ? { connectionId } : {}),
  request: (connectionId, request) =>
    ipcRenderer.invoke(CORE_WINDOW_IPC.request, { connectionId, request }),
  cancel: (connectionId, requestId) =>
    ipcRenderer.invoke(CORE_WINDOW_IPC.cancel, { connectionId, requestId }),
  disconnect: (connectionId) => ipcRenderer.invoke(CORE_WINDOW_IPC.disconnect, { connectionId }),
  onMessage: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, message: CoreBridgeMessage): void =>
      listener(message)
    ipcRenderer.on(CORE_WINDOW_IPC.message, handler)
    return () => ipcRenderer.removeListener(CORE_WINDOW_IPC.message, handler)
  },
  onStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: CoreBridgeStatus): void =>
      listener(status)
    ipcRenderer.on(CORE_WINDOW_IPC.status, handler)
    return () => ipcRenderer.removeListener(CORE_WINDOW_IPC.status, handler)
  }
}
