/** Personal ratings belong to a recording or a physical release, never an album project. */
import type { CatalogEntityReference } from './musicCatalog.ts'
export type MusicRatingKind = 'recording' | 'release'
/** null steps is an explicit clearing receipt; a null value means never rated. */
export interface MusicRatingValue { steps: number | null; revision: number; updatedAt: number }
export interface MusicRatingsToken { ratingsRevision: number; linkRevision: number; targetKey: string }
export interface MusicRatingsDetail {
  entityId: string
  kind: MusicRatingKind
  scope: 'entity' | 'identity'
  value: MusicRatingValue | null
  token: MusicRatingsToken
  external?: { status: 'unavailable'; reason: 'no_approved_source'; items: [] }
}
export interface MusicRatingsSet { entityId: string; token: MusicRatingsToken; steps: number | null }
export interface MusicRatingsHistoryQuery { entityId: string; offset?: number; limit?: number }
/** Manual playback versions are navigation only; select one physical source entity before rating. */
export interface MusicRatingsTargetsQuery {
  entityId: string
  offset?: number
  limit?: number
  /** Exact opened Track context, never an inferred title or playback-equivalence match. */
  trackContext?: { provider: string; id: string }
}
export interface MusicRatingsTargetsPage { entityId: string; offset: number; total: number; items: CatalogEntityReference[] }
export type MusicRatingChangeReason = 'set' | 'clear' | 'identity_carry' | 'identity_current' | 'identity_clear'
export interface MusicRatingsHistoryPage {
  entityId: string
  kind: MusicRatingKind
  scope: 'entity' | 'identity'
  offset: number
  total: number
  items: Array<MusicRatingValue & { seq: number; reason: MusicRatingChangeReason }>
}
export interface MusicRatingImpact {
  revision: number
  current: MusicRatingValue | null
  target: MusicRatingValue | null
  conflict: boolean
  action: 'keep' | 'carry' | 'share' | 'choose'
}
export interface MusicRatingResolution { revision: number; choice: 'current' | 'target' | 'clear' }
export interface MusicRatingsDatabaseApi {
  ratingsTargets(query: MusicRatingsTargetsQuery): Promise<MusicRatingsTargetsPage>
  ratingsDetail(entityId: string): Promise<MusicRatingsDetail>
  ratingsSet(request: MusicRatingsSet, now: number): Promise<MusicRatingsDetail>
  ratingsHistory(query: MusicRatingsHistoryQuery): Promise<MusicRatingsHistoryPage>
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max = 128): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !v.includes('\0')
const uint = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) >= 0
export const validMusicRatingSteps = (v: unknown): v is number | null => v === null || (Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 10)
export function validMusicRatingsToken(v: unknown): v is MusicRatingsToken {
  return record(v) && Object.keys(v).length === 3 && uint(v.ratingsRevision) && uint(v.linkRevision) && text(v.targetKey, 512)
}
export function validMusicRatingResolution(v: unknown): v is MusicRatingResolution {
  return record(v) && Object.keys(v).length === 2 && uint(v.revision) && ['current', 'target', 'clear'].includes(String(v.choice))
}
function validTrackContext(v: unknown): boolean {
  return record(v) && Object.keys(v).length === 2 &&
    typeof v.provider === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(v.provider) &&
    typeof v.id === 'string' && v.id.length > 0 && v.id.length <= 8192 && !v.id.includes('\0')
}
export function validMusicRatingsPayload(name: string, raw: unknown): boolean {
  if (!record(raw)) return false
  const keys = (...allowed: string[]) => Object.keys(raw).every(k => allowed.includes(k))
  switch (name) {
    case 'ratings.detail': return keys('entityId') && text(raw.entityId)
    case 'ratings.set': return keys('entityId', 'token', 'steps') && text(raw.entityId) && validMusicRatingsToken(raw.token) && validMusicRatingSteps(raw.steps)
    case 'ratings.targets': return keys('entityId', 'offset', 'limit', 'trackContext') && text(raw.entityId) &&
      (raw.trackContext === undefined || validTrackContext(raw.trackContext)) &&
      (raw.offset === undefined || uint(raw.offset)) &&
      (raw.limit === undefined || (uint(raw.limit) && Number(raw.limit) >= 1 && Number(raw.limit) <= 100))
    case 'ratings.history': return keys('entityId', 'offset', 'limit') && text(raw.entityId) &&
      (raw.offset === undefined || uint(raw.offset)) &&
      (raw.limit === undefined || (uint(raw.limit) && Number(raw.limit) >= 1 && Number(raw.limit) <= 100))
    default: return false
  }
}
