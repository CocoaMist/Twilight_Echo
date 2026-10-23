import { dialog, type IpcMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import { IPC } from '../../shared/ipcChannels.ts'
import { runtime } from '../core/runtime.ts'
import { mainLocale } from '../core/locale.ts'
import { translate } from '../../shared/i18n/translate.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import { getCoreApplication } from '../app/coreApplication.ts'
import { exportCoreAudioDiagnostics } from '../app/coreAudioDiagnosticsExport.ts'
import type { AudioDiagnosticReport } from '../../shared/coreAudioDiagnostics.ts'

export function registerCoreAudioDiagnosticsIpc(ipc: IpcMain): void {
  ipc.handle(IPC.audioEngine.exportDiagnostics, async (event) => {
    assertTrustedIpcSender(event, 'audio diagnostic export IPC')
    const window = runtime.mainWindow
    if (!window || window.isDestroyed() || event.sender !== window.webContents)
      throw Error('Audio diagnostic export requires the main window')
    const locale = mainLocale()
    return exportCoreAudioDiagnostics({
      locale,
      choose: async () => {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const result = await dialog.showSaveDialog(window, {
          title: translate(locale, 'diagnostics.export.dialogTitle'),
          defaultPath: `TwilightEcho-audio-diagnostics-${timestamp}.md`,
          filters: [
            { name: 'Markdown', extensions: ['md'] },
            { name: 'JSON', extensions: ['json'] }
          ]
        })
        return result.canceled ? null : (result.filePath ?? null)
      },
      report: async (locale) =>
        (await getCoreApplication()!.request('audio.diagnostics', {
          locale
        })) as AudioDiagnosticReport,
      write: (path, contents) => writeFile(path, contents, 'utf8')
    })
  })
}
