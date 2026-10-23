import {
  prepareDownloadedMetadata,
  saveDownloadedLyrics,
  type FetchDownloadCover
} from './downloadMetadata.ts'
import {
  normalizeDownloadPreferences,
  downloadTrackName,
  type DownloadPreferences
} from '../../shared/downloadPreferences.ts'
import { randomUUID } from 'node:crypto'
import { createWriteStream, constants } from 'node:fs'
import { access, copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { basename, extname, join, parse } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import type { TwilightPluginManager } from '../plugins/manager.ts'
import { resolveCompletedDownloadResult } from './completedDownloadResult.ts'
import { isCanonicalPathInside } from '../persistence/pathGrants.ts'
import { flushFileToDisk, orderDownloadRoots, selectDownloadTargetRoot } from './downloadTargets.ts'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  ProviderDownloadCreateInput,
  ProviderDownloadQuality,
  ProviderDownloadTaskSnapshot
} from '../../shared/providerDownloads.ts'

const POLL_INTERVAL_MS = 1_500
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
/** 每个任务进度事件的最小下发间隔；分块流期间的进度 patch 大量合并于此。 */
const PROGRESS_EMIT_INTERVAL_MS = 250
/** 即使间隔未到，进度推进超过 1% 也立即下发，保证大文件粗粒度仍然流暢。 */
const PROGRESS_EMIT_STEP = 0.01
/** 终态任务只保留最近 N 条，防止任务 Map 随使用时长无界增长。 */
const TERMINAL_TASK_RETENTION = 50
const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.wav',
  '.wave',
  '.aac',
  '.ogg',
  '.wma',
  '.m4a',
  '.mp4',
  '.aiff',
  '.aif',
  '.opus',
  '.webm',
  '.alac',
  '.ape',
  '.wv',
  '.dsf',
  '.dff',
  '.mqa'
])

interface RemoteDownloadTask {
  jobId: string
  status: 'queued' | 'preparing' | 'ready' | 'failed' | 'cancelled' | 'expired'
  progress: number
  queuePosition?: number | null
  requestedQuality: ProviderDownloadQuality
  actualQuality?: ProviderDownloadQuality | null
  fileName?: string | null
  fileSize?: number | null
  contentType?: string | null
  error?: string | null
}

interface RemoteDownloadFile {
  url: string
  fileName?: string | null
  fileSize?: number | null
  contentType?: string | null
  actualQuality?: ProviderDownloadQuality | null
}

export interface ProviderDownloadManagerOptions {
  getPreferences?: () => DownloadPreferences
  pluginManager: Pick<TwilightPluginManager, 'callProvider'>
  authorizedRoots: () => Promise<{ libraryRoots: string[]; downloadRoot: string | null }>
  indexer?: () => ((path: string) => void | Promise<void>) | null
  grant: (path: string) => Promise<string>
  fetchCover?: FetchDownloadCover
  prepareMetadata?: typeof prepareDownloadedMetadata
  onChanged: () => void
  log?: (taskId: string, previous: string, patch: Partial<ProviderDownloadTaskSnapshot>) => void
  fetch?: typeof globalThis.fetch
  now?: () => Date
}

export class ProviderDownloadManager {
  private readonly tasks = new Map<string, ProviderDownloadTaskSnapshot>()
  private readonly abortControllers = new Map<string, AbortController>()
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly now: () => Date
  private readonly resultOperations = new Map<string, Promise<unknown>>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly runs = new Map<string, Promise<void>>()
  private readonly lifetime = new AbortController()
  private shutdownWork: Promise<void> | null = null
  private readonly options: ProviderDownloadManagerOptions

  constructor(options: ProviderDownloadManagerOptions) {
    this.options = options
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.now = options.now ?? (() => new Date())
  }

