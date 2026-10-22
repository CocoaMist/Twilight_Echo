import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { LibraryTrackRecord } from '../../shared/libraryDatabase.ts'

/** Utility processes cannot use nativeImage. Keep original image bytes on disk;
 * the main-process thumbnail normalizer can resize supported raster formats.
 * GIF covers remain in their original encoded form. */
export async function externalizeLibraryCover(
  track: LibraryTrackRecord,
  cacheDirectory: string
): Promise<LibraryTrackRecord> {
  if (typeof track.cover !== 'string' || !/^data:image\//i.test(track.cover)) return track
  const match = /^data:image\/(?:png|jpe?g|webp|gif);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(
    track.cover
  )
  if (!match) throw new Error(`Invalid embedded library cover: ${track.id}`)
  const bytes = Buffer.from(match[1], 'base64')
  if (!bytes.length || bytes.length > 20 * 1024 * 1024)
    throw new Error(`Embedded library cover exceeds the image cache limit: ${track.id}`)
  const extension = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    ? 'jpg'
    : bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      ? 'png'
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
        ? 'webp'
        : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('latin1'))
          ? 'gif'
          : null
  if (!extension) throw new Error(`Unsupported embedded library cover: ${track.id}`)
  const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}.${extension}`
  await mkdir(cacheDirectory, { recursive: true })
  const target = join(cacheDirectory, name)
  // A completed cache entry never has to be rewritten for another song.
  try {
    const existing = await open(target, 'r')
    await existing.close()
    return { ...track, cover: `cover://${name}` }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx')
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, target)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn('[library-db] Could not remove cover staging file:', temporary, cleanupError)
    }
    throw error
  }
  return { ...track, cover: `cover://${name}` }
}
