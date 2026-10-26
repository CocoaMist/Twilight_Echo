/** Browser-owned music data being moved to the independent Core. UI-only keys stay in Chromium. */
export const CORE_STATE_DOMAINS = [
  'versions',
  'statistics-tracks',
  'statistics-days',
  'inbox',
  'podcast-preferences',
  'eq-preferences'
] as const
export type CoreStateDomain = (typeof CORE_STATE_DOMAINS)[number]
export const CORE_STATE_BATCH_BYTES = 4 * 1024 * 1024
/** Legacy version documents allow 8 Mi UTF-16 units (up to 24 MiB UTF-8).
 * Keep a whole relationship row intact; ordinary pages still target 4 MiB. */
export const CORE_STATE_LARGE_ROW_BYTES = 32 * 1024 * 1024
export function coreStateBatchByteLimit(domain: CoreStateDomain, rowCount: number): number {
  return domain === 'versions' && rowCount === 1
    ? CORE_STATE_LARGE_ROW_BYTES
    : CORE_STATE_BATCH_BYTES
}
export interface CoreStateRow {
  key: string
  value: unknown
}
export interface CoreStatePage {
  domain: CoreStateDomain
  revision: number
  rows: CoreStateRow[]
  next: string | null
}
export interface CoreMigrationManifest {
  version: 1
  counts: Record<CoreStateDomain, number>
}
export interface CoreMigrationStatus {
  complete: boolean
  id: string | null
  manifest: CoreMigrationManifest | null
  nextBatch: number
  counts: Record<CoreStateDomain, number>
}
export interface CoreStateApi {
  coreStateOpen(filePath: string): Promise<void>
  coreStateStatus(): Promise<CoreMigrationStatus>
  coreStateRead(
    domain: CoreStateDomain,
    after?: string,
    limit?: number,
    expectedRevision?: number
  ): Promise<CoreStatePage>
  coreStateWrite(
    domain: CoreStateDomain,
    rows: CoreStateRow[],
    expectedRevision: number,
    deletes?: string[]
  ): Promise<number>
  coreMigrationBegin(id: string, manifest: CoreMigrationManifest): Promise<CoreMigrationStatus>
  coreMigrationStage(
    id: string,
    batch: number,
    domain: CoreStateDomain,
    rows: CoreStateRow[]
  ): Promise<CoreMigrationStatus>
  coreMigrationCommit(id: string): Promise<CoreMigrationStatus>
  coreMigrationAbort(id: string): Promise<void>
}
export function emptyCoreStateCounts(): Record<CoreStateDomain, number> {
  return Object.fromEntries(CORE_STATE_DOMAINS.map((domain) => [domain, 0])) as Record<
    CoreStateDomain,
    number
  >
}

/** Stable row/byte boundaries are also the identities of resumable import batches. */
export async function* coreStateBatches(
  domain: CoreStateDomain,
  pages: AsyncIterable<CoreStateRow[]>
): AsyncIterable<CoreStateRow[]> {
  const encoder = new TextEncoder()
  let batch: CoreStateRow[] = [],
    bytes = 2
  for await (const page of pages)
    for (const row of page) {
      const size = encoder.encode(JSON.stringify(row)).length
      if (size + 2 > coreStateBatchByteLimit(domain, 1))
        throw new Error(`Core state row exceeds the supported legacy data limit: ${domain}`)
      if (batch.length && (batch.length === 128 || bytes + size + 1 > CORE_STATE_BATCH_BYTES)) {
        yield batch
        batch = []
        bytes = 2
      }
      batch.push(row)
      bytes += size + (batch.length > 1 ? 1 : 0)
    }
  if (batch.length) yield batch
}