  list(): ProviderDownloadTaskSnapshot[] {
    return this.page(0, this.tasks.size)
  }
  page(offset: number, limit: number): ProviderDownloadTaskSnapshot[] {
    return [...this.tasks.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(offset, offset + limit)
      .map((task) => structuredClone(task))
  }
  get(id: string): ProviderDownloadTaskSnapshot {
    return structuredClone(this.requireTask(id))
  }
  counts(): { total: number; active: number } {
    let active = 0
    for (const task of this.tasks.values()) if (!TERMINAL_STATUSES.has(task.status)) active++
    return { total: this.tasks.size, active }
  }

  async completedResult(taskId: string, addToLibrary = false): Promise<string> {
    this.lifetime.signal.throwIfAborted()
    const previous = this.resultOperations.get(taskId) ?? Promise.resolve()
    const operation = previous
      .catch(() => {})
      .then(async () => {
        const task = this.requireTask(taskId)
        const { libraryRoots, downloadRoot } = await this.options.authorizedRoots()
        return resolveCompletedDownloadResult(task, {
          libraryRoots,
          downloadRoots: downloadRoot ? [downloadRoot] : [],
          addToLibrary,
          enqueue: this.options.indexer?.() ?? undefined,
          updatePath: (path) => this.patch(taskId, { targetPath: path }),
          grant: this.options.grant
        })
      })
    this.resultOperations.set(taskId, operation)
    try {
      return await this.track(operation)
    } finally {
      if (this.resultOperations.get(taskId) === operation) this.resultOperations.delete(taskId)
      if (this.pruneTerminalTasks()) this.emitChanged()
    }
  }

  create(input: ProviderDownloadCreateInput): Promise<ProviderDownloadTaskSnapshot> {
    this.lifetime.signal.throwIfAborted()
    return this.track(this.createTask(input))
  }

  private async createTask(
    input: ProviderDownloadCreateInput
  ): Promise<ProviderDownloadTaskSnapshot> {
    const providerId = normalizeProviderId(input.providerId)
    const track = normalizeTrack(input.track)
    const quality = normalizeQuality(input.quality)
    const targetRoot = await this.resolveTargetRoot(input.targetRoot)
    this.lifetime.signal.throwIfAborted()
    const remote = normalizeRemoteTask(
      await this.options.pluginManager.callProvider(
        providerId,
        'createDownload',
        [{ track, quality }],
        { idempotencyKey: randomUUID(), signal: this.lifetime.signal }
      )
    )
    this.lifetime.signal.throwIfAborted()
    const timestamp = this.now().toISOString()
    const task: ProviderDownloadTaskSnapshot = {
      id: randomUUID(),
      providerId,
      providerJobId: remote.jobId,
      track,
      requestedQuality: quality,
      actualQuality: remote.actualQuality ?? null,
      status:
        remote.status === 'ready' ? 'preparing' : remote.status === 'failed' ? 'failed' : 'queued',
      progress: clampProgress(remote.progress),
      queuePosition: normalizeOptionalInteger(remote.queuePosition),
      targetPath: null,
      fileSize: normalizeOptionalSize(remote.fileSize),
      error: remote.error ?? null,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    this.tasks.set(task.id, task)
    if (TERMINAL_STATUSES.has(task.status)) this.pruneTerminalTasks()
    this.emitChanged()
    if (!TERMINAL_STATUSES.has(task.status)) {
      const run = Promise.resolve().then(() => this.run(task.id, targetRoot, remote))
      this.runs.set(task.id, run)
      void run.finally(() => {
        this.runs.delete(task.id)
        if (this.pruneTerminalTasks()) this.emitChanged()
      })
    }
    return structuredClone(task)
  }

  cancel(taskId: string): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    return this.track(this.cancelTask(taskId))
  }
  private async cancelTask(taskId: string): Promise<void> {
    const task = this.requireTask(taskId)
    if (TERMINAL_STATUSES.has(task.status)) return
    this.abortControllers.get(task.id)?.abort(new Error('用户取消下载'))
    try {
      await this.options.pluginManager.callProvider(
        task.providerId,
        'cancelDownload',
        [task.providerJobId],
        { signal: this.lifetime.signal }
      )
    } catch {
      // Local cancellation still wins if the remote task already reached a terminal state.
    }
    await this.runs.get(task.id)
    // An already-published file wins a cancellation racing its final copy.
    if (!TERMINAL_STATUSES.has(task.status))
      this.patch(task.id, { status: 'cancelled', error: null })
  }

  async retry(taskId: string): Promise<ProviderDownloadTaskSnapshot> {
    const previous = this.requireTask(taskId)
    if (previous.status !== 'failed' && previous.status !== 'cancelled') {
      throw new Error('只有失败或已取消的任务可以重试')
    }
    return this.create({
      providerId: previous.providerId,
      track: previous.track,
      quality: previous.requestedQuality
    })
  }

  private async run(
    taskId: string,
    targetRoot: string,
    initial: RemoteDownloadTask
  ): Promise<void> {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    this.abortControllers.set(taskId, controller)
    try {
      let remote = initial
      while (remote.status !== 'ready') {
        signal.throwIfAborted()
        if (remote.status === 'failed' || remote.status === 'expired') {
          throw new Error(
            remote.error ||
              (remote.status === 'expired' ? '远端下载任务已过期' : '远端下载任务失败')
          )
        }
        if (remote.status === 'cancelled') {
          this.patch(taskId, { status: 'cancelled', error: null })
          return
        }
        this.patch(taskId, {
          status: remote.status === 'queued' ? 'queued' : 'preparing',
          progress: clampProgress(remote.progress) * 0.45,
          queuePosition: normalizeOptionalInteger(remote.queuePosition),
          actualQuality: remote.actualQuality ?? null
        })
        await delay(POLL_INTERVAL_MS, undefined, { signal })
        const task = this.requireTask(taskId)
        remote = normalizeRemoteTask(
          await this.options.pluginManager.callProvider(
            task.providerId,
            'getDownloadStatus',
            [task.providerJobId],
            { signal }
          )
        )
      }
      signal.throwIfAborted()
      await this.receiveFile(taskId, targetRoot, remote, signal)
    } catch (error) {
      if (this.requireTask(taskId).status !== 'cancelled') {
        this.patch(taskId, {
          status: signal.aborted ? 'cancelled' : 'failed',
          error: signal.aborted ? null : errorMessage(error)
        })
      }
    } finally {
      this.abortControllers.delete(taskId)
    }
  }

  private async receiveFile(
    taskId: string,
    targetRoot: string,
    remote: RemoteDownloadTask,
    signal: AbortSignal
  ): Promise<void> {
    const task = this.requireTask(taskId)
    await mkdir(targetRoot, { recursive: true })
    const file = normalizeRemoteFile(
      await this.options.pluginManager.callProvider(
        task.providerId,
        'getDownloadFile',
        [task.providerJobId],
        { signal }
      )
    )
    const preferences = normalizeDownloadPreferences(this.options.getPreferences?.())
    const targetPath = await availableTargetPath(
      targetRoot,
      file.fileName || remote.fileName,
      task.track,
      preferences
    )
    assertWithinRoot(targetRoot, targetPath)
    const partPath = `${targetPath}.${task.id}.part`
    this.patch(taskId, {
      status: 'downloading',
      progress: 0.45,
      queuePosition: null,
      targetPath,
      actualQuality: file.actualQuality ?? remote.actualQuality ?? null,
      fileSize: normalizeOptionalSize(file.fileSize ?? remote.fileSize)
    })
    try {
      const response = await this.fetchImpl(file.url, { signal, redirect: 'error' })
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new Error(`下载文件请求失败 (${response.status})`)
      }
      const declaredSize = parseContentLength(response.headers.get('content-length'))
      const expectedSize = normalizeOptionalSize(file.fileSize ?? remote.fileSize) ?? declaredSize
      if (
        (expectedSize != null && expectedSize > MAX_DOWNLOAD_BYTES) ||
        (declaredSize != null && declaredSize > MAX_DOWNLOAD_BYTES)
      ) {
        await response.body.cancel()
        throw new Error('下载文件超过 4 GiB 限制')
      }
      let received = 0
      // 每 chunk 直接 patch 会让 64KB 分块的下载（100MB ≈ 1600 次）每次都触发
      // 全列表克隆+IPC 广播；节流为 ≤1 次/250ms 或 ≥1% 步进，终态另有即时 patch。
      let lastProgressEmitAt = 0
      let lastProgressEmitValue = 0.45
      const progress = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          received += chunk.length
          if (received > MAX_DOWNLOAD_BYTES) return callback(new Error('下载文件超过 4 GiB 限制'))
          const nextProgress = expectedSize
            ? 0.45 + Math.min(0.54, (received / expectedSize) * 0.54)
            : 0.45
          const nowMs = this.now().getTime()
          if (
            nextProgress > lastProgressEmitValue &&
            (nowMs - lastProgressEmitAt >= PROGRESS_EMIT_INTERVAL_MS ||
              nextProgress - lastProgressEmitValue >= PROGRESS_EMIT_STEP)
          ) {
            lastProgressEmitAt = nowMs
            lastProgressEmitValue = nextProgress
            this.patch(taskId, { progress: nextProgress })
          }
          callback(null, chunk)
        }
      })
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        progress,
        createWriteStream(partPath, { flags: 'wx' }),
        { signal }
      )
      if (expectedSize != null && received !== expectedSize) {
        throw new Error(`下载文件大小不匹配：预期 ${expectedSize} 字节，实际 ${received} 字节`)
      }
      const metadata = await (this.options.prepareMetadata ?? prepareDownloadedMetadata)({
        partPath,
        targetPath,
        track: task.track,
        preferences,
        signal,
        fetchCover: this.options.fetchCover,
        getLyrics: () =>
          this.options.pluginManager.callProvider(task.providerId, 'getLyrics', [task.track], {
            signal
          })
      })
      signal.throwIfAborted()
      await flushFileToDisk(partPath)
      await copyFile(partPath, targetPath, constants.COPYFILE_EXCL)
      await rm(partPath, { force: true })
      const lyricWarning = await saveDownloadedLyrics(targetPath, metadata.lyrics)
      this.patch(taskId, {
        actualQuality: metadata.actualQuality ?? task.actualQuality,
        qualityVerified: metadata.actualQuality !== null,
        warning: [metadata.warning, lyricWarning].filter(Boolean).join('；') || null
      })
      if (await this.isInsideAuthorizedLibrary(targetPath))
        await this.options.indexer?.()?.(targetPath)
      this.patch(taskId, {
        status: 'completed',
        progress: 1,
        fileSize: (await stat(targetPath)).size,
        targetPath,
        error: null
      })
    } catch (error) {
      await rm(partPath, { force: true }).catch(() => undefined)
      await rm(`${partPath}.tags${extname(targetPath)}`, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private requireTask(taskId: string): ProviderDownloadTaskSnapshot {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error('下载任务不存在')
    return task
  }

  /**
   * The configured download directory wins over the music library, but every
   * candidate still has to survive its own authorization check: renderer-persisted
   * paths are never an authority source.
   */
  private async resolveTargetRoot(requested: unknown): Promise<string> {
    const { downloadRoot, libraryRoots } = await this.options.authorizedRoots()
    return selectDownloadTargetRoot(requested, orderDownloadRoots(downloadRoot, libraryRoots))
  }

  private async isInsideAuthorizedLibrary(targetPath: string): Promise<boolean> {
    const { libraryRoots } = await this.options.authorizedRoots()
    return libraryRoots.some((root) => isCanonicalPathInside(root, targetPath))
  }

  private patch(taskId: string, patch: Partial<ProviderDownloadTaskSnapshot>): void {
    const task = this.requireTask(taskId)
    if (patch.status && patch.status !== task.status) this.options.log?.(taskId, task.status, patch)
    Object.assign(task, patch, { updatedAt: this.now().toISOString() })
    if (patch.status && TERMINAL_STATUSES.has(patch.status)) this.pruneTerminalTasks()
    this.emitChanged()
  }

  /** 终态任务（插入序 ≈ 创建序）只保留最近若干条，首张 FIFO 淘汰。 */
  private pruneTerminalTasks(): boolean {
    let removed = false
    let terminalCount = 0
    for (const task of this.tasks.values()) {
      if (TERMINAL_STATUSES.has(task.status)) terminalCount += 1
    }
    for (const [taskId, task] of this.tasks) {
      if (terminalCount <= TERMINAL_TASK_RETENTION) break
      if (!TERMINAL_STATUSES.has(task.status)) continue
      if (this.runs.has(taskId) || this.resultOperations.has(taskId)) continue
      this.tasks.delete(taskId)
      removed = true
      terminalCount -= 1
    }
    return removed
  }

  private emitChanged(): void {
    this.options.onChanged()
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.operations.add(work)
    void work.then(
      () => this.operations.delete(work),
      () => this.operations.delete(work)
    )
    return work
  }

  shutdown(): Promise<void> {
    if (this.shutdownWork) return this.shutdownWork
    this.lifetime.abort(new Error('Core download service is shutting down'))
    // Provider RPC, streams, metadata writes and result imports finish before hosts die.
    this.shutdownWork = (async () => {
      await Promise.allSettled([...this.operations])
      await Promise.all([...this.runs.values()])
    })()
    return this.shutdownWork
  }
}

function normalizeProviderId(value: unknown): string {
  const providerId = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(providerId)) throw new Error('Provider ID 无效')
  return providerId
}

