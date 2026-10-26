import { BrowserWindow, dialog } from 'electron'
import { basename, extname } from 'node:path'
import type { ThemeAssetType, ThemeProfileV2 } from '../../shared/theme.ts'
import { exportThemeArchive, importThemeArchive, importThemeAsset } from './themeArchive.ts'

export async function chooseAndImportThemeArchive(): Promise<ThemeProfileV2 | null> {
  const owner = BrowserWindow.getFocusedWindow()
  const options: Electron.OpenDialogOptions = {
    title: '导入主题',
    properties: ['openFile'],
    filters: [{ name: 'Twilight Echo Theme', extensions: ['tetheme'] }]
  }
  const selected = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options)
  if (selected.canceled || !selected.filePaths.length) return null
  const source = selected.filePaths[0]
  if (extname(source).toLowerCase() !== '.tetheme' || basename(source).length > 255)
    throw new Error('请选择有效的 .tetheme 文件')
  return importThemeArchive(source)
}

export async function chooseAndExportThemeArchive(profile: ThemeProfileV2): Promise<string | null> {
  const name =
    Array.from(profile.name, (char) => (char.charCodeAt(0) < 32 ? '_' : char))
      .join('')
      .replace(/[<>:"/\\|?*]/g, '_')
      .trim()
      .slice(0, 80) || 'theme'
  const owner = BrowserWindow.getFocusedWindow()
  const options: Electron.SaveDialogOptions = {
    title: '导出主题',
    defaultPath: `${name}.tetheme`,
    filters: [{ name: 'Twilight Echo Theme', extensions: ['tetheme'] }]
  }
  const selected = owner
    ? await dialog.showSaveDialog(owner, options)
    : await dialog.showSaveDialog(options)
  if (selected.canceled || !selected.filePath) return null
  const target =
    extname(selected.filePath).toLowerCase() === '.tetheme'
      ? selected.filePath
      : `${selected.filePath}.tetheme`
  await exportThemeArchive(profile, target)
  return target
}

export async function chooseAndImportThemeAsset(id: string, type: ThemeAssetType) {
  const owner = BrowserWindow.getFocusedWindow()
  const options: Electron.OpenDialogOptions = {
    title: type === 'font' ? '导入主题字体' : '导入主题图片',
    properties: ['openFile'],
    filters:
      type === 'font'
        ? [{ name: 'WOFF2 Font', extensions: ['woff2'] }]
        : [{ name: 'Theme Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
  }
  const selected = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options)
  if (selected.canceled || !selected.filePaths.length) return null
  return importThemeAsset(id, selected.filePaths[0], type)
}
