import type {
  AppUpdateChannel,
  AppUpdateCheckResult,
  AppUpdateErrorCode
} from '../../shared/appUpdate.ts'
import {
  GITHUB_API_LATEST_RELEASE_URL,
  GITHUB_API_RELEASES_URL,
  RELEASES_URL
} from '../../shared/projectUrls.ts'
import {
  compareAppVersions,
  extractAssetDigestSha256,
  extractChecksumFromBody,
  parseAppVersion,
  pickLatestAvailableRelease,
  pickWindowsAsset,
  type GithubAssetLike,
  type GithubReleaseLike
} from './appUpdateHelpers.ts'

export interface UpdateAsset {
  version: string
  name: string
  size: number
  url: string
  sha256: string
}
export class UpdateError extends Error {
  readonly code: AppUpdateErrorCode
  readonly retryable: boolean
  constructor(code: AppUpdateErrorCode, message: string, retryable = false) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}
export function updateError(error: unknown): UpdateError {
  if (error instanceof UpdateError) return error
  const value = error as { name?: string; code?: string; message?: string }
  if (value?.name === 'TimeoutError')
    return new UpdateError('timeout', '连接超时或下载长时间没有进度，请重试', true)
  if (['ENOSPC', 'EACCES', 'EPERM', 'EIO', 'EROFS'].includes(value?.code ?? '')) {
    return new UpdateError('disk', '无法写入更新缓存，请检查磁盘空间和目录权限')
  }
  return new UpdateError('network', '网络连接失败，请检查网络或代理后重试', true)
}
export function assertUpdateResponse(response: Response): void {
  if (response.ok) return
  if (
    response.status === 429 ||
    (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
  ) {
    throw new UpdateError('rate-limit', '更新服务请求过于频繁，请稍后重试')
  }
  throw new UpdateError(
    'http',
    `更新服务返回 HTTP ${response.status}`,
    response.status >= 500 || response.status === 408
  )
}
export const UPDATE_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'TwilightEcho-Updater'
}

type Release = GithubReleaseLike & {
  html_url?: string
  body?: string
  published_at?: string
  assets?: GithubAssetLike[]
}

export function isUpdateAsset(value: unknown): value is UpdateAsset {
  if (!value || typeof value !== 'object') return false
  const a = value as UpdateAsset
  return (
    !!parseAppVersion(a.version) &&
    typeof a.name === 'string' &&
    /^[\w.() -]+\.exe$/i.test(a.name) &&
    a.name.length < 200 &&
    Number.isSafeInteger(a.size) &&
    a.size > 0 &&
    a.size <= 2 * 1024 ** 3 &&
    typeof a.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(a.sha256) &&
    typeof a.url === 'string' &&
    /^https:\/\//i.test(a.url) &&
    a.url.length < 4096
  )
}

export class AppUpdateReleaseClient {
  private readonly fetcher: typeof fetch
  private readonly cache = new Map<string, { etag: string; value: unknown }>()
  constructor(fetcher: typeof fetch) {
    this.fetcher = fetcher
  }

