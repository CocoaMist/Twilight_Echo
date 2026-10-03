import { app, dialog, type IpcMain } from 'electron'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import {
  resolveAuthorizedLibraryRootSettings,
  grantUserSelectedLibraryRoot
} from '../security/localPaths.ts'
import {
  createPersonalBackup,
  writePersonalBackupFile,
  readBackupFile,
  previewRestore,
  stagePersonalRestore,
  readRendererRestore,
  acknowledgeRendererRestore,
  checkRestoreOptions
} from '../persistence/personalBackup.ts'
import {
  isRecord,
  remapPersonalPaths,
  type PersonalBackup,
  type PersonalData,
  type PersonalRestoreOptions
} from '../../shared/personalBackup.ts'

export function registerPersonalBackupIpc(ipc: IpcMain): void {
  const root = app.getPath('userData')
  let selected: PersonalBackup | null = null
  ipc.handle('data:chooseRestoreFolder', async (event) => {
    assertTrustedIpcSender(event, 'personal backup')
    const result = await dialog.showOpenDialog({
      title: '选择音乐在本机的目录',
      properties: ['openDirectory']
    })
    return result.canceled || !result.filePaths[0]
      ? null
      : grantUserSelectedLibraryRoot(result.filePaths[0])
  })
  ipc.handle('data:exportPersonalBackup', async (event, rendererData: PersonalData) => {
    assertTrustedIpcSender(event, 'personal backup')
    if (!isRecord(rendererData)) throw new Error('数据无效')
    const backup = createPersonalBackup(root, rendererData)
    const result = await dialog.showSaveDialog({
      title: '导出个人数据备份',
      defaultPath: `TwilightEcho-personal-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: '个人数据备份', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return false
    writePersonalBackupFile(result.filePath, backup)
    return true
  })
  ipc.handle('data:previewPersonalBackup', async (event, rendererData: PersonalData) => {
    assertTrustedIpcSender(event, 'personal backup')
    selected = null
    if (!isRecord(rendererData)) throw new Error('数据无效')
    const result = await dialog.showOpenDialog({
      title: '选择个人数据备份',
      properties: ['openFile'],
      filters: [{ name: '个人数据备份', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    selected = readBackupFile(result.filePaths[0])
    return previewRestore(root, selected, rendererData)
  })
  ipc.handle('data:stagePersonalRestore', async (event, options: PersonalRestoreOptions) => {
    assertTrustedIpcSender(event, 'personal restore')
    checkRestoreOptions(options)
    if (!selected) throw new Error('请先选择并预览备份文件')
    const backup = selected
    const mapped = remapPersonalPaths(backup.data.library, options.mappings)
    const roots =
      options.domains.includes('library') && isRecord(mapped) && Array.isArray(mapped.folders)
        ? await resolveAuthorizedLibraryRootSettings(mapped.folders)
        : []
    // A file preview owns the imported data; renderer cannot inject arbitrary file payloads.
    stagePersonalRestore(root, backup, options, roots)
    selected = null
  })
  ipc.handle('data:readRendererRestore', (event) => {
    assertTrustedIpcSender(event, 'personal restore')
    return readRendererRestore(root)
  })
  ipc.handle('data:acknowledgeRendererRestore', (event, id: string) => {
    assertTrustedIpcSender(event, 'personal restore')
    if (typeof id !== 'string') throw new Error('恢复标识无效')
    acknowledgeRendererRestore(root, id)
  })
}
