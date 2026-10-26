/** Text and artwork rights are assessed separately. Missing provider terms need
 * an explicit deployment approval; access to an API is not that approval. */
export interface MetadataUsage {
  display: boolean
  cache: boolean
  crossSource: boolean
  export: boolean
  expiresAt?: number
}

/** Optional provider details. Keep this wire contract in sync with the SDK. */
export interface PlatformEntityMetadata {
  schemaVersion: 1
  provider: string
  kind: 'artist' | 'release'
  id: string
  name: string
  texts: Array<{
    field: 'description' | 'introduction'
    value: string
    /** Preserve the source language; use und when the service does not say. */
    language: string
    url: string
    revision: string
    attribution: string
    license: string
    licenseUrl: string
    usage?: MetadataUsage
  }>
  /** Private resource URLs; Core projects approved images to session handles. */
  artwork?: Array<{
    resource: string
    url: string
    revision: string
    attribution: string
    license: string
    licenseUrl: string
    usage?: MetadataUsage
  }>
}
export type PlatformMetadataResult =
  | { status: 'ok'; metadata: PlatformEntityMetadata }
  | { status: 'not_found' | 'not_provided' | 'unsupported' }

/** Match source tags without rewriting their reported language in the DTO. */
export function metadataLanguageFamily(language: string): string {
  const tag = language.toLowerCase()
  if (/^zh-hans(?:-|$)/.test(tag) || /^zh-(cn|sg)(?:-|$)/.test(tag)) return 'zh-Hans'
  if (/^zh-hant(?:-|$)/.test(tag) || /^zh-(tw|hk|mo)(?:-|$)/.test(tag)) return 'zh-Hant'
  if (/^en(?:-|$)/.test(tag)) return 'en'
  return tag
}

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((k) => allowed.includes(k))
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length <= max && !v.includes('\0')
export const validMetadataProvider = (v: unknown): v is string =>
  text(v, 118) && /^[a-z0-9][a-z0-9._-]*$/.test(v)
export function validMetadataUsage(v: unknown): v is MetadataUsage {
  return (
    object(v) &&
    keys(v, ['display', 'cache', 'crossSource', 'export', 'expiresAt']) &&
    ['display', 'cache', 'crossSource', 'export'].every((k) => typeof v[k] === 'boolean') &&
    (v.expiresAt === undefined || (Number.isSafeInteger(v.expiresAt) && Number(v.expiresAt) > 0))
  )
}
/** Attribution links never contain credentials, CDN signatures or file paths. */
export function metadataPageUrl(v: unknown): v is string {
  if (!text(v, 2048)) return false
  try {
    const url = new URL(v)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search
  } catch {
    return false
  }
}
export function validPlatformMetadataResult(v: unknown): v is PlatformMetadataResult {
  if (!object(v)) return false
  if (v.status !== 'ok')
    return (
      keys(v, ['status']) && ['not_found', 'not_provided', 'unsupported'].includes(String(v.status))
    )
  if (!keys(v, ['status', 'metadata']) || !object(v.metadata)) return false
  const m = v.metadata
  return (
    keys(m, ['schemaVersion', 'provider', 'kind', 'id', 'name', 'texts', 'artwork']) &&
    m.schemaVersion === 1 &&
    validMetadataProvider(m.provider) &&
    ['artist', 'release'].includes(String(m.kind)) &&
    text(m.id, 512) &&
    !!m.id.trim() &&
    text(m.name, 2048) &&
    Array.isArray(m.texts) &&
    m.texts.length <= 8 &&
    m.texts.every(
      (t) =>
        object(t) &&
        keys(t, [
          'field',
          'value',
          'language',
          'url',
          'revision',
          'attribution',
          'license',
          'licenseUrl',
          'usage'
        ]) &&
        ['description', 'introduction'].includes(String(t.field)) &&
        text(t.value, 20000) &&
        !!t.value.trim() &&
        text(t.language, 35) &&
        /^(und|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(t.language) &&
        metadataPageUrl(t.url) &&
        text(t.revision, 256) &&
        text(t.attribution, 2048) &&
        text(t.license, 256) &&
        (t.licenseUrl === '' || metadataPageUrl(t.licenseUrl)) &&
        (t.usage === undefined || validMetadataUsage(t.usage))
    ) &&
    (m.artwork === undefined ||
      (Array.isArray(m.artwork) &&
        m.artwork.length <= 3 &&
        m.artwork.every(
          (a) =>
            object(a) &&
            keys(a, [
              'resource',
              'url',
              'revision',
              'attribution',
              'license',
              'licenseUrl',
              'usage'
            ]) &&
            metadataImageUrl(a.resource) &&
            metadataPageUrl(a.url) &&
            text(a.revision, 256) &&
            text(a.attribution, 2048) &&
            text(a.license, 256) &&
            (a.licenseUrl === '' || metadataPageUrl(a.licenseUrl)) &&
            (a.usage === undefined || validMetadataUsage(a.usage))
        )))
  )
}

function metadataImageUrl(v: unknown): v is string {
  if (!text(v, 2048)) return false
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hash
  } catch {
    return false
  }
}

/** A provider may narrow deployment permission, never broaden it. */
export function intersectMetadataUsage(
  approved: MetadataUsage,
  declared?: MetadataUsage
): MetadataUsage {
  const deadlines = [approved.expiresAt, declared?.expiresAt].filter(
    (v): v is number => v !== undefined
  )
  return {
    display: approved.display && (declared?.display ?? true),
    cache: approved.cache && (declared?.cache ?? true),
    crossSource: approved.crossSource && (declared?.crossSource ?? true),
    export: approved.export && (declared?.export ?? true),
    ...(deadlines.length ? { expiresAt: Math.min(...deadlines) } : {})
  }
}
