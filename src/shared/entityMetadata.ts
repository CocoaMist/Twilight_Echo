import type { IdentificationDatabaseApi, IdentificationInput, IdentificationRecall, IdentificationMemberSnapshot, IdentificationMemberResult } from './musicIdentification.ts'
import type { IdentificationScheduleDatabaseApi } from './musicIdentificationSchedule.ts'
import { validMetadataProvider } from './musicMetadata.ts'
import { isPublicMetadataSource } from './metadataProviders.ts'
import type { MetadataUsage } from './musicMetadata.ts'
import type { MusicCreditSet, MusicCreditsQuery, MusicCreditsPage } from './musicCredits.ts'
import type { MetadataArtworkRecord, MusicArtwork } from './musicArtwork.ts'
import { parsePersonalMusicArtwork, type PersonalMusicArtwork } from './personalMusicArtwork.ts'
import type { LegacyMusicDetail } from './legacyMusicMetadata.ts'
import type { LegacyMusicTaskDatabaseApi, LegacyMusicTaskRef, LegacyMusicTaskWork, LegacyMusicLookupResult } from './legacyMusicTasks.ts'
/** M2.1 artist vertical. These DTOs contain no file paths, provider credentials or URLs supplied by clients. */
export type EntityMetadataLanguage = 'zh-Hans' | 'zh-Hant' | 'en'
export type EntityMetadataState =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'needs_review'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'cancelled'
export interface MetadataAttribution {
  provider: string
  externalId: string
  url: string
  license: string
  licenseUrl: string
  attribution: string
  revision: string
  retrievedAt: number
}
export interface EntityMetadataFact {
  field: 'name' | 'description' | 'introduction' | 'firstReleaseDate' | 'releaseDate' | 'primaryType' | 'country' | 'barcode'
  value: string
  language: string
  sourceLanguage?: string
  rendering?: 'mediawiki-variant'
  attribution: MetadataAttribution
  usage?: MetadataUsage
  /** Restricted facts are usable only in their actual catalog source context. */
  sourceProvider?: string
  providerContext?: string
}
export interface ArtistIdentityCandidate {
  mbid: string
  name: string
  disambiguation: string
  type: string
  wikidataId: string | null
  evidence: MetadataAttribution
}
export interface EntityMetadataJob {
  id: string
  entityId: string
  type: 'resolve' | 'enrich' | 'identify' | 'legacy'
  provider: string
  language: EntityMetadataLanguage
  externalId: string
  state: EntityMetadataState
  generation: number
  attempts: number
  nextAttemptAt: number
  outcome: 'matched' | 'not_found' | 'partial' | null
  reason: string | null
  candidate: ArtistIdentityCandidate | null
  /** Stable identity candidate consumed by either review API. */
  candidateId?: string
  /** Generic recall uses the same durable queue, not the legacy artist candidate. */
  identification?: { matcherVersion: string; candidateIds: string[]; incomplete: boolean; reasons: string[];
    members?: IdentificationMemberResult[]; membersTruncated?: boolean }
  updatedAt: number
  entityKind?: import('./musicCatalog.ts').CatalogKind
  providerContext?: string
  legacy?: LegacyMusicTaskRef
  /** Internal authorization for an explicit requery generation, never a source catalog ID alias. */
  requeryConsumers?: Array<{ batchId: string; entityId: string; inputVersion: string; linkRevision: number }>
}
export interface EntityMetadataDetail {
  entityId: string
  targetId: string | null
  link: { state: 'confirmed' | 'rejected' | 'detached'; revision: number; mbid: string } | null
  revision: number
  name: string
  introduction: {
    value: string
    language: string
    origin: 'manual' | 'external' | 'imported'
    attribution: MetadataAttribution | null
  } | null
  override: { mode: 'value' | 'clear'; value: string; language: EntityMetadataLanguage } | null
  facts: EntityMetadataFact[]
  credits?: MusicCreditSet
  artwork?: MusicArtwork[]
  /** Local personal choices; never an external artwork grant or MusicBrainz reference. */
  manualArtwork?: PersonalMusicArtwork | null
  artworkOverride?: { mode: 'value' | 'clear' } | null
  sourcePreference?: { provider: string | null; available: boolean }
  sourceOptions?: string[]
  imports?: LegacyMusicDetail[]
}
export interface EntityMetadataDemand {
  entityId: string
  language: EntityMetadataLanguage
  /** Durable demand, independent of a window or connection. */
  batchId: string
  /** Omitted keeps the original explicit MusicBrainz artist path. */
  provider?: string
}
export interface EntityMetadataResolve extends EntityMetadataDemand {
  mbid: string
}
export interface EntityMetadataDecision {
  jobId: string
  generation: number
  decision: 'confirm' | 'reject'
}
export interface EntityMetadataOverride {
  entityId: string
  revision: number
  mode: 'value' | 'clear' | 'reset'
  value?: string
  language: EntityMetadataLanguage
}
export interface EntityMetadataSourcePreference {
  entityId: string
  revision: number
  provider: string | null
  language: EntityMetadataLanguage
}
export interface EntityMetadataArtworkOverride {
  entityId: string
  revision: number
  mode: 'value' | 'clear' | 'reset'
  dataUrl?: string
  language: EntityMetadataLanguage
}
export interface EntityMetadataJobsQuery {
  entityId?: string
  jobId?: string
  offset?: number
  limit?: number
}
export interface EntityMetadataPolicy {
  enabled: boolean
  publicServiceApproved: boolean
  contact: string
  wikipediaText: boolean
}
export interface EntityMetadataPolicyView {
  enabled: boolean
  identity: boolean
  introduction: boolean
  reason: string | null
  platforms?: Array<{ provider: string; kinds: Array<{ kind: 'artist' | 'release'; reason: string | null }> }>
  artwork?: Array<{ kind: 'artist' | 'release' | 'album_project'; reason: string | null }>
  /** Actual registered capabilities; selection does not grant deployment or platform permission. */
  sources?: Array<{
    provider: string
    identification: Array<{ kind: import('./musicCatalog.ts').CatalogKind; reason: string | null }>
    enrichment: Array<{ provider: string; kind: import('./musicCatalog.ts').CatalogKind; reason: string | null }>
  }>
}
/** Database-only input fence; not exposed in public DTOs. */
export interface EntityMetadataWork {
  job: EntityMetadataJob
  input: string
  legacy?: LegacyMusicTaskWork
  identification?: IdentificationInput
  identificationMembers?: IdentificationMemberSnapshot
  automatic?: { origin: 'new' | 'history'; historical: boolean }
}
export type EntityMetadataResult =
  | { state: 'legacy_result'; lookup: LegacyMusicLookupResult; taskState: 'completed' | 'needs_review' | 'retry_wait' | 'failed' | 'blocked'; outcome: 'matched' | 'partial' | 'not_found'; reason: string | null; nextAttemptAt?: number }
  | ({ state: 'identified' } & IdentificationRecall)
  | { state: 'needs_review'; candidate: ArtistIdentityCandidate | null; reason?: string }
  | {
      state: 'completed'
      outcome: 'matched' | 'not_found' | 'partial'
      facts: EntityMetadataFact[]
      credits?: MusicCreditSet
      exploration?: import('./musicExploration.ts').MusicExplorationIngest
      artwork?: MetadataArtworkRecord[]
      reason?: string
    }
  | { state: 'blocked' | 'failed' | 'retry_wait'; reason: string; nextAttemptAt?: number }
