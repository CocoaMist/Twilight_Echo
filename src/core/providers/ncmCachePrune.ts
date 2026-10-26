/**
 * ncm-cache 目录的容量治理纯逻辑（不依赖 electron / fs，可单测）。
 * ncmCache.ts 在每次写入完成后用目录快照调用 planNcmCachePrune。
 */

/** ncm-cache 成品文件总容量上限。超出后按最近使用（mtime 由命中时 touch 维护）淘汰。 */
export const NCM_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024

/** 中断下载残留的 .part 超过该时长即视为孤儿并清理。 */
export const NCM_CACHE_PART_MAX_AGE_MS = 60 * 60 * 1000

export interface NcmCacheFileInfo {
  name: string
  size: number
  mtimeMs: number
}

export interface NcmCachePrunePlan {
  deleteNames: string[]
  remainingBytes: number
  orphanPartNames: string[]
}

export function planNcmCachePrune(
  files: readonly NcmCacheFileInfo[],
  maxBytes: number = NCM_CACHE_MAX_BYTES,
  nowMs: number = Date.now(),
  protectedNames: ReadonlySet<string> = new Set()
): NcmCachePrunePlan {
  const finished: NcmCacheFileInfo[] = []
  const orphanPartNames: string[] = []
  for (const file of files) {
    if (file.name.includes('.part')) {
      if (!protectedNames.has(file.name) && nowMs - file.mtimeMs > NCM_CACHE_PART_MAX_AGE_MS)
        orphanPartNames.push(file.name)
      continue
    }
    finished.push(file)
  }

  let remainingBytes = 0
  for (const file of finished) remainingBytes += file.size

  // LRU：优先淘汰最久未使用的成品文件。
  const byLeastRecent = [...finished].sort((a, b) => a.mtimeMs - b.mtimeMs)
  const deleteNames: string[] = []
  for (const file of byLeastRecent) {
    if (remainingBytes <= maxBytes) break
    if (protectedNames.has(file.name)) continue
    deleteNames.push(file.name)
    remainingBytes -= file.size
  }

  return { deleteNames, remainingBytes, orphanPartNames }
}
