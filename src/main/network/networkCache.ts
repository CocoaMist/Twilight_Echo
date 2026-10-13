import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { NetworkResumeUnsupported, NetworkSourceFailure } from './errors.ts'
import type { NetworkSourceSession } from './adapters/types.ts'
import type { NetworkEntry } from '../../shared/networkSources.ts'

interface CacheDownload {
  target: string
  session: NetworkSourceSession
  sizeBytes: number | undefined
  controller: AbortController
  subscribers: number
  promise: Promise<string>
}

const downloads = new Map<string, CacheDownload>()
const clears = new Map<string, Promise<void>>()

function pathKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function insideDirectory(target: string, directory: string): boolean {
  const path = relative(pathKey(directory), pathKey(target))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function cancelledDownload(): NetworkSourceFailure {
  return new NetworkSourceFailure('timeout', '网络文件下载已取消')
}

function subscribe(download: CacheDownload, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(cancelledDownload())
  download.subscribers += 1
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown, value?: string): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      download.subscribers -= 1
      if (error) reject(error)
      else resolve(value as string)
    }
    const onAbort = (): void => {
      finish(cancelledDownload())
      if (download.subscribers === 0) download.controller.abort()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    download.promise.then(
      (value) => finish(undefined, value),
      (error) => finish(error)
    )
  })
}

/**
 * 把远程条目下载到 network-cache。
 * 缓存键使用条目稳定 id（协议+profile+路径哈希），文件名不信任远程名。
 */
export async function downloadEntryToCache(deps: {
  session: NetworkSourceSession
  entry: NetworkEntry
  cacheRoot: string
  signal?: AbortSignal
}): Promise<string> {
  const { session, entry, cacheRoot, signal } = deps
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
  if (signal?.aborted) throw cancelledDownload()
  for (const [directory, pendingClear] of clears) {
    if (insideDirectory(target, directory)) await pendingClear
  }
  if (signal?.aborted) throw cancelledDownload()
  const key = pathKey(target)
  const existing = downloads.get(key)
  if (existing) {
    // A new consumer must not reuse an already abandoned producer, or a
    // publication for a different known revision of the same entry.
    if (existing.controller.signal.aborted || existing.sizeBytes !== entry.sizeBytes) {
      await existing.promise.catch(() => undefined)
      return downloadEntryToCache(deps)
    }
    return subscribe(existing, signal)
  }
  const controller = new AbortController()
  const download: CacheDownload = {
    target,
    session,
    sizeBytes: entry.sizeBytes,
    controller,
    subscribers: 0,
    promise: Promise.resolve('')
  }
  downloads.set(key, download)
  download.promise = performDownload(session, entry, cacheRoot, target, controller.signal).finally(
    () => {
      if (downloads.get(key) === download) downloads.delete(key)
    }
  )
  return subscribe(download, signal)
}

/** A cancelled caller may leave other consumers using its producer session. */
export async function closeSessionAfterCacheDownloads(
  session: NetworkSourceSession
): Promise<void> {
  const active = [...downloads.values()].filter((download) => download.session === session)
  if (active.length === 0) {
    await session.close()
    return
  }
  // Transfer cleanup ownership without delaying the cancelled caller until
  // another consumer finishes a potentially large media download.
  void Promise.allSettled(active.map((download) => download.promise))
    .then(() => session.close())
    .catch(() => undefined)
}

async function performDownload(
  session: NetworkSourceSession,
  entry: NetworkEntry,
  cacheRoot: string,
  target: string,
  signal: AbortSignal
): Promise<string> {
  await mkdir(cacheRoot, { recursive: true })
  if (signal.aborted) throw cancelledDownload()

  try {
    const info = await stat(target)
    if (signal.aborted) throw cancelledDownload()
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
      if (signal.aborted) throw cancelledDownload()
      await rename(temp, target)
      if (signal.aborted) throw cancelledDownload()
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
      if (signal.aborted) throw cancelledDownload()
      if (entry.sizeBytes == null || completedSize === entry.sizeBytes) {
        await rename(temp, target)
        if (signal.aborted) throw cancelledDownload()
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
    if (signal.aborted) throw cancelledDownload()
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
  const key = pathKey(directory)
  const previous = clears.get(key)
  if (previous) return previous
  const active = [...downloads.values()].filter((download) =>
    insideDirectory(download.target, directory)
  )
  for (const download of active) download.controller.abort()
  const clearing = Promise.allSettled(active.map((download) => download.promise))
    .then(async () => {
      await rm(directory, { recursive: true, force: true })
      await mkdir(directory, { recursive: true })
    })
    .finally(() => {
      if (clears.get(key) === clearing) clears.delete(key)
    })
  clears.set(key, clearing)
  return clearing
}