export interface EntityMetadataDatabaseApi extends IdentificationDatabaseApi, IdentificationScheduleDatabaseApi, LegacyMusicTaskDatabaseApi {
  metadataTaskSources(query: import('./entityMetadataTasks.ts').MetadataTaskSourcesQuery): Promise<import('./entityMetadataTasks.ts').MetadataTaskSourcesPage>
  metadataRequery(request: import('./entityMetadataTasks.ts').MetadataTaskRequery, contexts: Record<string, string>, now: number): Promise<{ batchId: string; jobs: EntityMetadataJob[] }>
  metadataTasks(query: import('./entityMetadataTasks.ts').MetadataTasksQuery): Promise<import('./entityMetadataTasks.ts').MetadataTasksPage>
  metadataTaskDemands(query: import('./entityMetadataTasks.ts').MetadataTaskDemandsQuery): Promise<import('./entityMetadataTasks.ts').MetadataTaskDemandsPage>
  metadataDetail(entityId: string, language: EntityMetadataLanguage, options?: EntityMetadataReadOptions): Promise<EntityMetadataDetail>
  metadataCredits(query: MusicCreditsQuery): Promise<MusicCreditsPage>
  metadataArtwork(entityId: string, options: EntityMetadataReadOptions): Promise<MetadataArtworkRecord[]>
  metadataEnqueue(
    request: EntityMetadataDemand & { type: 'resolve' | 'enrich'; mbid?: string; providerContext?: string },
    now: number
  ): Promise<EntityMetadataJob>
  metadataDecide(request: EntityMetadataDecision, now: number): Promise<EntityMetadataDetail>
  metadataDetach(entityId: string, revision: number, now: number): Promise<EntityMetadataDetail>
  metadataOverride(request: EntityMetadataOverride, now: number): Promise<EntityMetadataDetail>
  metadataSourcePreference(request: EntityMetadataSourcePreference, now: number): Promise<EntityMetadataDetail>
  metadataArtworkOverride(request: EntityMetadataArtworkOverride, now: number): Promise<EntityMetadataDetail>
  metadataJobs(
    query: EntityMetadataJobsQuery
  ): Promise<{ total: number; items: EntityMetadataJob[] }>
  metadataCancel(jobId: string, batchId: string, now: number, generation?: number): Promise<boolean>
  metadataRecover(now: number): Promise<void>
  metadataClaim(now: number): Promise<EntityMetadataWork | null>
  metadataNextAttempt(): Promise<number | null>
  metadataFinish(
    work: EntityMetadataWork,
    result: EntityMetadataResult,
    now: number,
    automation?: import('./musicIdentificationSchedule.ts').IdentificationScheduleRequest
  ): Promise<boolean>
}
/** Internal read policy; public callers may choose only an actual source context. */
export interface EntityMetadataReadOptions {
  sourceProvider?: string
  platformContexts?: Record<string, string>
  artworkContext?: string
  artworkContexts?: Record<string, string>
  artworkTargetId?: string | null
  artworkRevision?: number
  now?: number
}
const text = (v: unknown, max = 128): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0')
export const validMusicBrainzArtistId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v)
export const validMetadataLanguage = (v: unknown): v is EntityMetadataLanguage =>
  typeof v === 'string' && ['zh-Hans', 'zh-Hant', 'en'].includes(v)
