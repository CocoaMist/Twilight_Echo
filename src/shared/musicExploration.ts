import type { MetadataAttribution } from './entityMetadata.ts'
import type { MusicCredit, MusicCreditRole } from './musicCredits.ts'
import type { MetadataUsage } from './musicMetadata.ts'

/** Separate from CatalogKind: old catalog/identification/provider capabilities stay unchanged. */
export type MusicExplorationKind =
  | 'artist'
  | 'work'
  | 'performance'
  | 'recording'
  | 'release'
  | 'album_project'
export interface MusicExplorationReference {
  provider: string
  kind: MusicExplorationKind
  idType: string
  value: string
}
export interface MusicExplorationEntity {
  id: string
  kind: MusicExplorationKind
  title: string
  artist: string
}
export interface MusicExplorationItem extends MusicExplorationEntity {
  inLibrary: boolean
  sourceCount: number
}
export type MusicExplorationRelationKind =
  | 'credit'
  | 'work_recording'
  | 'work_performance'
  | 'performance_recording'
  | 'part'
export interface MusicExplorationRelation {
  id: string
  kind: MusicExplorationRelationKind
  from: MusicExplorationEntity
  to: MusicExplorationEntity
  order: number
  origin: 'provider' | 'manual'
  attribution: MetadataAttribution | null
  /** Original role, direction, joinphrase and attributes are retained. */
  credit?: MusicCredit
}
export interface MusicExplorationState {
  revision: number
  catalogRevision: number
  contentRevision: number
  metadataRevision: number
}
export interface MusicExplorationToken extends MusicExplorationState {
  contextKey: string
  asOf: number
  expiresAt: number | null
}
export interface MusicExplorationReadContext {
  platformContexts?: Record<string, string>
}
export interface MusicExplorationQuery {
  kinds?: MusicExplorationKind[]
  scope?: 'library' | 'catalog'
  search?: string
  offset?: number
  limit?: number
  token?: MusicExplorationToken
}
export interface MusicExplorationPage {
  token: MusicExplorationToken
  offset: number
  total: number
  items: MusicExplorationItem[]
}
export interface MusicExplorationDetailQuery {
  entityId: string
  token?: MusicExplorationToken
}
export interface MusicExplorationLookupQuery {
  reference: MusicExplorationReference
  token?: MusicExplorationToken
}
export interface MusicExplorationDetail {
  token: MusicExplorationToken
  entity: MusicExplorationItem | null
  references: MusicExplorationReference[]
  referencesTruncated: boolean
  /** A provider's source set was incomplete, not merely the displayed page. */
  providerTruncated: boolean
}
export interface MusicExplorationRelationsQuery extends MusicExplorationDetailQuery {
  direction?: 'outgoing' | 'incoming' | 'both'
  relations?: MusicExplorationRelationKind[]
  roles?: MusicCreditRole[]
  kinds?: MusicExplorationKind[]
  scope?: 'library' | 'catalog'
  offset?: number
  limit?: number
}
export interface MusicExplorationRelationItem {
  entity: MusicExplorationItem
  relation: MusicExplorationRelation
}
export interface MusicExplorationRelationsPage {
  token: MusicExplorationToken
  offset: number
  total: number
  items: MusicExplorationRelationItem[]
  providerTruncated: boolean
}
export type MusicExplorationParticipationQuery = Omit<
  MusicExplorationRelationsQuery,
  'direction' | 'relations'
>
export interface MusicExplorationPerformanceSave {
  id?: string
  title: string
  workId: string
  /** Exact catalog recording anchors, in movement/order sequence. */
  recordingIds: string[]
  revision: number
}
export interface MusicExplorationPerformanceDelete {
  id: string
  revision: number
}
/** Private trusted adapter/Core input. A name is display data, never identity evidence. */
export interface MusicExplorationNode {
  reference: MusicExplorationReference
  aliases?: MusicExplorationReference[]
  title: string
  artist?: string
}
export interface MusicExplorationRelationInput {
  from: MusicExplorationReference
  to: MusicExplorationReference
  kind: MusicExplorationRelationKind
  order: number
  credit?: MusicCredit
  attribution: MetadataAttribution | null
  usage?: MetadataUsage
  sourceProvider?: string
  providerContext?: string
}
export interface MusicExplorationIngest {
  owner: MusicExplorationReference
  provider: string
  setKey: string
  nodes: MusicExplorationNode[]
  relations: MusicExplorationRelationInput[]
  truncated: boolean
}
export interface MusicExplorationCreditSync {
  targetId: string
  provider: string
}
export interface MusicExplorationDatabaseApi {
  explorationState(): Promise<MusicExplorationState>
  explorationQuery(
    query: MusicExplorationQuery,
    context?: MusicExplorationReadContext
  ): Promise<MusicExplorationPage>
  explorationDetail(
    query: MusicExplorationDetailQuery,
    context?: MusicExplorationReadContext
  ): Promise<MusicExplorationDetail>
  explorationLookup(
    query: MusicExplorationLookupQuery,
    context?: MusicExplorationReadContext
  ): Promise<MusicExplorationDetail>
  explorationRelations(
    query: MusicExplorationRelationsQuery,
    context?: MusicExplorationReadContext
  ): Promise<MusicExplorationRelationsPage>
  explorationParticipation(
    query: MusicExplorationParticipationQuery,
    context?: MusicExplorationReadContext
  ): Promise<MusicExplorationRelationsPage>
  explorationPerformanceSave(
    request: MusicExplorationPerformanceSave
  ): Promise<MusicExplorationDetail>
  explorationPerformanceDelete(request: MusicExplorationPerformanceDelete): Promise<boolean>
  explorationIngest(request: MusicExplorationIngest): Promise<MusicExplorationState>
  explorationSyncCredits(request: MusicExplorationCreditSync): Promise<MusicExplorationState>
  explorationBackfillCredits(limit?: number): Promise<{ processed: number; pending: boolean }>
}
const kinds = new Set(['artist', 'work', 'performance', 'recording', 'release', 'album_project'])
const relationKinds = new Set([
  'credit',
  'work_recording',
  'work_performance',
  'performance_recording',
  'part'
])
const roles = new Set([
  'primary_artist',
  'producer',
  'arranger',
  'mix',
  'mastering',
  'recording_engineer',
  'vocal',
  'instrument',
  'composer',
  'lyricist',
  'conductor',
  'other'
])
const text = (v: unknown, max = 128): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0')
const uint = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const array = (v: unknown, allowed: Set<string>, max: number) =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.length <= max &&
  v.every((x) => typeof x === 'string' && allowed.has(x)) &&
  new Set(v).size === v.length
