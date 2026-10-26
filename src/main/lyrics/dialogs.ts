import { BrowserWindow, dialog } from 'electron'
import { runtime } from '../core/runtime'

export async function chooseLyricsImportFile(): Promise<string | null> {
  const window = BrowserWindow.getFocusedWindow() ?? runtime.mainWindow
  const options: Electron.OpenDialogOptions = {
    title: 'Import LRC lyrics',
    properties: ['openFile'],
    filters: [{ name: 'Lyrics', extensions: ['lrc', 'txt'] }]
  }
  const result =
    window && !window.isDestroyed()
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}
export async function chooseLyricsExportFile(): Promise<string | null> {
  const window = BrowserWindow.getFocusedWindow() ?? runtime.mainWindow
  const options: Electron.SaveDialogOptions = {
    title: 'Save LRC lyrics',
    defaultPath: 'lyrics.lrc',
    filters: [{ name: 'LRC lyrics', extensions: ['lrc'] }]
  }
  const result =
    window && !window.isDestroyed()
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
  return result.canceled ? null : result.filePath
}
