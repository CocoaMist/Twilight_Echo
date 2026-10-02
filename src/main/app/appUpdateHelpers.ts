import type { AppUpdateChannel } from '../../shared/appUpdate.ts'

export type GithubAssetLike = {
  name?: string
  size?: number
  browser_download_url?: string
  content_type?: string
  digest?: string
}

export type GithubReleaseLike = {
  tag_name?: string
  draft?: boolean
  prerelease?: boolean
}

const WINDOWS_SETUP_RE = /setup\.exe$/i
const WINDOWS_EXE_RE = /\.exe$/i
const SHA256_HEX_RE = /\b[a-f0-9]{64}\b/i
const SHA256_ASSET_DIGEST_RE = /^sha256:([a-f0-9]{64})$/i

export function pickWindowsAsset(assets: GithubAssetLike[], arch = 'x64'): GithubAssetLike | null {
  const named = assets.filter(
    (asset) =>
      typeof asset.name === 'string' &&
      typeof asset.browser_download_url === 'string' &&
      !/[\\/]/.test(asset.name) &&
      !['arm64', 'x64', 'ia32'].some(
        (other) =>
          other !== arch && new RegExp(`(?:^|[-_.])${other}(?:[-_.]|$)`, 'i').test(asset.name!)
      )
  )
  const setup = named.find((asset) => WINDOWS_SETUP_RE.test(asset.name || ''))
  if (setup) return setup
  const exe = named.find((asset) => WINDOWS_EXE_RE.test(asset.name || ''))
  return exe || null
}

export function pickLatestAvailableRelease<T extends GithubReleaseLike>(
  releases: readonly T[],
  channel: AppUpdateChannel = 'stable'
): T | null {
  return (
    releases
      .filter((release) => {
        const version = parseAppVersion(release.tag_name)
        return (
          release.draft !== true &&
          version &&
          (channel === 'preview' || (release.prerelease !== true && version.pre.length === 0))
        )
      })
      .sort((a, b) => compareAppVersions(b.tag_name!, a.tag_name!))[0] ?? null
  )
}

export function parseAppVersion(
  input: unknown
): { version: string; core: string[]; pre: string[] } | null {
  if (typeof input !== 'string' || input.length > 128) return null
  const version = input.trim().replace(/^v/, '')
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/.exec(
      version
    )
  if (!match) return null
  const pre = match[4]?.split('.') ?? []
  if (pre.some((part) => /^0\d+$/.test(part))) return null
  return { version, core: match.slice(1, 4), pre }
}

// Compare decimal strings by length to preserve SemVer precedence for large identifiers.
export function compareAppVersions(a: string, b: string): number {
  const left = parseAppVersion(a),
    right = parseAppVersion(b)
  if (!left || !right) throw new Error('Invalid application version')
  const numeric = (x: string, y: string): number =>
    x.length - y.length || (x > y ? 1 : x < y ? -1 : 0)
  for (let i = 0; i < 3; i++) {
    const order = numeric(left.core[i], right.core[i])
    if (order) return order
  }
  if (!left.pre.length || !right.pre.length)
    return Number(!left.pre.length) - Number(!right.pre.length)
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i],
      y = right.pre[i]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (x === y) continue
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y)
    return xn && yn ? numeric(x, y) : xn !== yn ? (xn ? -1 : 1) : x > y ? 1 : -1
  }
  return 0
}

export function extractAssetDigestSha256(digest?: string): string | undefined {
  return digest?.trim().match(SHA256_ASSET_DIGEST_RE)?.[1]?.toLowerCase()
}

export function extractChecksumFromBody(body: string, assetName: string): string | undefined {
  if (!body || !assetName) return undefined
  const lines = body.split(/\r?\n/)
  for (const line of lines) {
    if (!new RegExp(`(?:^|[\\s*\x60(])${escapeRegExp(assetName)}(?:$|[\\s\x60)])`, 'i').test(line))
      continue
    const match = line.match(SHA256_HEX_RE)
    if (match) return match[0].toLowerCase()
  }
  return undefined
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export { SHA256_HEX_RE }
