import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { formatEqBandClipboard, parseEqBandClipboard } from '../../shared/equalizerClipboard.ts'
import { normalizeEqClipboardBands } from '../security/ipcValidation.ts'

export function registerEqualizerClipboardIpc(
  ipc: Pick<IpcMain, 'handle'>,
  services: {
    assertTrusted: (event: IpcMainInvokeEvent, scope: string) => void
    readText: () => string
    writeText: (text: string) => void
  }
): void {
  ipc.handle('window:copy-eq-bands', (event, value: unknown) => {
    services.assertTrusted(event, 'EQ clipboard')
    services.writeText(formatEqBandClipboard(normalizeEqClipboardBands(value)))
  })
  ipc.handle('window:paste-eq-bands', (event) => {
    services.assertTrusted(event, 'EQ clipboard')
    return parseEqBandClipboard(services.readText())
  })
}
