import { createWriteStream } from 'node:fs'
import { rename, rm, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  assertOwnedGrant,
  cancelOwnedTransfer,
  commitDownloadedFile,
  fetchCloudDownloadResponse,
  reserveExclusiveResource,
  sanitizeDownloadFileName,
  temporaryDownloadPath
} from './cloudTransferHelpers.ts'
import {
  hashFile,
  pathExists,
  progress,
  readAudioMetadata,
  uploadToNos,
  type CloudUploadPreparation,
  type SelectedFileGrant
} from './cloudTransferIo.ts'
import {
  NCM_CLOUD_UPLOAD_EXTENSIONS,
  type CoreCloudTransferPage,
  type CoreCloudTransferProviderMethod,
  type CoreCloudTransferQuery,
  type CoreCloudTransferState
} from '../../shared/coreCloudTransfer.ts'
import type {
  NcmCloudDownloadRequest,
  NcmCloudDownloadResult,
  NcmCloudSelectedFile,
  NcmCloudTransferProgress,
  NcmCloudUploadResult
} from '../../shared/ncmCloud.ts'
import { projectCoreError } from '../projections.ts'

const HANDLE_TTL_MS = 30 * 60_000
const MAX_SELECTED_FILES = 20
const MAX_COMPLETED_TRANSFERS = 200
const terminal = (stage: NcmCloudTransferProgress['stage']): boolean =>
  stage === 'completed' || stage === 'cancelled' || stage === 'failed'

export interface CoreNcmCloudTransferOptions {
  chooseUploadFiles(clientId: string, signal?: AbortSignal): Promise<string[]>
  chooseDownloadFile(
    clientId: string,
    fileName: string,
    signal?: AbortSignal
  ): Promise<string | null>
  callProvider<T>(
    method: CoreCloudTransferProviderMethod,
    args: unknown[],
    signal?: AbortSignal,
    idempotencyKey?: string
  ): Promise<T>
  now(): number
  newId(): string
  changed(): void
  /** Compatibility IPC subscriber. New clients read the revisioned Core projection. */
  progress?(clientId: string, update: NcmCloudTransferProgress): void
  fetch?: typeof fetch
}

interface Transfer {
  ownerId: string
  controller: AbortController
  work: Promise<void>
}

/** Selected-file grants belong to a client; accepted transfer work belongs to Core. */
export class CoreNcmCloudTransferService {
  private readonly options: CoreNcmCloudTransferOptions
  private readonly selectedFiles = new Map<string, SelectedFileGrant>()
  private readonly activeTransfers = new Map<string, Transfer>()
  private readonly activeUploadPaths = new Set<string>()
  private readonly activeDownloadSongs = new Set<string>()
  private readonly transfers = new Map<string, NcmCloudTransferProgress>()
  private revision = 0
  private stopped = false
  private account: number | null | undefined

  constructor(options: CoreNcmCloudTransferOptions) {
    this.options = options
  }

  state(): CoreCloudTransferState {
    return {
      revision: this.revision,
      active: [...this.transfers.values()].filter((task) => !terminal(task.stage)).length,
      total: this.transfers.size
    }
  }

  page(query: CoreCloudTransferQuery): CoreCloudTransferPage {
    if (query.revision !== this.revision)
      throw Object.assign(new Error('Cloud transfer tasks changed; read a new page'), {
        code: 'STALE_REVISION'
      })
    const offset = query.offset ?? 0
    return {
      ...this.state(),
      offset,
      items: [...this.transfers.values()]
        .slice(offset, offset + (query.limit ?? 50))
        .map((task) => ({ ...task }))
    }
  }

  async chooseUploadFiles(clientId: string, signal?: AbortSignal): Promise<NcmCloudSelectedFile[]> {
    this.running()
    signal?.throwIfAborted()
    this.pruneExpiredHandles()
    const paths = await this.options.chooseUploadFiles(clientId, signal)
    this.running()
    signal?.throwIfAborted()
    if (paths.length > MAX_SELECTED_FILES)
      throw new Error(`一次最多选择 ${MAX_SELECTED_FILES} 个音频文件`)
    const grants: SelectedFileGrant[] = []
    for (const path of paths) {
      const format = extname(path).toLowerCase().slice(1)
      if (!(NCM_CLOUD_UPLOAD_EXTENSIONS as readonly string[]).includes(format)) continue
      const info = await stat(path)
      if (!info.isFile() || info.size <= 0) continue
      grants.push({
        handle: this.options.newId(),
        ownerId: clientId,
        path,
        name: basename(path),
        size: info.size,
        format,
        expiresAt: this.options.now() + HANDLE_TTL_MS
      })
    }
    this.running()
    signal?.throwIfAborted()
    for (const grant of grants) this.selectedFiles.set(grant.handle, grant)
    return grants.map(({ handle, name, size, format }) => ({ handle, name, size, format }))
  }

