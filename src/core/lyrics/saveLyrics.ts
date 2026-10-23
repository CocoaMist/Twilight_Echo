import { copyFile, open, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MAX_IMPORTED_LYRICS_BYTES, validateImportedLyrics } from './importLyrics.ts'

export interface LyricsSaveDialogResult {
  canceled: boolean
  filePath: string
}

export interface SavedLyricsFile {
  filePath: string
  backupPath: string | null
}

export interface LyricsFileOperations {
  exists(filePath: string): Promise<boolean>
  copy(source: string, destination: string): Promise<void>
  writeSynced(filePath: string, contents: string): Promise<void>
  replace(source: string, destination: string): Promise<void>
  remove(filePath: string): Promise<void>
}

const fileOperations: LyricsFileOperations = {
  async exists(filePath) {
    try {
      await stat(filePath)
      return true
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  },
  copy: copyFile,
  async writeSynced(filePath, contents) {
    const handle = await open(filePath, 'w', 0o600)
    try {
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
  replace: rename,
  remove: async (filePath) => await rm(filePath, { force: true })
}

/**
 * Renderer code never supplies a filesystem path. The main process receives
 * one only from its Save dialog and commits it with a recoverable replacement.
 */
export async function saveLyricsFromDialog(
  result: LyricsSaveDialogResult,
  contents: string,
  operations: LyricsFileOperations = fileOperations
): Promise<SavedLyricsFile | null> {
  if (result.canceled || !result.filePath) return null
  const filePath = result.filePath
  if (extname(filePath).toLowerCase() !== '.lrc') {
    throw new Error('Lyrics must be saved with an .lrc extension')
  }
  if (Buffer.byteLength(contents, 'utf8') > MAX_IMPORTED_LYRICS_BYTES) {
    throw new Error('Lyrics exceed the 1 MiB limit')
  }
  const normalized = validateImportedLyrics(filePath, contents)
  return await writeLyricsAtomically(filePath, normalized, operations)
}

export async function writeLyricsAtomically(
  filePath: string,
  contents: string,
  operations: LyricsFileOperations = fileOperations
): Promise<SavedLyricsFile> {
  const backupPath = `${filePath}.bak`
  const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`)
  const hadPreviousFile = await operations.exists(filePath)

  try {
    if (hadPreviousFile) await operations.copy(filePath, backupPath)
    await operations.writeSynced(temporaryPath, contents)
    await operations.replace(temporaryPath, filePath)
    return { filePath, backupPath: hadPreviousFile ? backupPath : null }
  } catch (error) {
    // A failed replacement must not leave the user's previous LRC lost. A
    // successful rename never reaches this branch, so the backup remains a
    // durable, user-visible recovery copy after a successful edit as well.
    if (hadPreviousFile) {
      try {
        await operations.copy(backupPath, filePath)
      } catch {
        // Preserve the original error; the durable backup is still present.
      }
    }
    throw error
  } finally {
    await operations.remove(temporaryPath)
  }
}
