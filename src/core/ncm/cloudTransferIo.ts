import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access } from 'node:fs/promises'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { extname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { normalizeTransferUrl } from './cloudTransferHelpers.ts'
import type { NcmCloudTransferProgress } from '../../shared/ncmCloud.ts'

export interface SelectedFileGrant {
  handle: string
  ownerId: string
  path: string
  name: string
  size: number
  format: string | null
  expiresAt: number
}
export interface CloudUploadPreparation {
  needUpload: boolean
  songId: string | number
  uploadToken: string
  uploadUrl: string
  resourceId: string
  md5: string
  fileSize: number
  filename: string
}
const MAX_NOS_ERROR_RESPONSE_BYTES = 8 * 1024

export async function hashFile(
  grant: SelectedFileGrant,
  signal: AbortSignal,
  onProgress: (bytes: number) => void
): Promise<string> {
  const hash = createHash('md5')
  let bytes = 0
  for await (const chunk of createReadStream(grant.path, { signal })) {
    hash.update(chunk)
    bytes += chunk.length
    onProgress(bytes)
  }
  return hash.digest('hex')
}

export async function readAudioMetadata(
  path: string,
  fileName: string
): Promise<{
  title: string
  artist: string
  album: string
  bitrate?: number
}> {
  const fallbackTitle = fileName.replace(/\.[^.]+$/, '')
  try {
    const { parseFile } = await import('music-metadata')
    const metadata = await parseFile(path, { duration: false, skipCovers: true })
    const bitrate = Math.round(Number(metadata.format.bitrate))
    return {
      title: metadata.common.title?.trim() || fallbackTitle,
      artist: metadata.common.artist?.trim() || '未知艺术家',
      album: metadata.common.album?.trim() || '未知专辑',
      ...(Number.isFinite(bitrate) && bitrate > 0 ? { bitrate } : {})
    }
  } catch {
    return { title: fallbackTitle, artist: '未知艺术家', album: '未知专辑' }
  }
}

export async function uploadToNos(
  emitProgress: (update: NcmCloudTransferProgress) => void,
  transferId: string,
  grant: SelectedFileGrant,
  preparation: CloudUploadPreparation,
  signal: AbortSignal,
  handle: string
): Promise<void> {
  const target = normalizeTransferUrl(preparation.uploadUrl, '网易云上传地址')
  const requestImpl = target.protocol === 'https:' ? httpsRequest : httpRequest
  let request!: ClientRequest
  const response = new Promise<void>((resolve, reject) => {
    request = requestImpl(
      target,
      {
        method: 'POST',
        headers: {
          'x-nos-token': preparation.uploadToken,
          'Content-MD5': preparation.md5,
          'Content-Type': mimeTypeForFile(grant.name),
          'Content-Length': String(grant.size)
        },
        signal
      },
      (response) => {
        const chunks: Buffer[] = []
        let capturedBytes = 0
        response.once('error', reject)
        response.on('data', (chunk: Buffer) => {
          if ((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300) return
          const remaining = MAX_NOS_ERROR_RESPONSE_BYTES - capturedBytes
          if (remaining <= 0) return
          const captured = chunk.subarray(0, remaining)
          chunks.push(captured)
          capturedBytes += captured.length
        })
        response.once('end', () => {
          const status = response.statusCode ?? 0
          if (status >= 200 && status < 300) resolve()
          else
            reject(
              new Error(
                `网易云存储上传失败：HTTP ${status} ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`
              )
            )
        })
      }
    )
    request.once('error', reject)
  })
  const stream = createReadStream(grant.path, { signal })
  let bytes = 0
  stream.on('data', (chunk: string | Buffer) => {
    bytes += Buffer.byteLength(chunk)
    emitProgress({
      ...progress(transferId, 'upload', 'uploading', grant.name, bytes, grant.size),
      handle
    })
  })
  const sending = pipeline(stream, request, { signal })
  try {
    await Promise.all([sending, response])
  } catch (error) {
    stream.destroy()
    request.destroy()
    await sending.catch(() => undefined)
    throw error
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function mimeTypeForFile(fileName: string): string {
  const extension = extname(fileName).toLowerCase()
  const known: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.mp4': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.aac': 'audio/aac',
    '.aiff': 'audio/aiff',
    '.aif': 'audio/aiff'
  }
  return known[extension] ?? 'application/octet-stream'
}

export function progress(
  transferId: string,
  kind: 'upload' | 'download',
  stage: 'hashing' | 'uploading',
  fileName: string,
  bytes: number,
  total: number
): NcmCloudTransferProgress {
  const percent = Math.min(100, Math.round((bytes / total) * 100))
  return {
    transferId,
    kind,
    stage,
    fileName,
    bytesTransferred: bytes,
    bytesTotal: total,
    percent,
    message: stage === 'hashing' ? `正在计算 MD5 ${percent}%` : `正在上传 ${percent}%`
  }
}
