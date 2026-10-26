import { BrowserWindow, dialog } from 'electron'
import { tmpdir } from 'node:os'
import type { CorePlatformOperations } from '../../shared/corePlatform.ts'
import type { CoreDspImport } from '../../shared/coreDsp.ts'
import { defaultVst3SearchPaths, resolveVst3HelpersAvailability } from './vst3Catalog.ts'
import {
  grantUserSelectedImpulseResponse,
  grantUserSelectedVst3SearchPath,
  resolveAuthorizedImpulseResponseFile,
  resolveAuthorizedVst3SearchPaths,
  registerManagedVst3SearchPaths
} from '../security/localPaths.ts'

const filters: Record<CoreDspImport['kind'], Electron.FileFilter[]> = {
  impulseResponse: [{ name: 'Impulse Response', extensions: ['wav', 'flac', 'aiff', 'aif'] }],
  impulsePath: [{ name: 'Impulse Response', extensions: ['wav', 'flac', 'aiff', 'aif'] }],
  correctionProfile: [{ name: 'Correction Profile', extensions: ['txt', 'apo'] }],
  vst3Preset: [{ name: 'VST3 Preset', extensions: ['vstpreset'] }],
  vst3State: [{ name: 'VST3 State', extensions: ['vststate', 'bin'] }],
  profile: [{ name: 'Twilight Echo DSP Profile', extensions: ['tedsp'] }],
  frequencyResponse: [{ name: 'AutoEq CSV', extensions: ['csv'] }]
}
export function createDspCorePlatform() {
  return {
    'dsp.environment': async (): Promise<CorePlatformOperations['dsp.environment']['output']> => ({
      platform: process.platform,
      temporaryDirectory: tmpdir(),
      searchPaths: defaultVst3SearchPaths(),
      helpers: resolveVst3HelpersAvailability()
    }),
    'dsp.chooseFile': async (
      { kind }: CorePlatformOperations['dsp.chooseFile']['input'],
      signal: AbortSignal
    ) => {
      const options: Electron.OpenDialogOptions = {
        title: kind === 'profile' ? '导入 DSP 配置包' : '导入 DSP 资料',
        properties: ['openFile'],
        filters: filters[kind]
      }
      const window = BrowserWindow.getFocusedWindow()
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      signal.throwIfAborted()
      const path = result.canceled ? null : (result.filePaths[0] ?? null)
      return path && kind === 'impulsePath' ? grantUserSelectedImpulseResponse(path) : path
    },
    'dsp.chooseExportFile': async (_payload: Record<string, never>, signal: AbortSignal) => {
      const options = {
        title: '导出 DSP 配置包',
        defaultPath: 'DSP Profile.tedsp',
        filters: filters.profile
      }
      const window = BrowserWindow.getFocusedWindow()
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)
      signal.throwIfAborted()
      return result.canceled ? null : (result.filePath ?? null)
    },
    'dsp.chooseVst3Directory': async (_payload: Record<string, never>, signal: AbortSignal) => {
      const options: Electron.OpenDialogOptions = {
        title: '选择 VST3 搜索目录',
        properties: ['openDirectory']
      }
      const window = BrowserWindow.getFocusedWindow()
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      signal.throwIfAborted()
      return result.canceled || !result.filePaths[0]
        ? null
        : grantUserSelectedVst3SearchPath(result.filePaths[0])
    },
    'dsp.authorizeImpulse': ({ path }: { path: string }) =>
      resolveAuthorizedImpulseResponseFile(path),
    'dsp.authorizeVst3Paths': ({ paths }: { paths: string[] }) =>
      resolveAuthorizedVst3SearchPaths(paths),
    'dsp.registerVst3Paths': ({ paths }: { paths: string[] }) =>
      registerManagedVst3SearchPaths(paths)
  }
}