  upload(clientId: string, handle: string): NcmCloudUploadResult {
    this.running()
    this.pruneExpiredHandles()
    const grant = this.selectedFiles.get(handle)
    assertOwnedGrant(grant, clientId, this.options.now())
    const selected = grant!
    const release = reserveExclusiveResource(
      this.activeUploadPaths,
      selected.path,
      '该文件已有上传任务正在运行'
    )
    const transferId = this.options.newId()
    this.start(
      clientId,
      transferId,
      {
        transferId,
        kind: 'upload',
        stage: 'queued',
        handle,
        fileName: selected.name,
        bytesTransferred: 0,
        bytesTotal: selected.size,
        percent: 0,
        message: '上传任务已创建'
      },
      async (signal, emit) => {
        try {
          emit({
            ...progress(transferId, 'upload', 'hashing', selected.name, 0, selected.size),
            handle
          })
          const md5 = await hashFile(selected, signal, (bytes) =>
            emit({
              ...progress(transferId, 'upload', 'hashing', selected.name, bytes, selected.size),
              handle
            })
          )
          const metadataProgress = {
            transferId,
            kind: 'upload' as const,
            handle,
            fileName: selected.name,
            bytesTransferred: 0,
            bytesTotal: null,
            percent: null
          }
          emit({ ...metadataProgress, stage: 'metadata', message: '正在读取音频元数据' })
          const metadata = await readAudioMetadata(selected.path, selected.name)
          signal.throwIfAborted()
          emit({ ...metadataProgress, stage: 'authorizing', message: '正在获取上传凭证' })
          const preparation = await this.options.callProvider<CloudUploadPreparation>(
            'prepareCloudUpload',
            [
              {
                md5,
                fileSize: selected.size,
                filename: selected.name,
                ...(metadata.bitrate ? { bitrate: metadata.bitrate } : {})
              }
            ],
            signal
          )
          signal.throwIfAborted()
          if (preparation.needUpload)
            await uploadToNos(emit, transferId, selected, preparation, signal, handle)
          signal.throwIfAborted()
          const done = {
            transferId,
            kind: 'upload' as const,
            handle,
            fileName: selected.name,
            bytesTransferred: selected.size,
            bytesTotal: selected.size,
            percent: 100
          }
          emit({
            ...done,
            stage: 'importing',
            message: preparation.needUpload ? '上传完成，正在导入云盘' : '文件已存在，正在导入云盘'
          })
          // An uncertain completion is reported, never automatically replayed.
          await this.options.callProvider(
            'completeCloudUpload',
            [
              {
                songId: preparation.songId,
                resourceId: preparation.resourceId,
                md5,
                filename: selected.name,
                song: metadata.title,
                artist: metadata.artist,
                album: metadata.album,
                ...(metadata.bitrate ? { bitrate: metadata.bitrate } : {})
              }
            ],
            signal,
            transferId
          )
          emit({ ...done, stage: 'completed', message: '已上传到网易云云盘' })
          this.selectedFiles.delete(handle)
        } finally {
          release()
        }
      }
    )
    return { transferId, handle, fileName: selected.name, accepted: true }
  }

