import { randomUUID } from 'node:crypto'
import {
  expandSacdIsoTracks as expand,
  type SacdIsoMetadataReader
} from '../../core/library/sacdIsoTracks.ts'
export type { SacdIsoMetadataReader } from '../../core/library/sacdIsoTracks.ts'
export function expandSacdIsoTracks(
  tracks: unknown[],
  readMetadata: SacdIsoMetadataReader
): Promise<unknown[]> {
  return expand(tracks, readMetadata, randomUUID)
}
