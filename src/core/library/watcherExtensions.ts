import { existsSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { SUPPORTED_EXTENSIONS } from '../../shared/audioFormats.ts'

// Shared scan extensions + CUE dependency sheets that can re-partition a disc.
export const LIBRARY_WATCH_EXTENSIONS = new Set<string>([...SUPPORTED_EXTENSIONS, '.cue'])

export function isWatchableFileExtension(ext: string): boolean {
  return LIBRARY_WATCH_EXTENSIONS.has(ext)
}

/**
 * Directory move/rename events often arrive without a media extension.
 * Treat non-audio paths as directory-level churn so the root reconciles.
 */
export function looksLikeDirectoryEvent(filename: string, fullPath: string): boolean {
  const ext = extname(filename).toLowerCase()
  if (!ext) return true
  if (isWatchableFileExtension(ext)) return false
  try {
    return existsSync(fullPath) ? statSync(fullPath).isDirectory() : true
  } catch {
    return true
  }
}
