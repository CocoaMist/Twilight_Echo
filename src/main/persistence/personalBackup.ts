import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadJsonFileWithBackup, writeJsonValueAtomic } from './jsonFile.ts'
import { parseJsonWithNestingLimit } from '../security/jsonSafety.ts'
import { loadMusicLibraryDocument } from '../library/libraryRepository.ts'
import {
  isRecord,
  PERSONAL_BACKUP_LIMIT,
  PERSONAL_DOMAINS,
  validatePersonalBackup,
  validatePersonalDomain,
  mergePersonalDomain,
  remapPersonalPaths,
  previewPersonalBackup,
  type PersonalBackup,
  type PersonalData,
  type PersonalDomain,
  type PersonalRestoreOptions
} from '../../shared/personalBackup.ts'

const files: Partial<Record<PersonalDomain, string>> = {
  library: 'music-library.json',
  playlists: 'playlists.json',
  queue: 'queue-workspace.json',
  playback: 'playback-session.json',
  lyrics: 'lyrics-management.json',
  bookmarks: 'playback-bookmarks.json',
  radio: 'radio-stations.json',
  podcasts: 'podcast-subscriptions.json'
}
const limits: Partial<Record<PersonalDomain, number>> = {
  library: 100,
  playlists: 20,
  queue: 32,
  playback: 34,
  lyrics: 8,
  bookmarks: 4,
  radio: 4,
  podcasts: 16,
  statistics: 16,
  versions: 8
}
const jsonOptions = {
  label: 'personal migration',
  maxBytes: PERSONAL_BACKUP_LIMIT * 3,
  validate: (v: unknown): v is Record<string, unknown> => isRecord(v)
}
const pendingName = 'personal-restore-pending.json'
const journalName = 'personal-restore-journal.json'
const rendererName = 'personal-restore-renderer.json'
type RestoreRequest = {
  backup: PersonalBackup
  options: PersonalRestoreOptions
  authorizedRoots?: string[]
}