function normalizeTrack(value: unknown): ProviderDownloadCreateInput['track'] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('下载曲目信息无效')
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' || typeof record.id === 'number' ? record.id : ''
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const artist = typeof record.artist === 'string' ? record.artist.trim() : ''
  if (id === '' || !title || !artist) throw new Error('下载曲目缺少 id、标题或艺术家')
  return { ...record, id, title: title.slice(0, 300), artist: artist.slice(0, 300) }
}

function normalizeQuality(value: unknown): ProviderDownloadQuality {
  if (value !== 'aac' && value !== 'lossless' && value !== 'hi-res') throw new Error('下载音质无效')
  return value
}

function normalizeRemoteTask(value: unknown): RemoteDownloadTask {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Provider 下载任务响应无效')
  const record = value as Record<string, unknown>
  const jobId = typeof record.jobId === 'string' ? record.jobId.trim() : ''
  const status = record.status
  if (
    !jobId ||
    !['queued', 'preparing', 'ready', 'failed', 'cancelled', 'expired'].includes(String(status))
  ) {
    throw new Error('Provider 下载任务响应缺少有效 jobId 或状态')
  }
  return {
    jobId,
    status: status as RemoteDownloadTask['status'],
    progress: clampProgress(Number(record.progress)),
    queuePosition: normalizeOptionalInteger(record.queuePosition),
    requestedQuality: normalizeQuality(record.requestedQuality),
    actualQuality: normalizeOptionalQuality(record.actualQuality),
    fileName: typeof record.fileName === 'string' ? record.fileName : null,
    fileSize: normalizeOptionalSize(record.fileSize),
    contentType: typeof record.contentType === 'string' ? record.contentType : null,
    error: typeof record.error === 'string' ? record.error.slice(0, 1000) : null
  }
}

