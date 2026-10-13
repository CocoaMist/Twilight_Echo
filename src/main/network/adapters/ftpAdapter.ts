import type { FileInfo } from 'basic-ftp'
import { PassThrough, Writable } from 'node:stream'
import { buildNetworkEntryId, normalizeRemotePath } from '../networkPath.ts'
import { NetworkSourceFailure } from '../errors.ts'
import { entryKind } from '../entryKinds.ts'
import type { NetworkEntry, NetworkSourceProfile } from '../../../shared/networkSources.ts'
import type { NetworkAuth, NetworkSourceAdapter, NetworkSourceSession } from './types.ts'

function toFailure(err: unknown): NetworkSourceFailure {
  if (err instanceof NetworkSourceFailure) return err
  const code = String((err as { code?: unknown })?.code ?? '')
  if (code === '530' || code === '535') {
    return new NetworkSourceFailure('auth', 'FTP 认证失败，请检查用户名或密码')
  }
  if (code === '550') return new NetworkSourceFailure('notFound', '远程路径不存在')
  if (code === 'ETIMEDOUT' || code === 'ENETUNREACH') {
    return new NetworkSourceFailure('timeout', 'FTP 连接超时')
  }
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    return new NetworkSourceFailure('network', '无法连接 FTP 服务器')
  }
  return new NetworkSourceFailure('network', `FTP 请求失败：${(err as Error).message}`)
}

