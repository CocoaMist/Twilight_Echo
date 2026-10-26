import { createHash } from 'node:crypto'
import type {
  NetworkSourceProfile,
  NetworkSourceProfileSummary
} from '../../shared/networkSources.ts'
import { hasControlCharacters } from './textValidation.ts'

const MAX_REMOTE_PATH_LENGTH = 4096

/**
 * 归一化远程路径：
 * - 统一以 `/` 为分隔符、以 `/` 开头、末尾无 `/`（根目录为 `/`）；
 * - 折叠空段与 `.` 段；
 * - 拒绝 `..` 穿越、控制字符与超长路径（见施工文档 §8）。
 */
export function normalizeRemotePath(input: string): string {
  if (typeof input !== 'string') throw new Error('remote path must be a string')
  const raw = input.trim()
  if (raw.length > MAX_REMOTE_PATH_LENGTH) throw new Error('remote path is too long')
  if (hasControlCharacters(raw)) throw new Error('remote path contains control characters')

  const segments: string[] = []
  for (const segment of raw.split('/')) {
    if (segment === '..') throw new Error('remote path traversal is not allowed')
    if (segment === '' || segment === '.') continue
    segments.push(segment)
  }
  return segments.length === 0 ? '/' : `/${segments.join('/')}`
}

/** 稳定条目 id：协议 + profile + 规范化路径的 sha256，用于缓存键与虚拟媒体库身份。 */
export function buildNetworkEntryId(
  protocol: NetworkSourceProfile['protocol'],
  profileId: string,
  remotePath: string
): string {
  return createHash('sha256')
    .update(`${protocol}\u0000${profileId}\u0000${normalizeRemotePath(remotePath)}`)
    .digest('hex')
}

/** 渲染层可见摘要：剔除凭据密文与口令域。 */
export function redactProfile(profile: NetworkSourceProfile): NetworkSourceProfileSummary {
  return {
    id: profile.id,
    protocol: profile.protocol,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    rootPath: profile.rootPath,
    webdavScheme: profile.webdavScheme,
    username: profile.username,
    credentialKind: profile.credential.kind,
    options: { ...profile.options },
    bookmarks: [...profile.bookmarks],
    createdAt: profile.createdAt,
    lastConnectedAt: profile.lastConnectedAt
  }
}
