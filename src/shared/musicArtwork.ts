import type { MetadataAttribution } from './entityMetadata.ts'
import type { MetadataUsage } from './musicMetadata.ts'
import type { MusicExternalReference } from './musicIdentification.ts'

export type MusicArtworkScope = 'artist' | 'release' | 'album_project'

/** Private Core/database record. Never send resource URLs to presentation clients. */
export interface MetadataArtworkRecord {
  field: 'artwork'
  scope: MusicArtworkScope
  resource: string
  /** External MBID in the scope namespace, not the shared metadata UUID. */
  targetId: string
  sourceReleaseId?: string
  attribution: MetadataAttribution
  usage: MetadataUsage
  providerContext?: string
}

/** Session image access plus durable, credential-free provenance. */
export interface MusicArtwork {
  handle: string
  scope: MusicArtworkScope
  targetRef: MusicExternalReference
  sourceReleaseId?: string
  attribution: MetadataAttribution
  usage: MetadataUsage
}
