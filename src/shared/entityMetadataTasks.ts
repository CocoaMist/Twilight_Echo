import type { EntityMetadataJob, EntityMetadataState } from './entityMetadata.ts'
import type { CatalogEntityReference, CatalogKind } from './musicCatalog.ts'

export const METADATA_ACTIVE_STATES = ['queued', 'running', 'retry_wait'] as const
export const METADATA_ATTENTION_STATES = ['needs_review', 'blocked', 'failed'] as const
export type MetadataTaskFilter = 'all' | 'active' | 'attention'
export interface MetadataTasksQuery {
  filter?: MetadataTaskFilter
  batchId?: string
  offset?: number
  limit?: number
}
/** A bounded display projection, not another execution queue. */
export interface MetadataTaskItem extends Pick<
  EntityMetadataJob,
  | 'id'
  | 'type'
  | 'provider'
  | 'language'
  | 'state'
  | 'generation'
  | 'attempts'
  | 'nextAttemptAt'
  | 'outcome'
  | 'reason'
  | 'updatedAt'
> {
  title: string
  kind: CatalogKind | null
  /** Only a real source catalog entity; shared enrichment target UUIDs never appear here. */
  entity: CatalogEntityReference | null
  demandCount: number
}
export interface MetadataTasksPage {
  offset: number
  total: number
  /** All persisted jobs, independent of paging, filter and batch selection. */
  counts: Record<EntityMetadataState, number>
  items: MetadataTaskItem[]
}
export interface MetadataTaskDemandsQuery {
  jobId: string
  offset?: number
  limit?: number
}
export interface MetadataTaskDemandsPage {
  jobId: string
  offset: number
  total: number
  /** Current consumers only. Removed demands are not batch history. */
  items: Array<{
    batchId: string
    automatic: boolean
    origin: 'new' | 'history' | null
    canCancel: boolean
  }>
}
export interface MetadataTaskSourcesQuery {
  jobId: string
  offset?: number
  limit?: number
}
export interface MetadataTaskSource {
  entity: CatalogEntityReference
  inputVersion: string
  linkRevision: number
  providers: string[]
}
export interface MetadataTaskSourcesPage {
  jobId: string
  generation: number
  offset: number
  total: number
  items: MetadataTaskSource[]
}
export interface MetadataTaskRequeryItem {
  jobId: string
  generation: number
  entityId: string
  inputVersion: string
  linkRevision: number
}
/** Explicit new demand, not a reconstruction of removed batch consumers. */
export interface MetadataTaskRequery {
  items: MetadataTaskRequeryItem[]
  demandId: string
  batchId?: string
}
export const METADATA_REQUERY_STATES = ['completed', 'failed', 'blocked', 'cancelled'] as const
export function validMetadataTasksPayload(name: string, raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const v = raw as Record<string, unknown>
  const text = (value: unknown) =>
    typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('\0')
  const uint = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
  if (name === 'metadata.entity.requery')
    return (
      Object.keys(v).every((k) => ['items', 'batchId', 'demandId'].includes(k)) &&
      text(v.demandId) &&
      (v.batchId === undefined || text(v.batchId)) &&
      Array.isArray(v.items) &&
      v.items.length > 0 &&
      v.items.length <= 10 &&
      new Set(v.items.map((item) => item?.jobId)).size === v.items.length &&
      v.items.every(
        (item) =>
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          Object.keys(item).every((k) =>
            ['jobId', 'generation', 'entityId', 'inputVersion', 'linkRevision'].includes(k)
          ) &&
          text(item.jobId) &&
          text(item.entityId) &&
          uint(item.generation) &&
          item.generation > 0 &&
          uint(item.linkRevision) &&
          typeof item.inputVersion === 'string' &&
          item.inputVersion.length > 0 &&
          item.inputVersion.length <= 32768 &&
          !item.inputVersion.includes('\0')
      )
    )
  if (v.offset !== undefined && !uint(v.offset)) return false
  if (v.limit !== undefined && (!uint(v.limit) || Number(v.limit) < 1 || Number(v.limit) > 100))
    return false
  if (name === 'metadata.entity.tasks')
    return (
      Object.keys(v).every((k) => ['filter', 'batchId', 'offset', 'limit'].includes(k)) &&
      (v.filter === undefined ||
        (typeof v.filter === 'string' && ['all', 'active', 'attention'].includes(v.filter))) &&
      (v.batchId === undefined || text(v.batchId))
    )
  if (name === 'metadata.entity.demands' || name === 'metadata.entity.sources')
    return Object.keys(v).every((k) => ['jobId', 'offset', 'limit'].includes(k)) && text(v.jobId)
  return false
}