export function parsePersonalBackup(text: string): PersonalBackup {
  if (Buffer.byteLength(text, 'utf8') > PERSONAL_BACKUP_LIMIT) throw new Error('备份超过 180 MiB')
  const value = parseJsonWithNestingLimit(text)
  if (!validatePersonalBackup(value)) throw new Error('备份格式、版本或数据内容无效')
  for (const domain of PERSONAL_DOMAINS)
    if (domain in value.data) assertDomainSize(domain, value.data[domain])
  return value
}
function assertDomainSize(domain: PersonalDomain, data: unknown) {
  // Leave room for the persistence envelope; restored files must fit their normal loader.
  if (Buffer.byteLength(JSON.stringify(data)) > (limits[domain] || 16) * 1024 * 1024 - 1024)
    throw new Error(`${domain} 数据超过容量限制`)
  if (domain === 'playback' && isRecord(data)) {
    const { queue, ...session } = data
    if (
      Buffer.byteLength(JSON.stringify(session)) > 2 * 1024 * 1024 - 1024 ||
      (queue !== undefined && Buffer.byteLength(JSON.stringify(queue)) > 32 * 1024 * 1024 - 1024)
    )
      throw new Error('播放快照超过保存容量')
  }
}
function readRaw(root: string, file: string): unknown {
  const loaded = loadJsonFileWithBackup(join(root, file), {
    ...jsonOptions,
    validate: (v: unknown): v is unknown => v !== undefined
  })
  return loaded.status === 'missing' ? undefined : loaded.value
}
function unwrap(value: unknown): unknown {
  return isRecord(value) && value.version === 2 && 'data' in value ? value.data : value
}
export function readPersonalData(root: string): PersonalData {
  const result: PersonalData = {}
  for (const domain of PERSONAL_DOMAINS) {
    const file = files[domain]
    if (!file) continue
    let value =
      domain === 'library'
        ? existsSync(join(root, file))
          ? loadMusicLibraryDocument(join(root, file)).document
          : undefined
        : unwrap(readRaw(root, file))
    if (
      domain === 'playback' &&
      isRecord(value) &&
      !value.queue &&
      value.queueRevision !== undefined
    ) {
      const queue = readRaw(root, 'playback-queue.json')
      if (!isRecord(queue) || queue.revision !== value.queueRevision)
        throw new Error('播放队列正发生变化，请稍后重新导出')
      value = { ...value, queue: queue.data }
      delete (value as Record<string, unknown>).queueRevision
    }
    if (value !== undefined) {
      if (!validatePersonalDomain(domain, value))
        throw new Error(`${domain} 当前数据无效，未导出或覆盖`)
      result[domain] = value
    }
  }
  return result
}
export function createPersonalBackup(root: string, rendererData: PersonalData): PersonalBackup {
  const data = readPersonalData(root)
  for (const domain of ['statistics', 'versions'] as const)
    if (rendererData[domain] !== undefined) {
      if (!validatePersonalDomain(domain, rendererData[domain]))
        throw new Error(`${domain} 数据无效`)
      data[domain] = rendererData[domain]
    }
  // Account/config/plugin files are not part of the allowlist. Remove incidental credentials
  // from extensible track snapshots as well, without changing user-authored lyrics or feed URLs.
  const text = JSON.stringify(
    { format: 'twilight-personal-data', version: 1, createdAt: new Date().toISOString(), data },
    function (key, value) {
      return /^(cookie|cookies|password|authorization|accessToken|refreshToken|secret|apiKey|headers|credentials|privateKey)$/i.test(
        key
      ) ||
        (key === 'streamUrl' && isRecord(this) && ('title' in this || 'source' in this))
        ? undefined
        : value
    }
  )
  return parsePersonalBackup(text)
}
export function checkRestoreOptions(value: unknown): asserts value is PersonalRestoreOptions {
  if (
    !isRecord(value) ||
    !['keep-local', 'use-backup'].includes(String(value.conflict)) ||
    !Array.isArray(value.domains) ||
    !value.domains.length ||
    !value.domains.every((d) => PERSONAL_DOMAINS.includes(d)) ||
    !Array.isArray(value.mappings) ||
    value.mappings.length > 100 ||
    !value.mappings.every(
      (m) =>
        isRecord(m) &&
        typeof m.from === 'string' &&
        !!m.from.trim() &&
        typeof m.to === 'string' &&
        !!m.to.trim() &&
        m.from.length < 4096 &&
        m.to.length < 4096
    )
  )
    throw new Error('请选择有效的恢复项目和路径映射')
}
export function stagePersonalRestore(
  root: string,
  backup: PersonalBackup,
  options: PersonalRestoreOptions,
  authorizedRoots: string[] = []
): void {
  checkRestoreOptions(options)
  parsePersonalBackup(JSON.stringify(backup))
  // Validate merging now; startup repeats this against the latest saved data.
  buildRestoreData(backup, options, readPersonalData(root))
  writeJsonValueAtomic(join(root, pendingName), { backup, options, authorizedRoots }, jsonOptions)
}
export function buildRestoreData(
  backup: PersonalBackup,
  options: PersonalRestoreOptions,
  current: PersonalData
): PersonalData {
  const result: PersonalData = {}
  for (const domain of options.domains) {
    if (!(domain in backup.data)) continue
    const incoming = remapPersonalPaths(backup.data[domain], options.mappings)
    const merged = mergePersonalDomain(domain, current[domain], incoming, options.conflict)
    if (!validatePersonalDomain(domain, merged))
      throw new Error(`${domain} 合并后存在重复关系或超出容量，请减少恢复项目或调整冲突选项`)
    assertDomainSize(domain, merged)
    result[domain] = merged
  }
  return result
}
export function previewRestore(root: string, backup: PersonalBackup, rendererData: PersonalData) {
  return previewPersonalBackup(backup, {
    ...readPersonalData(root),
    statistics: rendererData.statistics,
    versions: rendererData.versions
  })
}
function removeArtifact(root: string, name: string) {
  for (const suffix of ['', '.bak']) {
    const p = join(root, name + suffix)
    if (existsSync(p)) unlinkSync(p)
  }
}
// Called after the single-instance lock and before persistence owners are constructed.
// A durable redo journal makes a crash between files recoverable and prevents partial startup.
export function applyPendingPersonalRestore(
  root: string,
  beforeWrite?: (name: string) => void
): void {
  let journal = readRaw(root, journalName)
  if (journal === undefined) {
    const request = readRaw(root, pendingName) as RestoreRequest | undefined
    if (!request) return
    if (!validatePersonalBackup(request.backup)) throw new Error('待恢复备份无效')
    checkRestoreOptions(request.options)
    const current = readPersonalData(root)
    const data = buildRestoreData(request.backup, request.options, current)
    const writes: Record<string, unknown> = {}
    const originals: Record<string, unknown> = {}
    if (request.options.domains.includes('library') && request.authorizedRoots?.length) {
      const settings = readRaw(root, 'settings.json')
      originals['settings.json'] = settings ?? null
      const previous = isRecord(settings) ? settings : {}
      writes['settings.json'] = {
        ...previous,
        libraryFolders: [
          ...new Set([
            ...(Array.isArray(previous.libraryFolders) ? previous.libraryFolders : []),
            ...request.authorizedRoots
          ])
        ]
      }
    }
    for (const domain of PERSONAL_DOMAINS) {
      if (!(domain in data) || !files[domain]) continue
      const file = files[domain]!
      const previous = readRaw(root, file)
      originals[file] = previous ?? null
      const revision =
        isRecord(previous) && Number.isSafeInteger(previous.revision)
          ? Number(previous.revision) + 1
          : 1
      let value = data[domain]
      if (domain === 'playback' && isRecord(value)) {
        const session = { ...value }
        delete session.queueRevision
        // Embedded queue has a 2 MiB session limit; use the separate queue file.
        if (Array.isArray(session.queue)) {
          const previousQueue = readRaw(root, 'playback-queue.json')
          const queueRevision = isRecord(previousQueue)
            ? Number(previousQueue.revision || 0) + 1
            : 1
          originals['playback-queue.json'] = previousQueue ?? null
          writes['playback-queue.json'] = {
            version: 2,
            revision: queueRevision,
            savedAt: new Date().toISOString(),
            data: session.queue
          }
          delete session.queue
          session.queueRevision = queueRevision
        }
        value = session
      }
      writes[file] =
        domain === 'library' && isRecord(value)
          ? { ...value, revision }
          : { version: 2, revision, savedAt: new Date().toISOString(), data: value }
    }
    const rendererData = Object.fromEntries(
      ['statistics', 'versions']
        .filter(
          (d) => d in request.backup.data && request.options.domains.includes(d as PersonalDomain)
        )
        .map((d) => [
          d,
          remapPersonalPaths(request.backup.data[d as PersonalDomain], request.options.mappings)
        ])
    )
    writes[rendererName] = {
      id: randomUUID(),
      conflict: request.options.conflict,
      data: rendererData
    }
    journal = { writes, originals, createdAt: new Date().toISOString() }
    writeJsonValueAtomic(join(root, journalName), journal, jsonOptions)
  }
  if (!isRecord(journal) || !isRecord(journal.writes)) throw new Error('恢复日志无效')
  const allowed = new Set([
    ...Object.values(files),
    'playback-queue.json',
    rendererName,
    'settings.json'
  ])
  for (const [name, value] of Object.entries(journal.writes)) {
    if (!allowed.has(name)) throw new Error('恢复日志包含未知文件')
    beforeWrite?.(name)
    writeJsonValueAtomic(join(root, name), value, {
      ...jsonOptions,
      validate: (v: unknown): v is unknown => v !== undefined
    })
  }
  writeJsonValueAtomic(
    join(root, 'personal-restore-previous.json'),
    { data: journal.originals, createdAt: journal.createdAt },
    jsonOptions
  )
  removeArtifact(root, pendingName)
  removeArtifact(root, journalName)
}
export function readRendererRestore(root: string): unknown {
  return readRaw(root, rendererName) ?? null
}
export function acknowledgeRendererRestore(root: string, id: string): void {
  const current = readRendererRestore(root)
  if (isRecord(current) && current.id === id) removeArtifact(root, rendererName)
}
export function readBackupFile(path: string): PersonalBackup {
  if (statSync(path).size > PERSONAL_BACKUP_LIMIT) throw new Error('备份超过 180 MiB')
  return parsePersonalBackup(readFileSync(path, 'utf8'))
}
export function writePersonalBackupFile(path: string, backup: PersonalBackup): void {
  writeJsonValueAtomic(path, backup, {
    label: 'personal backup',
    maxBytes: PERSONAL_BACKUP_LIMIT,
    validate: validatePersonalBackup
  })
}
