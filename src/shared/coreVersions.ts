import type {
  MusicVersionsDocument,
  MusicVersion,
  VersionFamily,
  VersionOperation,
  VersionScope
} from './musicVersions.ts'
import type { CoreTrackView } from './coreViews.ts'

export interface CoreVersionsCatalogQuery {
  scope?: VersionScope
  offset?: number
  limit?: number
  search?: string
  key?: string
  trackId?: string
  revision?: number
  contentRevision?: number
  playlistsRevision?: number
}
export interface CoreVersionsCatalogPage {
  revision: number
  contentRevision: number
  playlistsRevision: number
  total: number
  offset: number
  items: Array<{ key: string; track: CoreTrackView; trackCount?: number; albumId?: string }>
}

export interface CoreVersionsEdit {
  revision: number
  scope: VersionScope
  operation: VersionOperation
  keys: string[]
  label: string
}
export interface CoreVersionsQuery {
  revision: number
  scope: VersionScope
  kind: 'versions' | 'families'
  offset?: number
  limit?: number
}
export interface CoreVersionsPage {
  revision: number
  total: number
  offset: number
  items: Array<MusicVersion | VersionFamily>
}
/** One transaction replaces the complete graph, including cross-row family references.
 * The original 8 Mi-character/40,000-source allowance is not a 128-row RPC batch. */
export interface CoreVersionsApi {
  coreVersionsReplace(document: MusicVersionsDocument, expectedRevision: number): Promise<number>
}