  private async request(url: string, signal: AbortSignal, json: boolean): Promise<unknown> {
    const cached = json ? this.cache.get(url) : undefined
    const response = await this.fetcher(url, {
      headers: { ...UPDATE_HEADERS, ...(cached ? { 'If-None-Match': cached.etag } : {}) },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    })
    if (response.status === 304 && cached) return cached.value
    if (response.status === 404 && url === GITHUB_API_LATEST_RELEASE_URL) return null
    assertUpdateResponse(response)
    const reader = response.body?.getReader()
    if (!reader) throw new UpdateError('invalid-release', '更新服务返回空内容')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.length
        if (size > 4 * 1024 ** 2) throw new UpdateError('invalid-release', '更新信息超出大小限制')
        chunks.push(part.value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    const text = Buffer.concat(chunks).toString('utf8')
    let value: unknown = text
    if (json) {
      try {
        value = JSON.parse(text)
      } catch {
        throw new UpdateError('invalid-release', '更新服务返回无效信息')
      }
      const etag = response.headers.get('etag')
      if (etag) this.cache.set(url, { etag, value })
    }
    return value
  }

  async resolve(
    currentVersion: string,
    channel: AppUpdateChannel,
    platform: string,
    arch: string,
    signal: AbortSignal
  ): Promise<{ check: AppUpdateCheckResult; asset: UpdateAsset | null }> {
    let release: Release | null = null
    if (channel === 'stable')
      release = (await this.request(GITHUB_API_LATEST_RELEASE_URL, signal, true)) as Release | null
    if (!release || channel === 'preview') {
      const list = await this.request(GITHUB_API_RELEASES_URL, signal, true)
      if (!Array.isArray(list)) throw new UpdateError('invalid-release', '版本列表格式无效')
      release = pickLatestAvailableRelease(
        list.filter((r) => r && typeof r === 'object'),
        channel
      )
    }
    if (!release)
      return { check: { hasUpdate: false, currentVersion, releaseUrl: RELEASES_URL }, asset: null }
    const version = parseAppVersion(release.tag_name)
    if (!version || !pickLatestAvailableRelease([release], channel))
      throw new UpdateError('invalid-release', '发布版本与所选更新频道不匹配')
    const check: AppUpdateCheckResult = {
      hasUpdate: compareAppVersions(version.version, currentVersion) > 0,
      currentVersion,
      latestVersion: version.version,
      releaseUrl:
        typeof release.html_url === 'string' && release.html_url.startsWith('https://github.com/')
          ? release.html_url
          : RELEASES_URL,
      releaseNotes: typeof release.body === 'string' ? release.body.slice(0, 100_000) : '',
      publishedAt: typeof release.published_at === 'string' ? release.published_at : undefined
    }
    if (!check.hasUpdate) return { check, asset: null }
    if (platform !== 'win32')
      return {
        check: { ...check, error: 'unsupported-platform', message: '当前平台请从发布页手动下载' },
        asset: null
      }
    const assets = Array.isArray(release.assets)
      ? release.assets.filter((a) => a && typeof a === 'object')
      : []
    const selected = pickWindowsAsset(assets, arch)
    if (!selected?.name || !selected.browser_download_url)
      return {
        check: {
          ...check,
          error: 'no-asset',
          message: '发布页未提供适合当前平台的 Windows 安装包'
        },
        asset: null
      }
    check.assetName = selected.name
    check.assetSize = selected.size
    let sha256 =
      extractAssetDigestSha256(selected.digest) ||
      extractChecksumFromBody(check.releaseNotes ?? '', selected.name)
    if (!sha256) {
      const exact = assets.find((a) =>
        [selected.name + '.sha256', selected.name + '.sha256.txt'].some(
          (n) => n.toLowerCase() === a.name?.toLowerCase()
        )
      )
      const sums =
        exact ?? assets.find((a) => /^(sha256sums(?:\.txt)?|checksums?\.txt)$/i.test(a.name ?? ''))
      if (sums?.browser_download_url?.startsWith('https://')) {
        const text = (await this.request(sums.browser_download_url, signal, false)) as string
        sha256 = extractChecksumFromBody(text, selected.name)
        // A bare hash is valid only in the companion file for this exact installer.
        if (!sha256 && exact && /^[a-f\d]{64}$/i.test(text.trim()))
          sha256 = text.trim().toLowerCase()
      }
    }
    if (!sha256)
      return {
        check: {
          ...check,
          hasChecksum: false,
          error: 'no-checksum',
          message: 'GitHub Release 未提供 Windows 安装包的 SHA-256 校验和，已拒绝下载'
        },
        asset: null
      }
    const asset = {
      version: version.version,
      name: selected.name,
      size: selected.size ?? 0,
      url: selected.browser_download_url,
      sha256
    }
    if (!isUpdateAsset(asset)) throw new UpdateError('invalid-release', '安装包信息无效')
    return { check: { ...check, hasChecksum: true }, asset }
  }
}
