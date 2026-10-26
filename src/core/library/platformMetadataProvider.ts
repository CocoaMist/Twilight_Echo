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
import type { MetadataArtworkRecord } from '../../shared/musicArtwork.ts'
export interface PlatformMetadataOptions {
  inventory(): Array<{
    id: string
    enabled: boolean
    supportedMethods: string[]
    configuration: string
  }>
  usage(provider: string): MetadataUsage | null
  /** Independently reviewed image rights, never inherited from text. */
  artworkUsage?(provider: string): MetadataUsage | null
  /** Optional exact external cross-reference resolver. Never resolve by name. */
  identity?: {
    context(): string
    resolve(kind: CatalogKind, externalId: string, signal: AbortSignal): Promise<string | null>
  }
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
export function platformMetadataApprovals(
  raw: string | undefined,
  variable = 'TWILIGHT_METADATA_PLATFORM_USAGE'
): Record<string, MetadataUsage> {
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
    throw new Error(`${variable} must map provider IDs to reviewed field permissions`)
  return value as Record<string, MetadataUsage>
}

/** Explicit personal deployment opt-in for both NCM fields. Export stays off. */
export function ncmLocalFallbackApprovals(
  enabled: boolean,
  approved: Record<string, MetadataUsage>
) {
  if (!enabled) return approved
  const local = { display: true, cache: true, crossSource: true, export: false }
  return { ...approved, ncm: approved.ncm ? intersectMetadataUsage(local, approved.ncm) : local }
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
  private permitted(usage: MetadataUsage | null | undefined) {
    return (
      !!usage?.display &&
      usage.cache &&
      (usage.expiresAt === undefined || usage.expiresAt > (this.options.now ?? Date.now)())
    )
  }
  supportsArtwork(kind: CatalogKind) {
    const usage = this.options.artworkUsage?.(this.providerId)
    return (
      this.method(kind) !== 'fetchArtistIntro' &&
      this.supports(kind) &&
      this.permitted(usage) &&
      !!usage?.crossSource
    )
  }
  blockedReason(kind: CatalogKind): string | null {
    if (!this.current()?.enabled) return 'provider_not_available'
    if (!this.method(kind)) return 'metadata_capability_not_supported'
    const usage = this.options.usage(this.providerId)
    if (this.supportsArtwork(kind)) return null
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
      this.options.usage(this.providerId),
      ...(this.options.artworkUsage || this.options.identity
        ? [
            this.options.artworkUsage?.(this.providerId) ?? null,
            this.options.identity?.context() ?? null
          ]
        : [])
    ])
  }
  async enrich(
    request: { kind: CatalogKind; externalId: string; language: EntityMetadataLanguage },
    signal: AbortSignal
  ): ReturnType<MetadataDetailProvider['enrich']> {
    const reason = this.blockedReason(request.kind)
    if (reason) throw new MetadataHttpError(reason, 403)
    const context = this.context(),
      method = this.method(request.kind)!
    signal.throwIfAborted()
    const nativeId = this.options.identity
      ? await this.options.identity.resolve(request.kind, request.externalId, signal)
      : request.externalId
    signal.throwIfAborted()
    if (context !== this.context())
      throw new MetadataHttpError('provider_configuration_changed', 403)
    if (!nativeId) return { facts: [], availability: 'not_found' as const }
    const raw = await this.options.call(this.providerId, method, nativeId, signal)
    signal.throwIfAborted()
    if (context !== this.context())
      throw new MetadataHttpError('provider_configuration_changed', 403)
    const retrievedAt = (this.options.now ?? Date.now)()
    let result: unknown = raw
    if (method === 'fetchArtistIntro') {
      const url = this.options.sourcePage!(this.providerId, nativeId)
      if (typeof raw !== 'string' || raw.length > 20000 || !url)
        throw new Error('Invalid legacy artist introduction')
      result = raw.trim()
        ? {
            status: 'ok',
            metadata: {
              schemaVersion: 1,
              provider: this.providerId,
              kind: 'artist',
              id: nativeId,
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
      metadata.id !== nativeId
    )
      throw new Error('Platform metadata identity mismatch')
    const approved = this.options.usage(this.providerId)
    const facts: EntityMetadataFact[] = metadata.texts.flatMap((t) => {
      if (!approved) return []
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
    const artworkApproved = this.options.artworkUsage?.(this.providerId)
    const artwork: MetadataArtworkRecord[] = (metadata.artwork ?? []).flatMap((a) => {
      if (!artworkApproved || method === 'fetchArtistIntro') return []
      const usage = intersectMetadataUsage(artworkApproved, a.usage)
      if (!this.permitted(usage) || !usage.crossSource) return []
      return [
        {
          field: 'artwork',
          scope: metadata.kind,
          resource: a.resource,
          targetId: metadata.id,
          targetRef: {
            provider: this.providerId,
            kind: metadata.kind,
            idType: 'native',
            value: metadata.id
          },
          providerContext: context,
          usage,
          attribution: {
            provider: this.id,
            externalId: metadata.id,
            url: a.url,
            revision: a.revision,
            attribution: a.attribution,
            license: a.license,
            licenseUrl: a.licenseUrl,
            retrievedAt
          }
        }
      ]
    })
    return { facts, ...(artwork.length ? { artwork } : {}), availability: 'available' as const }
  }
}
