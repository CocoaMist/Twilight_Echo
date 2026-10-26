import { BrowserWindow, dialog, type WebContents } from 'electron'
import { runtime } from '../core/runtime.ts'
import { NCM_CLOUD_UPLOAD_EXTENSIONS } from '../../shared/coreCloudTransfer.ts'

export async function chooseNcmCloudUploadFiles(sender?: WebContents): Promise<string[]> {
  const owner = (sender && BrowserWindow.fromWebContents(sender)) ?? runtime.mainWindow
  const options: Electron.OpenDialogOptions = {
    title: '选择要上传到网易云云盘的音频文件',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '音频文件', extensions: [...NCM_CLOUD_UPLOAD_EXTENSIONS] }]
  }
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? [] : result.filePaths
}

export async function chooseNcmCloudDownloadFile(
  fileName: string,
  sender?: WebContents
): Promise<string | null> {
  const owner = (sender && BrowserWindow.fromWebContents(sender)) ?? runtime.mainWindow
  const options: Electron.SaveDialogOptions = {
    title: '下载网易云云盘歌曲',
    defaultPath: fileName
  }
  const result = owner
    ? await dialog.showSaveDialog(owner, options)
    : await dialog.showSaveDialog(options)
  return result.canceled ? null : (result.filePath ?? null)
}
