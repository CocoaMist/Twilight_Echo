import type { CatalogKind } from '../../shared/musicCatalog.ts'
import type { EntityMetadataFact, EntityMetadataLanguage } from '../../shared/entityMetadata.ts'
import type { MusicCreditSet } from '../../shared/musicCredits.ts'
import type { MetadataArtworkRecord } from '../../shared/musicArtwork.ts'

/** Shared contract for confirmed-ID details, separate from identity recall. */
export interface MetadataDetailProvider {
  readonly id: string
  supports(kind: CatalogKind): boolean
  /** Whether this deployment can obtain permitted images, subject to per-record rights. */
  supportsArtwork?(kind: CatalogKind): boolean
  blockedReason(kind: CatalogKind): string | null
  context(): string
  enrich(
    request: { kind: CatalogKind; externalId: string; language: EntityMetadataLanguage },
    signal: AbortSignal
  ): Promise<{
    facts: EntityMetadataFact[]
    credits?: MusicCreditSet
    exploration?: import('../../shared/musicExploration.ts').MusicExplorationIngest
    artwork?: MetadataArtworkRecord[]
    availability: 'available' | 'not_found' | 'not_provided' | 'unsupported'
  }>
}
