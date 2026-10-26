import { readFile, stat } from 'node:fs/promises'
import { decodeLyrics } from '../../shared/lyricsEncoding.ts'
import { importLyricsFromDialog } from './importLyrics.ts'
import { saveLyricsFromDialog } from './saveLyrics.ts'

export async function importLyricDraft(
  choose: () => Promise<string | null>,
  signal?: AbortSignal
): Promise<string | null> {
  const file = await choose()
  signal?.throwIfAborted()
  return importLyricsFromDialog(
    { canceled: file == null, filePaths: file ? [file] : [] },
    async (path) => decodeLyrics(await readFile(path)).text,
    async (path) => (await stat(path)).size
  )
}
export async function exportLyricDraft(
  choose: () => Promise<string | null>,
  contents: string,
  signal?: AbortSignal
): Promise<string | null> {
  const file = await choose()
  signal?.throwIfAborted()
  const saved = await saveLyricsFromDialog(
    { canceled: file == null, filePath: file ?? '' },
    contents
  )
  return saved?.filePath ?? null
}
