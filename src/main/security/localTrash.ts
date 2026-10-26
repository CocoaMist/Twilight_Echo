import { shell } from 'electron'
const TRASH_RETRY_DELAYS_MS = [0, 75, 200, 500, 1_000] as const

export async function trashLocalFileWithRetry(filePath: string): Promise<void> {
  if (process.platform !== 'win32') {
    await shell.trashItem(filePath)
    return
  }
  let lastError: unknown
  for (const delayMs of TRASH_RETRY_DELAYS_MS) {
    if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    try {
      await shell.trashItem(filePath)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
