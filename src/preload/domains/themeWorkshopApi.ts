import { ipcRenderer } from 'electron'
import type { ThemeWorkshopApi } from '../../shared/themeWorkshop.ts'

export const themeWorkshopApi: ThemeWorkshopApi = {
  onPrepareDisable: (callback) => {
    const listener = async (
      _event: Electron.IpcRendererEvent,
      requestId: string
    ): Promise<void> => {
      try {
        await callback()
        await ipcRenderer.invoke('themeWorkshop:readyToDisable', requestId, null)
      } catch (error) {
        await ipcRenderer.invoke(
          'themeWorkshop:readyToDisable',
          requestId,
          error instanceof Error ? error.message : String(error)
        )
      }
    }
    ipcRenderer.on('themeWorkshop:prepareDisable', listener)
    void ipcRenderer.invoke('themeWorkshop:editorSession', true)
    return () => {
      ipcRenderer.removeListener('themeWorkshop:prepareDisable', listener)
      void ipcRenderer.invoke('themeWorkshop:editorSession', false)
    }
  },
  get: (id) => ipcRenderer.invoke('themeWorkshop:get', id),
  restoreApplied: (id) => ipcRenderer.invoke('themeWorkshop:restoreApplied', id),
  list: () => ipcRenderer.invoke('themeWorkshop:list'),
  sources: () => ipcRenderer.invoke('themeWorkshop:sources'),
  create: (template, source) => ipcRenderer.invoke('themeWorkshop:create', template, source),
  save: (project) => ipcRenderer.invoke('themeWorkshop:save', project),
  duplicate: (id, revision) => ipcRenderer.invoke('themeWorkshop:duplicate', id, revision),
  remove: (id, revision) => ipcRenderer.invoke('themeWorkshop:remove', id, revision),
  preflight: (id, revision) => ipcRenderer.invoke('themeWorkshop:preflight', id, revision),
  importProject: () => ipcRenderer.invoke('themeWorkshop:importProject'),
  exportProject: (id, format, revision) =>
    ipcRenderer.invoke('themeWorkshop:exportProject', id, format, revision),
  importAsset: (type) => ipcRenderer.invoke('themeWorkshop:importAsset', type),
  updateBase: (id) => ipcRenderer.invoke('themeWorkshop:updateBase', id),
  apply: (id, revision) => ipcRenderer.invoke('themeWorkshop:apply', id, revision)
}
