import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  LocalLibraryRemovalMode,
  LocalLibraryTrackSelection
} from '../../shared/localLibrary.ts'
import type { LibraryMetadata } from '../../shared/libraryDatabase.ts'
import type {
  LibraryRemovalItem,
  LibraryRemovalOperation,
  LibraryRemovalResult
} from './libraryDatabaseProtocol.ts'
import { normalizeLibraryFilePath } from './libraryRepository.ts'

type Owner = {
  sql: DatabaseSync
  transaction<T>(action: () => T): T
  meta(key: string): string
  setMeta(key: string, value: unknown): void
  bump(): number
  metadata(): LibraryMetadata
}
const pendingKey = 'pending_file_removal'
const completedKey = 'last_file_removal'
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function fileIdentity(filePath: string): NonNullable<LibraryRemovalItem['identity']> {
  const info = statSync(filePath, { bigint: true })
  if (!info.isFile()) throw new Error('回收站目标不是文件')
  return {
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
    device: String(info.dev),
    inode: String(info.ino)
  }
}

/** A single, bounded durable operation shares the library transaction owner.
 * The OS trash call stays in main; its before/after checkpoints stay in SQLite. */
export class LibraryDatabaseRemoval {
  private readonly owner: Owner
  constructor(owner: Owner) {
    this.owner = owner
  }

