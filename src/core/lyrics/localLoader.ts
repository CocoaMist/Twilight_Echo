import { basename, dirname } from 'node:path'
import type { LyricsLoaderOptions } from './loader.ts'
import { loadLocalLyrics, loadLocalCompanionLyrics } from './loadLyrics.ts'

/** Paths come only from the authoritative track and retain main's library grants. */
export function createLocalLyricsLoader(paths: {
  audioFile(path: string, signal: AbortSignal): Promise<string>
  directory(path: string, signal: AbortSignal): Promise<string>
}): LyricsLoaderOptions['loadLocalLyrics'] {
  return async (track, kind, signal) => {
    signal.throwIfAborted()
    const file = track.filePath ? await paths.audioFile(track.filePath, signal) : null
    const directory = file ? dirname(file) : await paths.directory(track.dir!, signal)
    signal.throwIfAborted()
    const fileName = basename(track.fileName)
    const result =
      kind === 'original'
        ? await loadLocalLyrics(directory, fileName, file)
        : await loadLocalCompanionLyrics(directory, fileName, kind)
    signal.throwIfAborted()
    return result
  }
}