export function createFtpAdapter(): NetworkSourceAdapter {
  return {
    protocol: 'ftp',
    async createSession(
      profile: NetworkSourceProfile,
      auth: NetworkAuth
    ): Promise<NetworkSourceSession> {
      const { Client, FileType } = await import('basic-ftp')
      const client = new Client(profile.options.transferTimeoutMs)
      if (process.env.NETWORK_FTP_DEBUG === '1') client.ftp.verbose = true
      let connected = false
      let closed = false
      let operations: Promise<unknown> = Promise.resolve()
      const streams = new Set<PassThrough>()

      // basic-ftp allows one command at a time. Keep its ownership until the
      // producer settles, while exposing the readable before it fills up.
      function schedule<T>(operation: () => Promise<T>): Promise<T> {
        const result = operations.catch(() => undefined).then(operation)
        operations = result
        return result
      }

      async function ensureConnected(signal?: AbortSignal): Promise<void> {
        if (closed || signal?.aborted) {
          throw new NetworkSourceFailure('timeout', '网络操作已取消')
        }
        if (connected) return
        const secure = profile.protocol === 'ftps'
        const user =
          auth.kind === 'password'
            ? (auth.username ?? profile.username ?? 'anonymous')
            : 'anonymous'
        const password = auth.kind === 'password' ? auth.password : ''
        let timedOut = false
        const cancel = (): void => client.close()
        const timer = setTimeout(() => {
          timedOut = true
          cancel()
        }, profile.options.connectTimeoutMs)
        signal?.addEventListener('abort', cancel, { once: true })
        try {
          await client.access({
            host: profile.host,
            port: profile.port ?? 21,
            user,
            password,
            secure
          })
          connected = true
        } catch (err) {
          if (signal?.aborted || closed) throw new NetworkSourceFailure('timeout', '网络操作已取消')
          if (timedOut) throw new NetworkSourceFailure('timeout', 'FTP 连接超时')
          throw toFailure(err)
        } finally {
          clearTimeout(timer)
          signal?.removeEventListener('abort', cancel)
        }
      }

      async function command<T>(
        signal: AbortSignal | undefined,
        operation: () => Promise<T>
      ): Promise<T> {
        await ensureConnected(signal)
        const cancel = (): void => {
          connected = false
          client.close()
        }
        signal?.addEventListener('abort', cancel, { once: true })
        try {
          if (signal?.aborted) throw new NetworkSourceFailure('timeout', '网络操作已取消')
          return await operation()
        } catch (err) {
          connected = false
          if (signal?.aborted || closed) throw new NetworkSourceFailure('timeout', '网络操作已取消')
          throw toFailure(err)
        } finally {
          signal?.removeEventListener('abort', cancel)
        }
      }

      function toEntry(info: FileInfo, parentPath: string): NetworkEntry {
        const name = info.name
        const path = parentPath === '/' ? `/${name}` : `${normalizeRemotePath(parentPath)}/${name}`
        const normalized = normalizeRemotePath(path)
        const directory = info.type === FileType.Directory
        return {
          id: buildNetworkEntryId(profile.protocol, profile.id, normalized),
          profileId: profile.id,
          name,
          kind: entryKind(name, { directory }),
          path: normalized,
          sizeBytes: directory ? undefined : info.size,
          mtimeMs: info.modifiedAt ? info.modifiedAt.getTime() : undefined
        }
      }

      return {
        protocol: profile.protocol,
        async list(remotePath: string, signal?: AbortSignal): Promise<NetworkEntry[]> {
          const parent = normalizeRemotePath(remotePath)
          return schedule(() =>
            command(signal, async () => {
              const infos = await client.list(parent)
              return infos.map((info) => toEntry(info, parent))
            })
          )
        },
        async stat(remotePath: string, signal?: AbortSignal): Promise<NetworkEntry | null> {
          const path = normalizeRemotePath(remotePath)
          return schedule(() =>
            command(signal, async () => {
              const size = await client.size(path)
              let mtimeMs: number | undefined
              try {
                mtimeMs = (await client.lastMod(path)).getTime()
              } catch {
                mtimeMs = undefined
              }
              const name = path.split('/').pop() ?? path
              return {
                id: buildNetworkEntryId(profile.protocol, profile.id, path),
                profileId: profile.id,
                name,
                kind: entryKind(name, {}),
                path,
                sizeBytes: size,
                mtimeMs
              }
            })
          )
        },
        async readStream(
          remotePath: string,
          signal?: AbortSignal,
          options?: { start?: number }
        ): Promise<NodeJS.ReadableStream> {
          if (signal?.aborted || closed)
            throw new NetworkSourceFailure('timeout', '网络文件读取已取消')
          const stream = new PassThrough()
          streams.add(stream)
          // A connection can fail before the caller attaches its pipeline.
          // Async iteration still receives the stored stream error.
          stream.on('error', () => undefined)
          let settled = false
          let active = false
          const onAbort = (): void => {
            stream.destroy(new NetworkSourceFailure('timeout', '网络文件读取已取消'))
            if (active) {
              client.close()
              connected = false
            }
          }
          const onClose = (): void => {
            streams.delete(stream)
            if (!settled && !stream.readableEnded) onAbort()
          }
          stream.once('close', onClose)
          signal?.addEventListener('abort', onAbort, { once: true })
          void schedule(async () => {
            try {
              if (stream.destroyed) return
              active = true
              await ensureConnected(signal)
              const destination = new Writable({
                write(chunk, encoding, callback) {
                  stream.write(chunk, encoding, callback)
                }
              })
              // The data socket can finish before the final FTP status. A
              // separate sink keeps EOF private until that status succeeds.
              await client.downloadTo(
                destination,
                normalizeRemotePath(remotePath),
                options?.start ?? 0
              )
              stream.end()
            } catch (err) {
              connected = false
              stream.destroy(
                signal?.aborted || closed
                  ? new NetworkSourceFailure('timeout', '网络文件读取已取消')
                  : toFailure(err)
              )
            } finally {
              active = false
              settled = true
              signal?.removeEventListener('abort', onAbort)
              streams.delete(stream)
            }
          })
          return stream
        },
        async resolvePlaybackUrl(): Promise<string | null> {
          // FTP/FTPS 无 URL 播放能力，一律走缓存下载。
          return null
        },
        async close(): Promise<void> {
          closed = true
          for (const stream of streams) {
            stream.destroy(new NetworkSourceFailure('timeout', '网络会话已关闭'))
          }
          client.close()
          connected = false
          await operations.catch(() => undefined)
        }
      }
    }
  }
}
