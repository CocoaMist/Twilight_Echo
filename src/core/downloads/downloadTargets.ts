import { open, type FileHandle } from 'node:fs/promises'
import { lexicalPathKey } from '../persistence/pathGrants.ts'

/** Platforms and filesystems that cannot honour an explicit flush of an already-written file. */
const UNAVAILABLE_FLUSH_CODES = new Set([
  'EPERM',
  'EACCES',
  'EROFS',
  'EINVAL',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP'
])

/**
 * Windows implements fsync as FlushFileBuffers, which requires a handle carrying
 * write access: flushing a handle opened read-only fails with
 * `EPERM: operation not permitted, fsync` and used to abort every finished
 * download right before the rename. Open the part file read/write so the flush is
 * permitted, and treat a filesystem that refuses to flush at all as best effort —
 * the payload is already written and size-verified, so a missing durability
 * barrier must not discard it.
 */
export async function flushFileToDisk(filePath: string): Promise<void> {
  let handle: FileHandle
  try {
    handle = await open(filePath, 'r+')
  } catch (error) {
    if (isUnavailableFlushError(error)) return
    throw error
  }
  try {
    await handle.sync()
  } catch (error) {
    if (!isUnavailableFlushError(error)) throw error
  } finally {
    await handle.close()
  }
}

/**
 * The configured download directory outranks the music library, and duplicates
 * collapse so a download directory that is also a library root stays a single
 * candidate.
 */
export function orderDownloadRoots(
  downloadRoot: string | null | undefined,
  libraryRoots: readonly string[]
): string[] {
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const root of [downloadRoot, ...libraryRoots]) {
    if (typeof root !== 'string' || !root.trim()) continue
    const key = lexicalPathKey(root)
    if (seen.has(key)) continue
    seen.add(key)
    ordered.push(root)
  }
  return ordered
}

/** An explicit request must match one of the authorized roots; otherwise the first one wins. */
export function selectDownloadTargetRoot(requested: unknown, roots: readonly string[]): string {
  if (roots.length === 0) {
    throw new Error('请先在设置中选择下载目录，或添加并授权本地音乐库目录')
  }
  if (typeof requested !== 'string' || !requested.trim()) return roots[0]
  const targetKey = lexicalPathKey(requested)
  const match = roots.find((root) => lexicalPathKey(root) === targetKey)
  if (!match) throw new Error('下载目录必须是已授权的下载目录或本地音乐库根目录')
  return match
}

function isUnavailableFlushError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && UNAVAILABLE_FLUSH_CODES.has(code)
}
