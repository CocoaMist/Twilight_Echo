import { createWriteStream } from 'node:fs'
import { lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { NetworkResumeUnsupported, NetworkSourceFailure } from './errors.ts'
import type { NetworkSourceSession } from './adapters/types.ts'
import type { NetworkEntry } from '../../shared/networkSources.ts'

/**
 * 把远程条目下载到 network-cache。
 * 缓存键使用条目稳定 id（协议+profile+路径哈希），文件名不信任远程名。
 */
type Download = {
  session: NetworkSourceSession
  entry: NetworkEntry
  cacheRoot: string
  signal?: AbortSignal
}
const downloads = new Map<string, Promise<void>>()

interface CacheDirectoryAccess {
  clear: Promise<void>
  clears: number
  targets: Map<string, number>
}

const cacheDirectories = new Map<string, CacheDirectoryAccess>()

function cachePathKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function directoryAccess(directory: string): CacheDirectoryAccess {
  const key = cachePathKey(directory)
  let access = cacheDirectories.get(key)
  if (!access) {
    access = { clear: Promise.resolve(), clears: 0, targets: new Map() }
    cacheDirectories.set(key, access)
  }
  return access
}

function releaseDirectoryAccess(directory: string, access: CacheDirectoryAccess): void {
  if (access.clears === 0 && access.targets.size === 0) {
    cacheDirectories.delete(cachePathKey(directory))
  }
}

function abortFailure(signal?: AbortSignal): NetworkSourceFailure {
  const reason = signal?.reason
  return new NetworkSourceFailure(
    'timeout',
    reason instanceof Error && reason.name !== 'AbortError'
      ? `网络文件下载已取消：${reason.message}`
      : '网络文件下载已取消'
  )
}

async function withCacheDirectoryWriter<T>(
  target: string,
  signal: AbortSignal | undefined,
  write: () => Promise<T>
): Promise<T> {
  const directory = dirname(target)
  const access = directoryAccess(directory)
  const previousClear = access.clear
  const key = cachePathKey(target)
  access.targets.set(key, (access.targets.get(key) ?? 0) + 1)
  try {
    // Register before waiting so a later clear also preserves queued targets.
    // Calls arriving after a clear cannot create files inside that clear.
    await waitForDownload(previousClear, signal)
    return await withCacheWriter(target, signal, write)
  } finally {
    const remaining = (access.targets.get(key) ?? 1) - 1
    if (remaining === 0) access.targets.delete(key)
    else access.targets.set(key, remaining)
    releaseDirectoryAccess(directory, access)
  }
}

async function withCacheWriter<T>(
  target: string,
  signal: AbortSignal | undefined,
  write: () => Promise<T>
): Promise<T> {
  const key = cachePathKey(target)
  const previous = downloads.get(key) ?? Promise.resolve()
  let release!: () => void
  const owned = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => owned)
  downloads.set(key, tail)
  void tail.then(() => {
    if (downloads.get(key) === tail) downloads.delete(key)
  })
  try {
    await waitForDownload(previous, signal)
    if (signal?.aborted) throw abortFailure(signal)
    return await write()
  } finally {
    // A cancelled waiter leaves the active writer ahead of subsequent callers.
    release()
  }
}

export async function downloadEntryToCache(deps: Download): Promise<string> {
  const { entry, cacheRoot, signal } = deps
  // Safe legacy keys remain readable. Renderer-supplied keys are never used by
  // the manager; this check also protects metadata and future direct callers.
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(entry.id)) {
    throw new NetworkSourceFailure('denied', '无效的网络缓存标识')
  }
  const suffix = extname(entry.name)
  const extension = /^\.[a-z0-9]{1,16}$/i.test(suffix) ? suffix : ''
  const target = resolve(cacheRoot, `${entry.id}${extension}`)
  if (dirname(target) !== resolve(cacheRoot)) {
    throw new NetworkSourceFailure('denied', '无效的网络缓存路径')
  }
  if (entry.sizeBytes != null && (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0)) {
    throw new NetworkSourceFailure('network', '无效的网络文件大小')
  }
  return withCacheDirectoryWriter(target, signal, () => download({ ...deps, target }))
}

function waitForDownload(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(abortFailure(signal))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void previous.then(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    })
  })
}

