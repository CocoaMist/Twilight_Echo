import type {
  LocalLibraryTrackSelection,
  LocalLibraryRemovalMode
} from '../../shared/localLibrary.ts'
import type {
  CoreRemovalDatabase,
  LibraryRemovalResult
} from '../../shared/coreLibraryMaintenance.ts'

type Database = Pick<
  CoreRemovalDatabase,
  'beginRemoval' | 'markRemovalAttempting' | 'settleRemovalItem' | 'finishRemoval'
>

/** Main-process filesystem seam. The caller authorizes each file and releases
 * decoder handles before supplying trashItem. An unknown database outcome is
 * left pending for recovery, never converted into a failed OS operation. */
export async function commitDatabaseLibraryRemoval(options: {
  database: Database
  id: string
  mode: LocalLibraryRemovalMode
  items: LocalLibraryTrackSelection[]
  authorize: (filePath: string) => Promise<void>
  trashItem: (filePath: string) => Promise<void>
  pathKey: (filePath: string) => string
}): Promise<LibraryRemovalResult> {
  const { database, id, mode } = options
  const operation = await database.beginRemoval(id, mode, options.items)
  for (const item of operation.items) {
    if (item.state === 'working') throw new Error('回收站操作结果未知，请先恢复删除任务')
    if (item.state !== 'pending') continue
    const path = item.selection.filePath
    try {
      await options.authorize(path)
    } catch (error) {
      await database.settleRemovalItem(
        id,
        path,
        false,
        error instanceof Error ? error.message : String(error)
      )
      continue
    }
    // This authorization checkpoint must be acknowledged before changing the
    // library or filesystem. Recovery never executes unclaimed selections.
    const claimed = await database.markRemovalAttempting(id, path)
    const checkpoint = claimed.items.find(
      (entry) => options.pathKey(entry.selection.filePath) === options.pathKey(path)
    )
    if (
      claimed.id !== id ||
      claimed.mode !== mode ||
      !checkpoint ||
      checkpoint.selection.id !== item.selection.id ||
      checkpoint.selection.expectedVersion !== item.selection.expectedVersion ||
      checkpoint.selection.expectedInstance !== item.selection.expectedInstance
    )
      throw new Error('删除授权检查点回复无效，操作已中断')
    if (checkpoint.state === 'failed') continue
    if (checkpoint.state !== 'working') throw new Error('删除授权检查点回复无效，操作已中断')
    if (mode === 'trash') {
      try {
        await options.trashItem(path)
      } catch (error) {
        await database.settleRemovalItem(
          id,
          path,
          false,
          error instanceof Error ? error.message : String(error)
        )
        continue
      }
    }
    await database.settleRemovalItem(id, path, true)
  }
  return database.finishRemoval(id)
}
