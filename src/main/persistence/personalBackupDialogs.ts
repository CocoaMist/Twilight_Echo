import { dialog } from 'electron'
import { grantUserSelectedLibraryRoot } from '../security/localPaths.ts'

export async function choosePersonalBackupFile(kind: 'import' | 'export'): Promise<string | null> {
  const filters = [{ name: '个人数据备份', extensions: ['json'] }]
  if (kind === 'import') {
    const result = await dialog.showOpenDialog({
      title: '选择个人数据备份',
      properties: ['openFile'],
      filters
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }
  const result = await dialog.showSaveDialog({
    title: '导出个人数据备份',
    defaultPath: `TwilightEcho-personal-${new Date().toISOString().slice(0, 10)}.json`,
    filters
  })
  return result.canceled ? null : (result.filePath ?? null)
}
export async function choosePersonalRestoreFolder(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: '选择音乐在本机的目录',
    properties: ['openDirectory']
  })
  return result.canceled || !result.filePaths[0]
    ? null
    : grantUserSelectedLibraryRoot(result.filePaths[0])
}
