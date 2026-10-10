import type { IpcMain } from 'electron'
import { resolveAuthorizedAudioFile } from '../security/localPaths'
import { normalizeLocalPath } from '../security/ipcValidation.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import { encodeAudioFileUrlPath } from '../library/audioFileUrl.ts'
import { MAX_NATIVE_QUEUE_ITEMS } from '../../shared/nativeQueue.ts'
import { resolveAuthorizationBatch } from '../security/authorizationBatch.ts'

async function isAudioFileAuthorized(filePath: unknown): Promise<boolean> {
  try {
    await resolveAuthorizedAudioFile(normalizeLocalPath(filePath, 'audio file path'))
    return true
  } catch {
    return false
  }
}

export function registerFilesystemIpc(ipcMain: IpcMain): void {
  ipcMain.handle('fs:getAudioFileUrl', async (event, filePath: string) => {
    assertTrustedIpcSender(event, 'filesystem IPC')
    const resolvedPath = await resolveAuthorizedAudioFile(
      normalizeLocalPath(filePath, 'audio file path')
    )
    return `twilight-audio:///${encodeAudioFileUrlPath(resolvedPath)}`
  })

  ipcMain.handle('fs:isAudioFileAuthorized', async (event, filePath: string) => {
    assertTrustedIpcSender(event, 'filesystem IPC')
    return await isAudioFileAuthorized(filePath)
  })

  // Authorizing a whole native queue one file at a time cost one IPC round-trip
  // per track, which a library-sized queue turns into thousands before playback
  // can start. Verdicts are identical to the single-file channel because this
  // calls the same resolver; only the trip count and the fan-out change.
  ipcMain.handle('fs:areAudioFilesAuthorized', async (event, filePaths: unknown) => {
    assertTrustedIpcSender(event, 'filesystem IPC')
    if (!Array.isArray(filePaths) || filePaths.length > MAX_NATIVE_QUEUE_ITEMS) {
      throw new Error('Audio authorization batch is invalid or too large')
    }
    // Resolution hits the real filesystem per path (realpath + existence) and
    // refreshes the declared roots whenever a path falls outside them, so the
    // batch dedupes and stays bounded instead of flooding the main process.
    const keys = filePaths.map((path) => (typeof path === 'string' ? path : String(path)))
    const verdicts = await resolveAuthorizationBatch(keys, isAudioFileAuthorized)
    return keys.map((key) => verdicts.get(key) === true)
  })
}
