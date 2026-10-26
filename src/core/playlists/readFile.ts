import { open } from 'node:fs/promises'
import { EXTERNAL_PLAYLIST_MAX_BYTES } from '../../shared/externalPlaylist.ts'
import { parseExternalPlaylistFile } from './fileParser.ts'

/** The path comes only from main's explicit file-selection capability. */
export async function readPlaylistImportFile(filename: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const file = await open(filename, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > EXTERNAL_PLAYLIST_MAX_BYTES)
      throw new Error('歌单文件超过 8 MiB 上限或不是普通文件')
    const bytes = Buffer.alloc(Math.min(stat.size + 1, EXTERNAL_PLAYLIST_MAX_BYTES + 1))
    const result = await file.read(bytes, 0, bytes.length, 0)
    signal.throwIfAborted()
    if (result.bytesRead !== stat.size) throw new Error('文件在读取期间发生变化，请重新选择')
    return parseExternalPlaylistFile(bytes.subarray(0, result.bytesRead), filename)
  } finally {
    await file.close()
  }
}
