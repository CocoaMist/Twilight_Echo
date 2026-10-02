import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { AppUpdateProgress } from '../../shared/appUpdate.ts'
import { AppUpdateRepository } from './appUpdateRepository.ts'
import {
  assertUpdateResponse,
  UpdateError,
  updateError,
  UPDATE_HEADERS,
  type UpdateAsset
} from './appUpdateRelease.ts'

export async function hashUpdateFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
  signal?.throwIfAborted()
  return hash.digest('hex')
}

export async function downloadVerifiedUpdate(
  asset: UpdateAsset,
  repository: AppUpdateRepository,
  fetcher: typeof fetch,
  signal: AbortSignal,
  progress: (value: AppUpdateProgress) => void,
  options: { timeoutMs?: number; retryDelayMs?: number } = {}
): Promise<string> {
  const target = repository.installer(asset),
    partial = repository.partial(asset)
  const common = { assetName: asset.name, version: asset.version, totalBytes: asset.size }
  const verifying = (): void =>
    progress({
      ...common,
      phase: 'verifying',
      percent: 100,
      receivedBytes: asset.size,
      message: '正在校验安装包…'
    })
  await mkdir(repository.directory, { recursive: true })
  signal.throwIfAborted()
  if ((await repository.size(target)) === asset.size) {
    verifying()
    if ((await hashUpdateFile(target, signal)) === asset.sha256) return target
  }
  await rm(target, { force: true })

  for (let attempt = 1; attempt <= 3; attempt++) {
    signal.throwIfAborted()
    let offset = await repository.size(partial)
    if (offset > asset.size) {
      await rm(partial, { force: true })
      offset = 0
    }
    if (offset < asset.size) {
      const timeout = new AbortController()
      const combined = AbortSignal.any([signal, timeout.signal])
      let timer: ReturnType<typeof setTimeout>
      const touch = (): void => {
        clearTimeout(timer)
        timer = setTimeout(
          () => timeout.abort(new UpdateError('timeout', '下载长时间没有进度，请重试', true)),
          options.timeoutMs ?? 30_000
        )
      }
      touch()
      try {
        const response = await fetcher(asset.url, {
          headers: {
            ...UPDATE_HEADERS,
            Accept: 'application/octet-stream',
            'Accept-Encoding': 'identity',
            ...(offset ? { Range: `bytes=${offset}-` } : {})
          },
          signal: combined,
          redirect: 'follow'
        })
        try {
          if (response.status === 416) {
            await rm(partial, { force: true })
            throw new UpdateError('http', '下载缓存已失效，正在重新下载', true)
          }
          assertUpdateResponse(response)
          if (!response.body) throw new UpdateError('network', '下载服务返回空内容', true)
          if (response.status === 206) {
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
              response.headers.get('content-range') ?? ''
            )
            if (
              !range ||
              Number(range[1]) !== offset ||
              Number(range[3]) !== asset.size ||
              Number(range[2]) < offset ||
              Number(range[2]) >= asset.size
            ) {
              await rm(partial, { force: true })
              throw new UpdateError('invalid-release', '服务器返回的续传范围不正确，请重新下载')
            }
          } else if (response.status === 200) offset = 0
          else throw new UpdateError('http', `下载服务返回意外状态 HTTP ${response.status}`)

          let receivedBytes = offset,
            lastEmit = 0
          const started = Date.now(),
            startedBytes = offset
          progress({
            ...common,
            phase: 'downloading',
            receivedBytes,
            percent: Math.floor((receivedBytes / asset.size) * 100),
            attempt,
            message: offset ? '正在继续下载…' : '正在下载更新包…'
          })
          const meter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              touch()
              receivedBytes += chunk.length
              if (receivedBytes > asset.size) {
                callback(new UpdateError('invalid-release', '安装包大小超过发布记录'))
                return
              }
              const now = Date.now()
              if (now - lastEmit >= 250) {
                lastEmit = now
                const bytesPerSecond = Math.round(
                  (receivedBytes - startedBytes) / Math.max(0.1, (now - started) / 1000)
                )
                progress({
                  ...common,
                  phase: 'downloading',
                  receivedBytes,
                  percent: Math.min(99, Math.floor((receivedBytes / asset.size) * 100)),
                  bytesPerSecond,
                  remainingSeconds:
                    bytesPerSecond > 0
                      ? Math.ceil((asset.size - receivedBytes) / bytesPerSecond)
                      : undefined,
                  attempt
                })
              }
              callback(null, chunk)
            }
          })
          await pipeline(
            Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
            meter,
            createWriteStream(partial, { flags: offset ? 'a' : 'w' }),
            { signal: combined }
          )
          if (receivedBytes !== asset.size)
            throw new UpdateError('network', '下载连接提前结束，将继续下载', true)
        } finally {
          if (!response.body?.locked) await response.body?.cancel().catch(() => {})
        }
      } catch (error) {
        signal.throwIfAborted()
        const failure = updateError(timeout.signal.aborted ? timeout.signal.reason : error)
        if (failure.code === 'invalid-release') await rm(partial, { force: true })
        if (!failure.retryable || attempt === 3) throw failure
        progress({
          ...common,
          phase: 'retrying',
          receivedBytes: await repository.size(partial),
          percent: 0,
          attempt,
          message: `${failure.message}（${attempt}/3）`
        })
        clearTimeout(timer!)
        await delay((options.retryDelayMs ?? 1000) * attempt, undefined, { signal })
        continue
      } finally {
        clearTimeout(timer!)
      }
    }
    signal.throwIfAborted()
    verifying()
    const hash = await hashUpdateFile(partial, signal)
    if (hash !== asset.sha256) {
      await rm(partial, { force: true })
      throw new UpdateError(
        'checksum',
        '安装包校验失败（SHA-256 不匹配），已删除下载文件，请重新下载'
      )
    }
    signal.throwIfAborted()
    await rename(partial, target)
    return target
  }
  throw new UpdateError('network', '下载失败，请重试', true)
}