  async download(
    clientId: string,
    request: NcmCloudDownloadRequest,
    signal?: AbortSignal
  ): Promise<NcmCloudDownloadResult> {
    this.running()
    signal?.throwIfAborted()
    const release = reserveExclusiveResource(
      this.activeDownloadSongs,
      String(request.cloudSongId),
      '该歌曲已有下载任务正在运行'
    )
    let handedOff = false
    const fileName = sanitizeDownloadFileName(request.fileName)
    try {
      const targetPath = await this.options.chooseDownloadFile(clientId, fileName, signal)
      this.running()
      signal?.throwIfAborted()
      if (!targetPath) return { transferId: '', fileName, accepted: false, cancelled: true }
      const transferId = this.options.newId()
      this.start(
        clientId,
        transferId,
        {
          transferId,
          kind: 'download',
          stage: 'queued',
          cloudSongId: request.cloudSongId,
          fileName,
          bytesTransferred: 0,
          bytesTotal: null,
          percent: null,
          message: '下载任务已创建'
        },
        async (signal, emit) => {
          const temporaryPath = temporaryDownloadPath(targetPath, transferId)
          const backupPath = `${temporaryPath}.backup`
          try {
            const url = await this.options.callProvider<string>(
              'getCloudDownloadUrl',
              [request.cloudSongId],
              signal
            )
            signal.throwIfAborted()
            const response = await fetchCloudDownloadResponse(url, signal, this.options.fetch)
            if (!response.ok || !response.body) {
              await response.body?.cancel().catch(() => undefined)
              throw new Error(`下载服务器返回 HTTP ${response.status}`)
            }
            const length = Number(response.headers.get('content-length'))
            const total = Number.isFinite(length) && length > 0 ? length : null
            let bytes = 0
            const identity = {
              transferId,
              kind: 'download' as const,
              cloudSongId: request.cloudSongId,
              fileName
            }
            const transform = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                bytes += chunk.length
                const percent = total ? Math.min(100, Math.round((bytes / total) * 100)) : null
                emit({
                  ...identity,
                  stage: 'downloading',
                  bytesTransferred: bytes,
                  bytesTotal: total,
                  percent,
                  message: total ? `正在下载 ${percent}%` : '正在下载'
                })
                callback(null, chunk)
              }
            })
            await pipeline(
              Readable.fromWeb(response.body as never),
              transform,
              createWriteStream(temporaryPath),
              { signal }
            )
            signal.throwIfAborted()
            await commitDownloadedFile(temporaryPath, targetPath, backupPath, {
              exists: pathExists,
              rename,
              remove: async (path) => rm(path, { force: true })
            })
            emit({
              ...identity,
              stage: 'completed',
              bytesTransferred: bytes,
              bytesTotal: total,
              percent: 100,
              message: '下载完成'
            })
          } catch (error) {
            await rm(temporaryPath, { force: true }).catch(() => undefined)
            if ((await pathExists(backupPath)) && !(await pathExists(targetPath)))
              await rename(backupPath, targetPath).catch(() => undefined)
            throw error
          } finally {
            release()
          }
        }
      )
      handedOff = true
      return { transferId, fileName, accepted: true, cancelled: false }
    } finally {
      if (!handedOff) release()
    }
  }

  cancel(transferId: string, clientId?: string): boolean {
    const transfer = this.activeTransfers.get(transferId)
    return cancelOwnedTransfer(
      transfer,
      clientId ?? transfer?.ownerId ?? '',
      new Error('用户已取消传输')
    )
  }

  async observeAccount(account: number | null): Promise<void> {
    const previous = this.account
    this.account = account
    if (previous === undefined || previous === account) return
    this.selectedFiles.clear()
    const transfers = [...this.activeTransfers.values()]
    for (const transfer of transfers) transfer.controller.abort(new Error('网易云账号已变化'))
    await Promise.all(transfers.map((transfer) => transfer.work))
  }

  disconnect(clientId: string): void {
    for (const [handle, grant] of this.selectedFiles)
      if (grant.ownerId === clientId) this.selectedFiles.delete(handle)
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    this.selectedFiles.clear()
    for (const transfer of this.activeTransfers.values())
      transfer.controller.abort(new Error('Core 正在退出'))
    await Promise.all([...this.activeTransfers.values()].map((transfer) => transfer.work))
  }

  private start(
    clientId: string,
    transferId: string,
    initial: NcmCloudTransferProgress,
    run: (signal: AbortSignal, emit: (update: NcmCloudTransferProgress) => void) => Promise<void>
  ): void {
    const controller = new AbortController()
    const emit = (update: NcmCloudTransferProgress) => this.emit(clientId, update)
    const work = Promise.resolve()
      .then(() => run(controller.signal, emit))
      .catch((error) => {
        const message = projectCoreError(
          error instanceof Error ? error.message : String(error)
        ).replace(/(?:[a-z]:[\\/]|\\\\)[^\r\n"']+|(?:\/(?:[^\s/'"]+\/)+)[^\s'"\n]*/gi, '<file>')
        emit({
          ...initial,
          stage: controller.signal.aborted ? 'cancelled' : 'failed',
          bytesTransferred: 0,
          bytesTotal: null,
          percent: null,
          message: controller.signal.aborted ? '传输已取消' : '传输失败',
          error: message
        })
      })
      .finally(() => {
        this.activeTransfers.delete(transferId)
      })
    this.activeTransfers.set(transferId, { ownerId: clientId, controller, work })
    emit(initial)
  }

  private emit(clientId: string, update: NcmCloudTransferProgress): void {
    this.transfers.set(update.transferId, update)
    if (terminal(update.stage)) {
      const completed = [...this.transfers.values()].filter((task) => terminal(task.stage))
      for (const task of completed.slice(
        0,
        Math.max(0, completed.length - MAX_COMPLETED_TRANSFERS)
      ))
        this.transfers.delete(task.transferId)
    }
    this.revision++
    this.options.changed()
    this.options.progress?.(clientId, { ...update })
  }

  private pruneExpiredHandles(): void {
    const now = this.options.now()
    for (const [handle, grant] of this.selectedFiles)
      if (grant.expiresAt <= now && !this.activeUploadPaths.has(grant.path))
        this.selectedFiles.delete(handle)
  }

  private running(): void {
    if (this.stopped) throw new Error('Core cloud transfers are shutting down')
  }
}