export function validEntityMetadataPayload(name: string, raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const v = raw as Record<string, unknown>
  const keys = (...allowed: string[]) => Object.keys(v).every((k) => allowed.includes(k))
  const uint = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0
  switch (name) {
    case 'metadata.entity.policy':
      return keys()
    case 'metadata.entity.detail':
      return keys('entityId', 'language', 'sourceProvider', 'includeAutomaticArtwork') && text(v.entityId) && validMetadataLanguage(v.language) &&
        (v.sourceProvider === undefined || validMetadataProvider(v.sourceProvider)) &&
        (v.includeAutomaticArtwork === undefined || typeof v.includeAutomaticArtwork === 'boolean')
    case 'metadata.entity.resolve':
    case 'metadata.entity.enrich':
      return (
        keys('entityId', 'language', 'batchId', ...(name.endsWith('resolve') ? ['mbid'] : ['provider'])) &&
        text(v.entityId) &&
        text(v.batchId) &&
        validMetadataLanguage(v.language) &&
        (v.provider === undefined || v.provider === 'musicbrainz-details' || v.provider === 'public-artwork' || (typeof v.provider === 'string' && (isPublicMetadataSource(v.provider) || (/^platform\./.test(v.provider) && validMetadataProvider(v.provider.slice(9)))))) &&
        (!name.endsWith('resolve') || validMusicBrainzArtistId(v.mbid))
      )
    case 'metadata.entity.decide':
      return (
        keys('jobId', 'generation', 'decision') &&
        text(v.jobId) &&
        uint(v.generation) &&
        ['confirm', 'reject'].includes(String(v.decision))
      )
    case 'metadata.entity.detach':
      return keys('entityId', 'revision') && text(v.entityId) && uint(v.revision)
    case 'metadata.entity.override':
      return (
        keys('entityId', 'revision', 'mode', 'value', 'language') &&
        text(v.entityId) &&
        uint(v.revision) &&
        validMetadataLanguage(v.language) &&
        ['value', 'clear', 'reset'].includes(String(v.mode)) &&
        (v.mode === 'value' ? text(v.value, 20000) : v.value === undefined)
      )
    case 'metadata.entity.sourcePreference':
      return keys('entityId', 'revision', 'provider', 'language') && text(v.entityId) && uint(v.revision) &&
        validMetadataLanguage(v.language) && (v.provider === null || validMetadataProvider(v.provider))
    case 'metadata.entity.artworkOverride':
      return keys('entityId', 'revision', 'mode', 'dataUrl', 'language') && text(v.entityId) && uint(v.revision) &&
        validMetadataLanguage(v.language) && ['value', 'clear', 'reset'].includes(String(v.mode)) &&
        (v.mode === 'value' ? !!parsePersonalMusicArtwork(v.dataUrl) : v.dataUrl === undefined)
    case 'metadata.entity.jobs':
      return (
        keys('entityId', 'jobId', 'offset', 'limit') &&
        (v.entityId === undefined || text(v.entityId)) &&
        (v.jobId === undefined || text(v.jobId)) &&
        (v.offset === undefined || uint(v.offset)) &&
        (v.limit === undefined || (uint(v.limit) && Number(v.limit) >= 1 && Number(v.limit) <= 100))
      )
    case 'metadata.entity.credits':
      return keys('entityId', 'entityRevision', 'offset', 'limit', 'revision') && text(v.entityId) &&
        (v.entityRevision === undefined || uint(v.entityRevision)) &&
        (v.offset === undefined || uint(v.offset)) &&
        (v.limit === undefined || (uint(v.limit) && Number(v.limit) >= 1 && Number(v.limit) <= 200)) &&
        (v.revision === undefined || text(v.revision, 2048))
    case 'metadata.entity.cancel':
      return keys('jobId', 'batchId', 'generation') && text(v.jobId) && text(v.batchId) &&
        (v.generation === undefined || uint(v.generation))
    default:
      return false
  }
}