function normalizeRemoteFile(value: unknown): RemoteDownloadFile {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Provider 下载文件响应无效')
  const record = value as Record<string, unknown>
  const url = typeof record.url === 'string' ? record.url.trim() : ''
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
    throw new Error('Provider 下载文件必须通过 127.0.0.1 回环代理交付')
  }
  return {
    url,
    fileName: typeof record.fileName === 'string' ? record.fileName : null,
    fileSize: normalizeOptionalSize(record.fileSize),
    contentType: typeof record.contentType === 'string' ? record.contentType : null,
    actualQuality: normalizeOptionalQuality(record.actualQuality)
  }
}

function normalizeOptionalQuality(value: unknown): ProviderDownloadQuality | null {
  return value === 'aac' || value === 'lossless' || value === 'hi-res' ? value : null
}

function normalizeOptionalInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null
}

function normalizeOptionalSize(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null
}

function clampProgress(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

async function availableTargetPath(
  root: string,
  remoteFileName: string | null | undefined,
  track: ProviderDownloadCreateInput['track'],
  preferences: DownloadPreferences
): Promise<string> {
  const remoteBase = remoteFileName ? basename(remoteFileName) : ''
  const extension = AUDIO_EXTENSIONS.has(extname(remoteBase).toLowerCase())
    ? extname(remoteBase).toLowerCase()
    : '.m4a'
  const configuredName = downloadTrackName(track, preferences.naming)
  const preferred = configuredName
    ? `${sanitizeSegment(configuredName)}${extension}`
    : remoteBase
      ? `${sanitizeSegment(parse(remoteBase).name)}${extension}`
      : `${sanitizeSegment(`${track.artist} - ${track.title}`)}${extension}`
  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index === 0 ? '' : ` (${index})`
    const candidate = join(root, `${parse(preferred).name}${suffix}${extension}`)
    try {
      await access(candidate)
    } catch {
      return candidate
    }
  }
  throw new Error('无法为下载文件分配不冲突的文件名')
}

function sanitizeSegment(value: string): string {
  const sanitized = Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || '<>:"/\\|?*'.includes(character) ? '_' : character
  })
    .join('')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 180)
  return sanitized && sanitized !== '.' && sanitized !== '..' ? sanitized : 'Apple Music Track'
}

function assertWithinRoot(root: string, target: string): void {
  if (!isCanonicalPathInside(root, target)) throw new Error('下载目标路径越界')
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null
  return normalizeOptionalSize(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
