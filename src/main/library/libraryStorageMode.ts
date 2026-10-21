import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** SQLite is the default for development and packaged applications.
 * Explicit legacy development runs cannot reopen stale retained JSON after migration. */
export function selectLibraryStorage(
  root: string,
  isPackaged: boolean,
  override: string | undefined
): 'json' | 'sqlite' {
  if (isPackaged || override !== '0') return 'sqlite'
  if (existsSync(join(root, 'music-library.sqlite')))
    throw new Error('此数据目录已使用 SQLite 曲库，不能退回旧 JSON。请使用默认 SQLite 模式打开。')
  return 'json'
}
