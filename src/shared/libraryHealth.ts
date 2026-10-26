import type { CoreTrackView } from './coreViews.ts'
import type { CatalogEntityReference } from './musicCatalog.ts'
import type { EntityMetadataLanguage, EntityMetadataPolicyView } from './entityMetadata.ts'

export const HEALTH_CATEGORIES = [
  'track_tags',
  'track_cover',
  'track_genre',
  'artist_identity',
  'artist_name',
  'artist_image',
  'artist_intro',
  'album_identity',
  'album_intro',
  'release_identity'
] as const
export type HealthCategory = (typeof HEALTH_CATEGORIES)[number]
export const HEALTH_STATES = [
  'ready',
  'processing',
  'review',
  'unavailable',
  'blocked',
  'failed',
  'manual'
] as const
export type HealthIssueState = (typeof HEALTH_STATES)[number]
export interface LibraryHealthMetric {
  total: number
  present: number
  hidden: number
  missing: number
  repairable: number
}
export interface LibraryHealthIssue {
  index: number
  category: HealthCategory
  state: HealthIssueState
  title: string
  subtitle: string
  reason: string
  canRepair: boolean
  entity?: CatalogEntityReference
  track?: CoreTrackView
}
export interface LibraryHealthReport {
  id: string
  checkedAt: number
  libraryRevision: number
  catalogRevision: number
  metadataRevision: number
  language: EntityMetadataLanguage
  totals: { tracks: number; artists: number; albums: number; releases: number }
  metrics: Record<HealthCategory, LibraryHealthMetric>
  states: Record<HealthIssueState, number>
  policy: EntityMetadataPolicyView
}
export interface LibraryHealthState {
  phase: 'idle' | 'scanning' | 'ready' | 'repairing' | 'failed'
  inspected: number
  report: LibraryHealthReport | null
  error: string
  repair: null | {
    batchId: string
    stage: 'queueing' | 'waiting' | 'completed'
    processed: number
    total: number
    /** Accepted durable jobs, not the number of fields successfully filled. */
    jobs: number
    errors: number
    lastError: string
  }
}
export interface LibraryHealthPageQuery {
  id: string
  category?: HealthCategory
  state?: HealthIssueState
  offset?: number
  limit?: number
}
export interface LibraryHealthPage {
  id: string
  total: number
  offset: number
  items: LibraryHealthIssue[]
}
export type LibraryHealthRepair =
  | { id: string; category?: HealthCategory }
  /** Refresh the current library and fill available fields in one Core-owned operation. */
  | { refresh: true }
export function validLibraryHealthPayload(name: string, raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const p = raw as Record<string, unknown>
  const keys = (...allowed: string[]) => Object.keys(p).every((k) => allowed.includes(k))
  const uint = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
  const id =
    typeof p.id === 'string' && p.id.length > 0 && p.id.length <= 128 && !p.id.includes('\0')
  const category =
    p.category === undefined || HEALTH_CATEGORIES.includes(p.category as HealthCategory)
  if (name === 'library.health.start' || name === 'library.health.status') return keys()
  if (name === 'library.health.repair')
    return (keys('refresh') && p.refresh === true) || (keys('id', 'category') && id && category)
  return (
    name === 'library.health.page' &&
    keys('id', 'category', 'state', 'offset', 'limit') &&
    id &&
    category &&
    (p.state === undefined || HEALTH_STATES.includes(p.state as HealthIssueState)) &&
    (p.offset === undefined || uint(p.offset)) &&
    (p.limit === undefined || (uint(p.limit) && Number(p.limit) > 0 && Number(p.limit) <= 100))
  )
}