export function validMusicExplorationReference(v: unknown): v is MusicExplorationReference {
  return (
    object(v) &&
    Object.keys(v).every((k) => ['provider', 'kind', 'idType', 'value'].includes(k)) &&
    text(v.provider, 64) &&
    /^[a-z0-9][a-z0-9._-]*$/.test(v.provider) &&
    kinds.has(String(v.kind)) &&
    text(v.idType, 64) &&
    text(v.value, 8192)
  )
}
export function validMusicExplorationToken(v: unknown): v is MusicExplorationToken {
  return (
    object(v) &&
    Object.keys(v).length === 7 &&
    ['revision', 'catalogRevision', 'contentRevision', 'metadataRevision', 'asOf'].every((k) =>
      uint(v[k])
    ) &&
    text(v.contextKey, 32768) &&
    (v.expiresAt === null || (uint(v.expiresAt) && v.expiresAt > Number(v.asOf)))
  )
}
export function validMusicExplorationPayload(name: string, raw: unknown): boolean {
  if (!object(raw)) return false
  const v = raw,
    keys = (...allowed: string[]) => Object.keys(v).every((k) => allowed.includes(k))
  const page = () =>
    (v.offset === undefined || uint(v.offset)) &&
    (v.limit === undefined || (uint(v.limit) && v.limit >= 1 && v.limit <= 100)) &&
    (v.token === undefined || validMusicExplorationToken(v.token)) &&
    (v.scope === undefined || ['library', 'catalog'].includes(String(v.scope))) &&
    (v.kinds === undefined || array(v.kinds, kinds, 6))
  switch (name) {
    case 'exploration.query':
      return (
        keys('kinds', 'scope', 'search', 'offset', 'limit', 'token') &&
        page() &&
        (v.search === undefined ||
          (typeof v.search === 'string' && v.search.length <= 512 && !v.search.includes('\0')))
      )
    case 'exploration.detail':
      return (
        keys('entityId', 'token') &&
        text(v.entityId) &&
        (v.token === undefined || validMusicExplorationToken(v.token))
      )
    case 'exploration.lookup':
      return (
        keys('reference', 'token') &&
        validMusicExplorationReference(v.reference) &&
        (v.token === undefined || validMusicExplorationToken(v.token))
      )
    case 'exploration.relations':
    case 'exploration.participation':
      return (
        keys(
          'entityId',
          'token',
          'direction',
          'relations',
          'roles',
          'kinds',
          'scope',
          'offset',
          'limit'
        ) &&
        text(v.entityId) &&
        page() &&
        (v.direction === undefined ||
          (name === 'exploration.relations' &&
            ['outgoing', 'incoming', 'both'].includes(String(v.direction)))) &&
        (v.relations === undefined ||
          (name === 'exploration.relations' && array(v.relations, relationKinds, 5))) &&
        (v.roles === undefined || array(v.roles, roles, 12))
      )
    case 'exploration.performance.save':
      return (
        keys('id', 'title', 'workId', 'recordingIds', 'revision') &&
        (v.id === undefined || text(v.id)) &&
        text(v.title, 512) &&
        !!v.title.trim() &&
        text(v.workId) &&
        Array.isArray(v.recordingIds) &&
        v.recordingIds.length >= 1 &&
        v.recordingIds.length <= 200 &&
        v.recordingIds.every((x) => text(x)) &&
        uint(v.revision)
      )
    case 'exploration.performance.delete':
      return keys('id', 'revision') && text(v.id) && uint(v.revision)
    default:
      return false
  }
}
