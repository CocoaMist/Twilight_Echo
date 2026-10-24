import type { CatalogKind } from '../../shared/musicCatalog.ts'
import type { EntityMetadataFact, EntityMetadataLanguage } from '../../shared/entityMetadata.ts'
import type { MetadataUsage, PlatformMetadataResult } from '../../shared/musicMetadata.ts'
import {
  intersectMetadataUsage,
  validPlatformMetadataResult,
  validMetadataProvider,
  validMetadataUsage
} from '../../shared/musicMetadata.ts'
import { MetadataHttpError } from './metadataHttp.ts'
import type { MetadataDetailProvider } from './metadataDetailProvider.ts'
export interface PlatformMetadataOptions {
  inventory(): Array<{
    id: string
    enabled: boolean
    supportedMethods: string[]
    configuration: string
  }>
  usage(provider: string): MetadataUsage | null
  /** Persisted account/config epoch, read only when this capability is enabled. */
  configuration?(): string
  call(
    provider: string,
    method: 'fetchArtistMetadata' | 'fetchAlbumMetadata' | 'fetchArtistIntro',
    id: string,
    signal: AbortSignal
  ): Promise<unknown>
  /** Only known canonical pages can wrap the old string-only capability. */
  sourcePage?(provider: string, id: string): string | null
  now?(): number
}

/** Release configuration, not a permission grant supplied by a plugin. */
export function platformMetadataApprovals(raw: string | undefined): Record<string, MetadataUsage> {
  if (!raw) return {}
  const value: unknown = JSON.parse(raw)
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.entries(value).every(
      ([provider, usage]) => validMetadataProvider(provider) && validMetadataUsage(usage)
    )
  )
    throw new Error(
      'TWILIGHT_METADATA_PLATFORM_USAGE must map provider IDs to reviewed field permissions'
    )
  return value as Record<string, MetadataUsage>
}

/** Native ID details do not depend on a MusicBrainz identity or public MB access. */
export class PlatformMetadataProvider implements MetadataDetailProvider {
  readonly id: string
  private readonly providerId: string
  private readonly options: PlatformMetadataOptions
  constructor(providerId: string, options: PlatformMetadataOptions) {
    this.providerId = providerId
    this.options = options
    this.id = `platform.${providerId}`
  }
  private current() {
    return this.options.inventory().find((p) => p.id === this.providerId)
  }
  private method(kind: CatalogKind) {
    const methods = this.current()?.supportedMethods ?? []
    if (kind === 'artist' && methods.includes('fetchArtistMetadata')) return 'fetchArtistMetadata'
    if (kind === 'release' && methods.includes('fetchAlbumMetadata')) return 'fetchAlbumMetadata'
    if (kind === 'artist' && methods.includes('fetchArtistIntro') && this.options.sourcePage)
      return 'fetchArtistIntro'
    return null
  }
  supports(kind: CatalogKind) {
    return !!this.method(kind)
  }
  blockedReason(kind: CatalogKind): string | null {
    if (!this.current()?.enabled) return 'provider_not_available'
    if (!this.method(kind)) return 'metadata_capability_not_supported'
    const usage = this.options.usage(this.providerId)
    if (!usage?.display || !usage.cache) return 'platform_metadata_cache_not_approved'
    if (usage.expiresAt !== undefined && usage.expiresAt <= (this.options.now ?? Date.now)())
      return 'platform_metadata_permission_expired'
    return null
  }
  context() {
    const current = this.current()
    return JSON.stringify([
      this.options.configuration?.() ?? current?.configuration,
      current?.enabled,
      current?.supportedMethods,
      this.options.usage(this.providerId)
    ])
  }
  async enrich(
    request: { kind: CatalogKind; externalId: string; language: EntityMetadataLanguage },
    signal: AbortSignal
  ) {
    const reason = this.blockedReason(request.kind)
    if (reason) throw new MetadataHttpError(reason, 403)
    const context = this.context(),
      method = this.method(request.kind)!
    signal.throwIfAborted()
    const raw = await this.options.call(this.providerId, method, request.externalId, signal)
    signal.throwIfAborted()
    if (context !== this.context())
      throw new MetadataHttpError('provider_configuration_changed', 403)
    const retrievedAt = (this.options.now ?? Date.now)()
    let result: unknown = raw
    if (method === 'fetchArtistIntro') {
      const url = this.options.sourcePage!(this.providerId, request.externalId)
      if (typeof raw !== 'string' || raw.length > 20000 || !url)
        throw new Error('Invalid legacy artist introduction')
      result = raw.trim()
        ? {
            status: 'ok',
            metadata: {
              schemaVersion: 1,
              provider: this.providerId,
              kind: 'artist',
              id: request.externalId,
              name: '',
              texts: [
                {
                  field: 'introduction',
                  value: raw.trim(),
                  language: 'und',
                  url,
                  revision: '',
                  attribution: this.providerId,
                  license: '',
                  licenseUrl: ''
                }
              ]
            }
          }
        : { status: 'not_provided' }
    }
    if (!validPlatformMetadataResult(result)) throw new Error('Invalid platform metadata response')
    if (result.status !== 'ok') return { facts: [], availability: result.status }
    const metadata = (result as Extract<PlatformMetadataResult, { status: 'ok' }>).metadata
    if (
      metadata.provider !== this.providerId ||
      metadata.kind !== request.kind ||
      metadata.id !== request.externalId
    )
      throw new Error('Platform metadata identity mismatch')
    const approved = this.options.usage(this.providerId)!
    const facts: EntityMetadataFact[] = metadata.texts.flatMap((t) => {
      const usage = intersectMetadataUsage(approved, t.usage)
      if (
        !usage.display ||
        !usage.cache ||
        (usage.expiresAt !== undefined && usage.expiresAt <= retrievedAt)
      )
        return []
      return [
        {
          field: t.field,
          value: t.value,
          language: t.language,
          sourceProvider: this.providerId,
          providerContext: context,
          usage,
          attribution: {
            provider: this.id,
            externalId: metadata.id,
            url: t.url,
            revision: t.revision,
            attribution: t.attribution,
            license: t.license,
            licenseUrl: t.licenseUrl,
            retrievedAt
          }
        }
      ]
    })
    return { facts, availability: 'available' as const }
  }
}
