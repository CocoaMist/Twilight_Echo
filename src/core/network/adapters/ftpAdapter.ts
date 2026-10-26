import type { FileInfo } from 'basic-ftp'
import { PassThrough } from 'node:stream'
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

export function createFtpAdapter(options: { verbose?: boolean } = {}): NetworkSourceAdapter {
  return {
    protocol: 'ftp',
    async createSession(
      profile: NetworkSourceProfile,
      auth: NetworkAuth
    ): Promise<NetworkSourceSession> {
      const { Client, FileType } = await import('basic-ftp')
      const client = new Client(profile.options.transferTimeoutMs)
      if (options.verbose) client.ftp.verbose = true
      let connected = false

      async function ensureConnected(): Promise<void> {
        if (connected) return
        const secure = profile.protocol === 'ftps'
        const user =
          auth.kind === 'password'
            ? (auth.username ?? profile.username ?? 'anonymous')
            : 'anonymous'
        const password = auth.kind === 'password' ? auth.password : ''
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
          throw toFailure(err)
        }
      }

      async function operation<T>(
        signal: AbortSignal | undefined,
        action: () => Promise<T>
      ): Promise<T> {
        signal?.throwIfAborted()
        const abort = () => {
          client.close()
          connected = false
        }
        signal?.addEventListener('abort', abort, { once: true })
        try {
          await ensureConnected()
          signal?.throwIfAborted()
          const result = await action()
          signal?.throwIfAborted()
          return result
        } finally {
          signal?.removeEventListener('abort', abort)
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
          return operation(signal, async () => {
            const parent = normalizeRemotePath(remotePath)
            try {
              const infos = await client.list(parent)
              return infos.map((info) => toEntry(info, parent))
            } catch (err) {
              throw toFailure(err)
            }
          })
        },
        async stat(remotePath: string, signal?: AbortSignal): Promise<NetworkEntry | null> {
          return operation(signal, async () => {
            const path = normalizeRemotePath(remotePath)
            try {
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
            } catch (err) {
              throw toFailure(err)
            }
          })
        },
        async readStream(
          remotePath: string,
          signal?: AbortSignal,
          options?: { start?: number }
        ): Promise<NodeJS.ReadableStream> {
          if (signal?.aborted) throw new NetworkSourceFailure('timeout', '网络文件读取已取消')
          const stream = new PassThrough()
          const onAbort = (): void => {
            stream.destroy(new Error('download aborted'))
            client.close()
            connected = false
          }
          signal?.addEventListener('abort', onAbort, { once: true })
          stream.once('close', () => signal?.removeEventListener('abort', onAbort))
          // Let the consumer drain while basic-ftp downloads; waiting here deadlocks
          // once PassThrough reaches its high-water mark.
          void operation(signal, async () => {
            await client.downloadTo(stream, normalizeRemotePath(remotePath), options?.start ?? 0)
          }).catch((error) => stream.destroy(toFailure(error)))
          return stream
        },
        async resolvePlaybackUrl(): Promise<string | null> {
          // FTP/FTPS 无 URL 播放能力，一律走缓存下载。
          return null
        },
        async close(): Promise<void> {
          client.close()
          connected = false
        }
      }
    }
  }
}