async function download(deps: Download & { target: string }): Promise<string> {
  const { session, entry, cacheRoot, target, signal } = deps
  await mkdir(cacheRoot, { recursive: true })

  try {
    const info = await stat(target)
    if (entry.sizeBytes == null || info.size === entry.sizeBytes) return target
  } catch {
    // 未缓存，继续下载
  }

  const temp = `${target}.part`
  try {
    let partialSize = 0
    try {
      partialSize = (await stat(temp)).size
    } catch {
      // 无部分文件，从头下载
    }
    // Without a known total the stream interface cannot prove Range was
    // honored. Restart instead of appending a potentially complete response.
    if (entry.sizeBytes == null || partialSize > entry.sizeBytes) {
      await rm(temp, { force: true })
      partialSize = 0
    }
    if (partialSize > 0 && partialSize === entry.sizeBytes) {
      await rename(temp, target)
      return target
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal?.aborted) throw new NetworkSourceFailure('timeout', '网络文件下载已取消')
      const start = attempt === 0 ? partialSize : 0
      if (start === 0 && attempt > 0) await rm(temp, { force: true })
      let stream: NodeJS.ReadableStream
      try {
        stream = await session.readStream(entry.path, signal, { start })
      } catch (error) {
        if (start > 0 && error instanceof NetworkResumeUnsupported) continue
        throw error
      }
      await pipeline(stream, createWriteStream(temp, { flags: start > 0 ? 'a' : 'w' }), { signal })
      const completedSize = (await stat(temp)).size
      if (entry.sizeBytes == null || completedSize === entry.sizeBytes) {
        await rename(temp, target)
        return target
      }
      // A server that ignored Range returns the whole object. Reset once and
      // retry from byte zero; never publish a concatenated/corrupt cache.
      if (start > 0 && completedSize > entry.sizeBytes) continue
      throw new NetworkSourceFailure(
        'network',
        `网络文件大小不匹配：预期 ${entry.sizeBytes}，实际 ${completedSize}`
      )
    }
    throw new NetworkSourceFailure('network', '网络文件无法完成下载')
  } catch (err) {
    if (err instanceof NetworkSourceFailure) throw err
    throw new NetworkSourceFailure('network', `网络文件下载失败：${(err as Error).message}`)
  }
}

export function networkCacheDir(musicCacheRoot: string): string {
  return join(musicCacheRoot, 'network-cache')
}

export async function getDirectorySize(directory: string): Promise<number> {
  let total = 0
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const target = join(directory, entry.name)
      if (entry.isDirectory()) {
        total += await getDirectorySize(target)
      } else {
        const info = await stat(target)
        total += info.size
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return total
}

export async function clearDirectory(directory: string): Promise<void> {
  const access = directoryAccess(directory)
  const previousClear = access.clear
  // These callers may return a completed path before the clear finishes. Keep
  // both names even if a writer renames its partial file during enumeration.
  const protectedPaths = new Set(
    [...access.targets.keys()].flatMap((target) => [target, `${target}.part`])
  )
  let release!: () => void
  const owned = new Promise<void>((resolve) => {
    release = resolve
  })
  access.clear = previousClear.then(() => owned)
  access.clears++
  try {
    await previousClear
    await mkdir(directory, { recursive: true })
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry)
      if (!protectedPaths.has(cachePathKey(path))) {
        await rm(path, { recursive: true, force: true })
      }
    }
  } finally {
    release()
    access.clears--
    releaseDirectoryAccess(directory, access)
  }
}

/** Native keeps its current/preloaded files; writers must be joined by the owner. */
export async function clearUnpinnedCache(
  directory: string,
  sources: readonly string[],
  signal?: AbortSignal
): Promise<void> {
  const root = resolve(directory)
  const pins = sources.filter(isAbsolute).map((source) => resolve(source))
  // Managed directory links are removed themselves, never traversed for deletion.
  try {
    if ((await lstat(root)).isSymbolicLink()) await rm(root, { force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(root, { recursive: true })
  for (const entry of await readdir(root, { withFileTypes: true })) {
    signal?.throwIfAborted()
    const target = resolve(root, entry.name)
    const key = relative(root, target)
    if (!key || isAbsolute(key) || key === '..' || key.startsWith(`..${sep}`))
      throw new Error('Cache target is outside its directory')
    if (
      pins.some((pin) => {
        const child = relative(target, pin)
        return !child || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
      })
    )
      continue
    await rm(target, { recursive: entry.isDirectory(), force: true })
  }
}