  pending(): LibraryRemovalOperation | null {
    return JSON.parse(this.owner.meta(pendingKey) || 'null')
  }
  private operation(id: string): LibraryRemovalOperation {
    const pending = this.pending()
    if (pending?.id === id) return pending
    const completed = JSON.parse(
      this.owner.meta(completedKey) || 'null'
    ) as LibraryRemovalOperation | null
    if (completed?.id === id) return completed
    throw new Error('曲库删除任务不存在或已被其他任务替代')
  }
  blockedPaths(): Set<string> {
    return new Set(
      (this.pending()?.items ?? [])
        .filter((item) => item.state === 'pending' || item.state === 'working')
        .map((item) => normalizeLibraryFilePath(item.selection.filePath))
    )
  }
  assertIdle(): void {
    if (this.pending()) throw new Error('请先完成或恢复未完成的曲库删除任务')
  }
  begin(
    id: string,
    mode: LocalLibraryRemovalMode,
    selections: LocalLibraryTrackSelection[],
    recoveringLegacyJournal = false
  ): LibraryRemovalOperation {
    if (
      !/^[a-zA-Z0-9-]{1,128}$/.test(id) ||
      !['library', 'trash'].includes(mode) ||
      !Array.isArray(selections) ||
      selections.length > 256 ||
      selections.some(
        (item) =>
          !item ||
          typeof item.id !== 'string' ||
          !item.id ||
          typeof item.filePath !== 'string' ||
          !item.filePath.trim() ||
          typeof item.title !== 'string' ||
          typeof item.artist !== 'string' ||
          (item.expectedVersion !== undefined &&
            (!Number.isSafeInteger(item.expectedVersion) || item.expectedVersion < 1)) ||
          (item.expectedInstance !== undefined &&
            (item.expectedVersion === undefined ||
              !Number.isSafeInteger(item.expectedInstance) ||
              item.expectedInstance < 1))
      )
    )
      throw new Error('无效的曲库删除批次（每批最多 256 个文件）')
    const unique = new Map(
      selections.map((item) => [normalizeLibraryFilePath(item.filePath), item])
    )
    return this.owner.transaction(() => {
      const pending = this.pending()
      const previous =
        pending ??
        (JSON.parse(this.owner.meta(completedKey) || 'null') as LibraryRemovalOperation | null)
      if (previous?.id === id) {
        if (
          previous.mode !== mode ||
          previous.items.length !== unique.size ||
          previous.items.some((item) => {
            const selected = unique.get(normalizeLibraryFilePath(item.selection.filePath))
            return (
              selected?.id !== item.selection.id ||
              selected.expectedVersion !== item.selection.expectedVersion ||
              selected.expectedInstance !== item.selection.expectedInstance
            )
          })
        )
          throw new Error('不能将曲库删除任务标识用于不同的文件')
        return previous
      }
      if (pending) throw new Error('请先完成或恢复未完成的曲库删除任务')
      const items: LibraryRemovalItem[] = []
      for (const [key, selection] of unique) {
        const item: LibraryRemovalItem = { selection, state: 'pending', removedTrackIds: [] }
        const row = this.owner.sql
          .prepare('SELECT id,version,seq FROM tracks WHERE id=? AND file_key=?')
          .get(selection.id, key)
        if (!row) {
          item.state = 'failed'
          item.error = '曲目已不在本地音乐库中'
        } else if (
          (selection.expectedVersion !== undefined &&
            Number(row.version) !== selection.expectedVersion) ||
          (selection.expectedInstance !== undefined &&
            Number(row.seq) !== selection.expectedInstance)
        ) {
          item.state = 'failed'
          item.error = '曲目在选择后已变化，请重新选择'
        } else {
          if (mode === 'trash') {
            try {
              item.identity = fileIdentity(selection.filePath)
              if (recoveringLegacyJournal) {
                item.state = 'failed'
                item.error = '回收站目标仍存在或已被替换，保留曲库记录'
              }
            } catch (error) {
              if (recoveringLegacyJournal) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
                if (!statSync(dirname(selection.filePath)).isDirectory())
                  throw new Error('回收站目录不可访问')
                item.state = 'working'
              } else {
                item.state = 'failed'
                item.error = message(error)
              }
            }
          }
          if (item.state === 'pending' || item.state === 'working')
            this.owner.sql
              .prepare('UPDATE files SET content_version=content_version+1 WHERE file_key=?')
              .run(key)
        }
        items.push(item)
      }
      const operation = { id, mode, items }
      this.owner.setMeta(pendingKey, operation)
      return operation
    })
  }
  attempting(id: string, filePath: string): LibraryRemovalOperation {
    return this.owner.transaction(() => {
      const operation = this.operation(id),
        item = this.item(operation, filePath)
      if (item.state !== 'pending') throw new Error('删除任务不能重复领取；请先恢复其状态')
      if (item.selection.expectedVersion !== undefined) {
        const row = this.owner.sql
          .prepare('SELECT version,seq FROM tracks WHERE id=? AND file_key=?')
          .get(item.selection.id, normalizeLibraryFilePath(filePath))
        if (
          !row ||
          Number(row.version) !== item.selection.expectedVersion ||
          (item.selection.expectedInstance !== undefined &&
            Number(row.seq) !== item.selection.expectedInstance)
        ) {
          return this.fail(operation, item, '曲目在授权前已变化，请重新选择')
        }
      }
      if (
        operation.mode === 'trash' &&
        JSON.stringify(fileIdentity(filePath)) !== JSON.stringify(item.identity)
      )
        throw new Error('回收站目标文件已变化，未执行删除')
      item.state = 'working'
      this.owner.setMeta(pendingKey, operation)
      return operation
    })
  }
  /** A newly versioned intent may be edited before claiming (the claim will
   * reject it), but not after the acknowledged destructive checkpoint. */
  assertTrackWritable(fileKey: string): void {
    if (
      this.pending()?.items.some(
        (item) =>
          item.state === 'working' &&
          item.selection.expectedVersion !== undefined &&
          normalizeLibraryFilePath(item.selection.filePath) === fileKey
      )
    )
      throw new Error('曲目文件正在移除，请稍后重试编辑')
  }
  private item(operation: LibraryRemovalOperation, filePath: string): LibraryRemovalItem {
    const item = operation.items.find(
      (item) =>
        normalizeLibraryFilePath(item.selection.filePath) === normalizeLibraryFilePath(filePath)
    )
    if (!item) throw new Error('文件不在当前曲库删除任务中')
    return item
  }
  settle(id: string, filePath: string, succeeded: boolean, error = ''): LibraryRemovalOperation {
    if (typeof succeeded !== 'boolean' || typeof error !== 'string')
      throw new Error('无效的删除结果')
    return this.owner.transaction(() => {
      const operation = this.operation(id),
        item = this.item(operation, filePath)
      if (item.state === 'succeeded' || item.state === 'failed') return operation
      if (succeeded && item.state !== 'working') throw new Error('删除操作尚未授权领取')
      if (succeeded && operation.mode === 'trash') {
        // ENOENT alone cannot distinguish a deleted file from an offline drive.
        // Its containing directory must still be accessible before committing.
        if (!statSync(dirname(filePath)).isDirectory())
          throw new Error('回收站目录不可访问，保留恢复任务')
        try {
          statSync(filePath)
        } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure
          return this.commit(operation, item)
        }
        throw new Error('回收站目标仍存在或已被替换，未移除曲库记录')
      }
      if (succeeded) return this.commit(operation, item)
      return this.fail(operation, item, error || '回收站操作未完成')
    })
  }
  private fail(operation: LibraryRemovalOperation, item: LibraryRemovalItem, error: string) {
    item.state = 'failed'
    item.error = error
    this.owner.sql
      .prepare('UPDATE files SET content_version=content_version+1 WHERE file_key=?')
      .run(normalizeLibraryFilePath(item.selection.filePath))
    this.owner.setMeta(pendingKey, operation)
    return operation
  }
  private commit(
    operation: LibraryRemovalOperation,
    item: LibraryRemovalItem
  ): LibraryRemovalOperation {
    const key = normalizeLibraryFilePath(item.selection.filePath)
    item.removedTrackIds = this.owner.sql
      .prepare('SELECT id FROM tracks WHERE file_key=? ORDER BY seq')
      .all(key)
      .map((row) => String(row.id))
    this.owner.sql.prepare('DELETE FROM tracks WHERE file_key=?').run(key)
    // Keep a version tombstone: deleting the row would reset it to zero and
    // let a previously claimed result resurrect this same physical file.
    this.owner.sql
      .prepare(
        "UPDATE files SET content_version=content_version+1,status='removed',identity=NULL,metadata_version=0,audio_metadata=NULL WHERE file_key=?"
      )
      .run(key)
    if (operation.mode === 'library' && item.removedTrackIds.length) {
      const exclusions = this.owner
        .metadata()
        .exclusions.filter((entry) => normalizeLibraryFilePath(entry.filePath) !== key)
      exclusions.push({
        filePath: item.selection.filePath,
        title: item.selection.title || item.selection.filePath.split(/[\\/]/).pop()!,
        artist: item.selection.artist,
        excludedAt: new Date().toISOString()
      })
      this.owner.setMeta('exclusions', exclusions)
    }
    item.state = 'succeeded'
    this.owner.setMeta(pendingKey, operation)
    if (item.removedTrackIds.length) this.owner.bump()
    return operation
  }
  finish(id: string): LibraryRemovalResult {
    return this.owner.transaction(() => {
      const operation = this.operation(id)
      if (operation.items.some((item) => ['pending', 'working'].includes(item.state)))
        throw new Error('曲库删除任务尚未完成')
      const pending = this.pending()
      if (pending && pending.id !== id) throw new Error('其他曲库删除任务正在运行')
      this.owner.setMeta(completedKey, operation)
      this.owner.setMeta(pendingKey, null)
      return {
        id,
        mode: operation.mode,
        metadata: this.owner.metadata(),
        removedTrackIds: operation.items.flatMap((item) => item.removedTrackIds),
        removedFilePaths: operation.items
          .filter((item) => item.state === 'succeeded')
          .map((item) => item.selection.filePath),
        failures: operation.items
          .filter((item) => item.state === 'failed')
          .map((item) => ({
            filePath: item.selection.filePath,
            message: item.error || '删除未完成'
          }))
      }
    })
  }
  recover(): LibraryRemovalResult | null {
    const operation = this.pending()
    if (!operation) return null
    for (const item of operation.items) {
      if (item.state === 'pending') {
        // Main may have crashed before authorizing this item. Only an
        // acknowledged 'working' checkpoint is allowed to finish on recovery.
        this.settle(operation.id, item.selection.filePath, false, '删除操作未开始')
      } else if (item.state === 'working') {
        if (operation.mode === 'library') {
          this.settle(operation.id, item.selection.filePath, true)
          continue
        }
        let absent = false
        try {
          statSync(item.selection.filePath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          absent = true
        }
        this.settle(operation.id, item.selection.filePath, absent, '回收站操作未完成，文件仍存在')
      }
    }
    return this.finish(operation.id)
  }
  recoverLegacyJournal(id: string, items: LocalLibraryTrackSelection[]): LibraryRemovalResult {
    this.begin(id, 'trash', items, true)
    return this.pending()?.id === id ? this.recover()! : this.finish(id)
  }
}
