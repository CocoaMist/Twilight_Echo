/**
 * ncm-cache 成品文件「songId → 文件名」索引的纯逻辑（不依赖 electron/fs，可单测）。
 * ncmCache.ts 把目录快照喂给这里构建内存索引，避免每次播放都 readdirSync。
 */

/** 解析缓存文件名中的 songId；下载中的 .part 临时文件与非数字前缀一律忽略。 */
export function parseNcmCacheFileSongId(name: string): number | null {
  if (!name || name.includes('.part')) return null
  const match = /^(\d+)\./.exec(name)
  if (!match) return null
  const songId = Number(match[1])
  if (!Number.isSafeInteger(songId) || songId <= 0) return null
  return songId
}

/** 从目录文件名快照构建索引。目录里同名 songId 的异常双份文件保留首个条目。 */
export function buildNcmCacheIndexFromNames(names: Iterable<string>): Map<number, string> {
  const index = new Map<number, string>()
  for (const name of names) {
    const songId = parseNcmCacheFileSongId(name)
    if (songId == null) continue
    if (!index.has(songId)) index.set(songId, name)
  }
  return index
}
