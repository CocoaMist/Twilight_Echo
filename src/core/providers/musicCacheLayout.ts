import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { clearUnpinnedCache } from '../network/networkCache.ts'

import { MANAGED_MUSIC_CACHE_DIRECTORY_NAMES } from '../../shared/musicCacheLayout.ts'

export { MANAGED_MUSIC_CACHE_DIRECTORY_NAMES }

export function getManagedMusicCacheDirectories(rootPath: string): string[] {
  const root = resolve(rootPath)
  return MANAGED_MUSIC_CACHE_DIRECTORY_NAMES.map((name) => join(root, name))
}

export function getMusicCacheStorageDirectories(rootPath: string): string[] {
  return getManagedMusicCacheDirectories(rootPath)
}

export async function getManagedMusicCacheSize(rootPath: string): Promise<number> {
  const sizes = await Promise.all(
    getManagedMusicCacheDirectories(rootPath).map((directory) => getPathSize(directory))
  )
  return sizes.reduce((total, size) => total + size, 0)
}

export async function clearManagedMusicCache(rootPath: string): Promise<void> {
  const root = resolve(rootPath)
  const directories = getManagedMusicCacheDirectories(root)
  await mkdir(root, { recursive: true })
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
  await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })))
}

/** Core clears only its repositories. Main separately drains covers and asks
 * Chromium to clear its own cache; live decoder/preload files stay pinned. */
export async function clearCoreMusicCache(
  rootPath: string,
  sources: readonly string[],
  signal: AbortSignal
): Promise<void> {
  for (const name of ['audio-engine-cache', 'ncm-cache', 'network-cache']) {
    signal.throwIfAborted()
    await clearUnpinnedCache(join(resolve(rootPath), name), sources, signal)
  }
}

async function getPathSize(targetPath: string): Promise<number> {
  try {
    const info = await lstat(targetPath)
    if (info.isSymbolicLink()) return 0
    if (!info.isDirectory()) return info.size

    const entries = await readdir(targetPath)
    const sizes = await Promise.all(entries.map((entry) => getPathSize(join(targetPath, entry))))
    return sizes.reduce((total, size) => total + size, 0)
  } catch {
    return 0
  }
}
