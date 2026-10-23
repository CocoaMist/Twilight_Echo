import type {
  CorePersonalBackupPreview,
  CorePersonalRestore,
  CorePersonalRestoreApi,
  PersonalLibraryDatabase
} from '../../shared/coreBackup.ts'
import {
  isRecord,
  remapPersonalPaths,
  type PersonalBackup,
  type PersonalData
} from '../../shared/personalBackup.ts'
import { checkRestoreOptions, createPersonalBackupRepository } from './personalBackup.ts'

interface Options {
  root: string
  database: PersonalLibraryDatabase & CorePersonalRestoreApi
  flush(): Promise<void>
  personalData(): PersonalData
  chooseFile(kind: 'import' | 'export', signal?: AbortSignal): Promise<string | null>
  chooseFolder(signal?: AbortSignal): Promise<string | null>
  authorizeRoots(roots: string[]): Promise<string[]>
  newId(): string
}

/** Portable file format and redo journal; every domain is read from Core owners. */
export class CorePersonalBackupService {
  private readonly options: Options
  private readonly repository = createPersonalBackupRepository()
  private selected: { id: string; backup: PersonalBackup } | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private stopped = false
  constructor(options: Options) {
    this.options = options
  }
  async initialize(): Promise<void> {
    await this.options.database.corePersonalRestore()
  }
  private enqueue<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.stopped) throw new Error('Personal backup is shutting down')
    const work = this.tail
      .catch(() => {})
      .then(() => {
        signal?.throwIfAborted()
        return action()
      })
    this.tail = work
    return work
  }
  export(signal?: AbortSignal): Promise<boolean> {
    return this.enqueue(async () => {
      const path = await this.options.chooseFile('export', signal)
      if (!path) return false
      await this.options.flush()
      const backup = await this.repository.createPersonalBackupFromDatabase(
        this.options.root,
        this.options.personalData(),
        this.options.database
      )
      signal?.throwIfAborted()
      this.repository.writePersonalBackupFile(path, backup)
      return true
    }, signal)
  }
  preview(signal?: AbortSignal): Promise<CorePersonalBackupPreview | null> {
    return this.enqueue(async () => {
      this.selected = null
      const path = await this.options.chooseFile('import', signal)
      if (!path) return null
      const backup = this.repository.readBackupFile(path)
      await this.options.flush()
      const preview = await this.repository.previewRestoreFromDatabase(
        this.options.root,
        backup,
        this.options.personalData(),
        this.options.database
      )
      signal?.throwIfAborted()
      const id = this.options.newId()
      this.selected = { id, backup }
      return { ...preview, id }
    }, signal)
  }
  stage(request: CorePersonalRestore, signal?: AbortSignal): Promise<{ restartRequired: true }> {
    return this.enqueue(async () => {
      checkRestoreOptions(request.options)
      if (!this.selected || this.selected.id !== request.id)
        throw Object.assign(new Error('请重新选择并预览备份文件'), { code: 'STALE_REVISION' })
      const backup = this.selected.backup
      const mapped = remapPersonalPaths(backup.data.library, request.options.mappings)
      const roots =
        request.options.domains.includes('library') &&
        isRecord(mapped) &&
        Array.isArray(mapped.folders)
          ? await this.options.authorizeRoots(mapped.folders as string[])
          : []
      await this.options.flush()
      await this.repository.stagePersonalRestoreFromDatabase(
        this.options.root,
        backup,
        request.options,
        roots,
        this.options.database,
        this.options.personalData()
      )
      this.selected = null
      return { restartRequired: true }
    }, signal)
  }
  chooseFolder(signal?: AbortSignal): Promise<string | null> {
    return this.options.chooseFolder(signal)
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    await this.tail.catch(() => {})
  }
}
