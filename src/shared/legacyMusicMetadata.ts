/** Private migration/compatibility operations. Public callers continue using
 * extensions.document and never supply catalog bindings or migration state. */
export interface LegacyMusicDocument {
  revision: number
  value: Record<string, unknown>
}
/** Same value-size and revision contract as extensions.document.edit. */
export function legacyMusicDocumentValue(document: LegacyMusicDocument): string {
  if (
    !Number.isSafeInteger(document?.revision) ||
    document.revision < 0 ||
    !document.value ||
    typeof document.value !== 'object' ||
    Array.isArray(document.value)
  )
    throw new Error('Invalid metadata document')
  const value = JSON.stringify(document.value)
  if (new TextEncoder().encode(value).byteLength > 16 * 1024 * 1024)
    throw new Error('Metadata document exceeds 16 MiB')
  return value
}
export interface LegacyMusicInventory {
  total: number
  items: Array<{
    id: string
    disposition: 'bound' | 'unassigned' | 'conflict'
    bindings: Array<{ entityId: string; collectionId: string; trackIds: string[] }>
    value: unknown
  }>
}
export interface LegacyMusicMigration {
  pluginId: string
  state: 'staging' | 'published'
  sourceRevision: number
  revision: number
  expected: number
  staged: number
  counts: { bound: number; unassigned: number; conflicts: number }
}
export interface LegacyMusicDetail {
  pluginId: string
  albumId: string
  revision: number
  method: 'manual' | 'external-ai' | 'historical'
  disposition: 'bound' | 'conflict'
  description: string | null
  /** A clear only when its exact field value has explicit manual provenance. */
  descriptionCleared?: boolean
  localNote: string | null
  /** Original retained payload remains available in the migration inventory. */
  truncated: boolean
  sources: Array<{ name: string; url: string; author?: string; license?: string }>
  /** Source-scoped names/roles, not confirmed people or track relationships. */
  credits: Array<{ name: string; role: string; source: string; trackTitle?: string; url?: string }>
}
export interface LegacyMusicStage {
  pluginId: string
  sourceRevision: number
  contentRevision: number
  entries: Array<{ id: string; value: unknown; collectionId?: string }>
}
export interface LegacyMusicEditContext {
  contentRevision: number
  collections: Array<{ id: string; collectionId: string }>
  /** Core-only compatibility lookups, never supplied by extensions.document. */
  descriptionOrigin?: 'provider'
}
export interface LegacyMusicProvenanceItem {
  albumId: string
  /** -1 denotes the current album, otherwise an immutable history snapshot. */
  snapshotRevision: number
  title: string
  description: string
  truncated: boolean
  sourceName: string | null
  disposition: 'pending' | 'manual' | 'excluded'
}
export interface LegacyMusicProvenancePage {
  revision: number
  total: number
  offset: number
  items: LegacyMusicProvenanceItem[]
}
export interface LegacyMusicProvenanceReview {
  expectedRevision: number
  albumId: string
  snapshotRevision: number
  /** Exact displayed text is part of the compare-and-set, not a replacement. */
  description: string
  disposition: 'manual' | 'excluded'
}
export interface LegacyMusicProvenanceOptions {
  offset?: number
  limit?: number
  includeReviewed?: boolean
}
export interface LegacyMusicMetadataDatabaseApi {
  legacyMusicStatus(pluginId: string): Promise<LegacyMusicMigration | null>
  legacyMusicBegin(
    pluginId: string,
    sourceRevision: number,
    base: Record<string, unknown>,
    expected: number,
    contentRevision: number
  ): Promise<LegacyMusicMigration>
  legacyMusicStage(request: LegacyMusicStage): Promise<LegacyMusicMigration>
  legacyMusicPublish(
    pluginId: string,
    sourceRevision: number,
    contentRevision: number
  ): Promise<LegacyMusicMigration>
  legacyMusicRead(pluginId: string): Promise<LegacyMusicDocument | null>
  legacyMusicEdit(
    pluginId: string,
    document: LegacyMusicDocument,
    context?: LegacyMusicEditContext
  ): Promise<LegacyMusicDocument>
  legacyMusicHistory(
    pluginId: string,
    offset?: number,
    limit?: number
  ): Promise<{ total: number; revisions: number[] }>
  legacyMusicHistoryRead(pluginId: string, revision: number): Promise<LegacyMusicDocument | null>
  legacyMusicRestore(
    pluginId: string,
    revision: number,
    expectedRevision: number
  ): Promise<LegacyMusicDocument>
  legacyMusicInventory(
    pluginId: string,
    offset?: number,
    limit?: number
  ): Promise<LegacyMusicInventory>
  legacyMusicProvenanceList(
    pluginId: string,
    options?: LegacyMusicProvenanceOptions
  ): Promise<LegacyMusicProvenancePage>
  legacyMusicProvenanceReview(
    pluginId: string,
    request: LegacyMusicProvenanceReview
  ): Promise<LegacyMusicProvenancePage>
  legacyMusicProvenanceRead(
    pluginId: string,
    albumId: string,
    snapshotRevision: number
  ): Promise<{ revision: number; item: LegacyMusicProvenanceItem }>
}
