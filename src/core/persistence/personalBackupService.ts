import type {
  CorePersonalBackupPreview,
  CorePersonalRestore,
  CorePersonalRestoreApi,
  PersonalLibraryDatabase
} from '../../shared/coreBackup.ts'
import {
  isRecord,
  PERSONAL_DOMAINS,
  remapPersonalPaths,
  type PersonalBackup,
  type PersonalData,
  type PersonalRestoreOptions,
  type PersonalBackupExportOptions
} from '../../shared/personalBackup.ts'
import type { MusicPersonalBackupRevision } from '../../shared/musicPersonalBackup.ts'
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
  private selected: { id: string; backup: PersonalBackup; options: PersonalRestoreOptions; revision?: MusicPersonalBackupRevision; musicConflict: boolean; recovery: boolean } | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private stopped = false
  private recovery = false
  constructor(options: Options) {
    this.options = options
    this.recovery = this.repository.personalRestoreNeedsReview(options.root)
  }
  async initialize(): Promise<void> {
    await this.options.database.corePersonalRestore()
    this.recovery = this.repository.personalRestoreNeedsReview(this.options.root)
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
  export(signal?: AbortSignal): Promise<boolean>
  export(options: PersonalBackupExportOptions, signal?: AbortSignal): Promise<boolean>
  export(optionsOrSignal: PersonalBackupExportOptions | AbortSignal = {}, signal?: AbortSignal): Promise<boolean> {
    const options = 'aborted' in optionsOrSignal ? {} : optionsOrSignal
    signal = 'aborted' in optionsOrSignal ? optionsOrSignal : signal
    return this.enqueue(async () => {
      const path = await this.options.chooseFile('export', signal)
      if (!path) return false
      await this.options.flush()
      const backup = await this.repository.createPersonalBackupFromDatabase(
        this.options.root,
        this.options.personalData(),
        this.options.database,
        options
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
      return this.selectBackup(backup, false, signal)
    }, signal)
  }
  recoveryAvailable(): boolean { return this.recovery }
  recoverPreview(signal?: AbortSignal): Promise<CorePersonalBackupPreview | null> {
    return this.enqueue(async () => {
      this.selected = null
      const backup = this.repository.readPersonalRestoreReview(this.options.root)
      this.recovery = backup !== null
      return backup ? this.selectBackup(backup, true, signal) : null
    }, signal)
  }
  private async selectBackup(backup: PersonalBackup, recovery: boolean, signal?: AbortSignal): Promise<CorePersonalBackupPreview> {
    const options: PersonalRestoreOptions = { conflict: 'keep-local', mappings: [], domains: PERSONAL_DOMAINS.filter((domain) => domain in backup.data) }
    await this.options.flush()
    const preview = await this.repository.previewRestoreFromDatabase(this.options.root, backup, this.options.personalData(), this.options.database, options)
    signal?.throwIfAborted()
    const id = this.options.newId()
    this.selected = { id, backup, options, revision: preview.music?.revision,
      musicConflict: !!(preview.music?.referenceConflicts.length || preview.music?.dependencies.includes('music:identity-reference-conflict')), recovery }
    return { ...preview, id }
  }
  repreview(request: CorePersonalRestore, signal?: AbortSignal): Promise<CorePersonalBackupPreview> {
    return this.enqueue(async () => {
      checkRestoreOptions(request.options)
      if (!this.selected || this.selected.id !== request.id)
        throw Object.assign(new Error('请重新选择并预览备份文件'), { code: 'STALE_REVISION' })
      await this.options.flush()
      const preview = await this.repository.previewRestoreFromDatabase(this.options.root, this.selected.backup, this.options.personalData(), this.options.database, request.options)
      signal?.throwIfAborted()
      this.selected = { ...this.selected, options: structuredClone(request.options), revision: preview.music?.revision,
        musicConflict: !!(preview.music?.referenceConflicts.length || preview.music?.dependencies.includes('music:identity-reference-conflict')) }
      return { ...preview, id: request.id }
    }, signal)
  }
  stage(request: CorePersonalRestore, signal?: AbortSignal): Promise<{ restartRequired: true }> {
    return this.enqueue(async () => {
      checkRestoreOptions(request.options)
      if (!this.selected || this.selected.id !== request.id)
        throw Object.assign(new Error('请重新选择并预览备份文件'), { code: 'STALE_REVISION' })
      const backup = this.selected.backup
      if (backup.version === 2 && this.restoreOptionsKey(request.options) !== this.restoreOptionsKey(this.selected.options))
        throw Object.assign(new Error('恢复项目、路径映射或冲突策略已改变，请先更新预览'), { code: 'STALE_REVISION' })
      if (backup.version === 2 && request.options.domains.includes('music') && this.selected.musicConflict)
        throw Object.assign(new Error('音乐整理存在引用、名称或流派层级冲突，请修正后更新预览'), { code: 'IDENTITY_CONFLICT' })
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
        this.options.personalData(),
        this.selected.revision
      )
      if (this.selected.recovery) {
        this.repository.acknowledgePersonalRestoreReview(this.options.root)
        this.recovery = false
      }
      this.selected = null
      return { restartRequired: true }
    }, signal)
  }
  chooseFolder(signal?: AbortSignal): Promise<string | null> {
    return this.options.chooseFolder(signal)
  }
  private restoreOptionsKey(options: PersonalRestoreOptions): string {
    return JSON.stringify({ conflict: options.conflict,
      domains: PERSONAL_DOMAINS.filter((domain) => options.domains.includes(domain)),
      mappings: options.mappings.map(({ from, to }) => ({ from, to })) })
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    await this.tail.catch(() => {})
  }
}
