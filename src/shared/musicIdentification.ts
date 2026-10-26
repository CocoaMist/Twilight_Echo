import type { CatalogKind, CatalogEntityReference } from './musicCatalog.ts'
import type { TrackIdentityTags } from './trackIdentification.ts'
import type { TrackArtistRef } from './track.ts'
import type { PlatformAlbumIdentity } from './musicPlatformAlbum.ts'
import { validMusicRatingResolution, type MusicRatingImpact, type MusicRatingResolution } from './musicRatings.ts'
import { validMusicPreferenceResolution, type MusicPreferenceImpact, type MusicPreferenceResolution } from './musicPreferences.ts'

/** Internal identities do not require any particular metadata provider. */
export interface MusicExternalReference {
  provider: string
  kind: CatalogKind
  idType: string
  value: string
}
export interface IdentificationEvidence {
  origin: 'explicit_id' | 'provider_native' | 'search' | 'cross_reference' | 'album_tracks'
  matches: string[]
  missing: string[]
  conflicts: string[]
  /** A truncated response must never be interpreted as a unique match. */
  incomplete: boolean
  provenance: string
  /** Private adapters supply structured proof; display match labels are not authority. */
  verification?: IdentificationVerification
}
export interface IdentificationAlbumTrack {
  disc: number
  position: number
  title: string
  artists: Array<{ name: string; id?: string }>
  duration: number
  recordingId?: string
  releaseTrackId?: string
  isrcs: string[]
}
export interface IdentificationAlbumRelease {
  id: string
  projectId: string
  title: string
  artists: Array<{ name: string; id?: string }>
  barcode: string
  catalogNumbers: string[]
  /** Expected count per disc, independently reported by the service. */
  discTrackCounts: number[]
  tracks: IdentificationAlbumTrack[]
}
export interface IdentificationArtistRecording {
  id: string
  title: string
  duration: number
  artists: Array<{ id: string; name: string }>
  albums: string[]
}
export type IdentificationVerification =
  | { method: 'typed_id' | 'provider_native' | 'file_native'; reference: MusicExternalReference; sourceIds: string[] }
  | { method: 'platform_recordings'; reference: MusicExternalReference; sourceIds: string[];
      samples: Array<{ sourceId: string; page: import('./musicPlatformRecording.ts').PlatformRecordingPage }> }
  | {
      method: 'artist_recordings'
      reference: MusicExternalReference
      sourceIds: string[]
      samples: Array<{ sourceId: string; recordings: IdentificationArtistRecording[] }>
      toleranceSeconds: 2
    }
  | {
      /** A partial import proves the project only, never its pressing or child IDs. */
      method: 'album_subset'
      reference: MusicExternalReference
      sourceIds: string[]
      release: IdentificationAlbumRelease
      toleranceSeconds: 2
    }
  | {
      method: 'platform_album_tracks'
      reference: MusicExternalReference
      sourceIds: string[]
      album: PlatformAlbumIdentity
      matchedAlbumIds: string[]
      toleranceSeconds: 2
    }
  | {
      method: 'album_tracks'
      reference: MusicExternalReference
      sourceIds: string[]
      release: IdentificationAlbumRelease
      matchedReleaseIds: string[]
      /** All matching pressings, needed before propagating any child identity. */
      matchedReleases?: IdentificationAlbumRelease[]
      toleranceSeconds: 2
    }
  | {
      /** Database-derived relation, never accepted as an adapter's automatic proof. */
      method: 'album_member'
      reference: MusicExternalReference
      sourceIds: string[]
      parent: {
        entityId: string
        candidateId: string
        historySeq: number
        linkRevision: number
      }
    }

/** Captured with the album claim; not refreshed after remote work completes. */
export interface IdentificationMemberSnapshot {
  items: Array<{ entityId: string; kind: 'artist' | 'recording'; inputStamp: string; linkRevision: number }>
  truncated: boolean
}
export interface IdentificationMemberResult {
  entityId: string
  state: 'confirmed' | 'needs_review' | 'skipped'
  candidateIds: string[]
  reason: string | null
}
export interface MusicIdentityLink {
  id: string
  entityId: string
  kind: CatalogKind
  revision: number
  targetId: string | null
  state: 'unresolved' | 'confirmed' | 'detached'
  confirmation?: { mode: 'automatic' | 'manual' | 'legacy'; rule?: IdentificationVerification['method'] }
}
export interface IdentificationCandidate {
  id: string
  entityId: string
  kind: CatalogKind
  provider: string
  name: string
  summary: string
  references: MusicExternalReference[]
  evidence: IdentificationEvidence
  matcherVersion: string
  inputVersion: string
  linkRevision: number
  revision: number
  state: 'candidate' | 'confirmed' | 'rejected'
  suppressed: boolean
  createdAt: number
  updatedAt: number
}
export interface MusicIdentityDetail {
  entityId: string
  kind: CatalogKind
  link: MusicIdentityLink | null
  references: MusicExternalReference[]
}
export interface IdentificationCandidatesQuery {
  entityId: string
  state?: IdentificationCandidate['state']
  offset?: number
  limit?: number
}
export interface IdentificationInboxQuery {
  kind?: CatalogKind
  state?: IdentificationCandidate['state']
  unresolvedOnly?: boolean
  offset?: number
  limit?: number
}
export interface IdentificationInboxPage {
  total: number
  offset: number
  items: Array<{ entity: CatalogEntityReference; candidateCount: number;
    sample: { provider: string; title: string; album: string } | null }>
}
export interface IdentificationReview {
  candidateId: string
  revision: number
  linkRevision: number
}
export interface IdentificationDecision extends IdentificationReview {
  decision: 'confirm' | 'reject'
  /** Manual NCM fallback attachment; preserves the currently confirmed target. */
  attachToCurrent?: true
  ratingResolution?: MusicRatingResolution
  preferenceResolution?: MusicPreferenceResolution
}
export interface IdentificationPreview {
  candidate: IdentificationCandidate
  current: MusicIdentityDetail
  proposedTargetId: string | null
  action: 'link' | 'replace' | 'keep'
  stale: boolean
  conflicts: string[]
  canConfirm: boolean
  canAttachToCurrent?: boolean
  ratingImpact?: MusicRatingImpact
  preferenceImpact?: MusicPreferenceImpact
}
export interface IdentificationHistoryQuery {
  entityId: string
  offset?: number
  limit?: number
}
export interface IdentificationHistoryItem {
  seq: number
  state: 'confirmed' | 'replaced' | 'rejected' | 'detached'
  changedAt: number
  targetId: string | null
  name: string
  /** IDs captured by this decision, not a newly recalled candidate. */
  references: MusicExternalReference[]
  hasSnapshot: boolean
  restoredFrom: number | null
}
export interface IdentificationHistoryPage {
  entityId: string
  inputVersion: string
  current: MusicIdentityDetail
  offset: number
  total: number
  items: IdentificationHistoryItem[]
}
/** An explicit comparison is required before restoring a historical decision. */
export interface IdentificationHistoryReview {
  entityId: string
  historySeq: number
  linkRevision: number
  inputVersion: string
  ratingResolution?: MusicRatingResolution
  preferenceResolution?: MusicPreferenceResolution
}
export interface IdentificationRestorePreview {
  request: IdentificationHistoryReview
  history: IdentificationHistoryItem
  current: MusicIdentityDetail
  /** All references the historical target currently owns, shown before restoring. */
  references: MusicExternalReference[]
  action: 'link' | 'replace' | 'keep'
  stale: boolean
  conflicts: string[]
  canRestore: boolean
  ratingImpact?: MusicRatingImpact
  preferenceImpact?: MusicPreferenceImpact
}
/** Private Core/database contract. Clients may select candidates, never upload them. */
export interface IdentificationSourceInput {
  sourceId: string
  provider: string
  trackId: string
  title: string
  artist: string
  album: string
  albumArtist: string
  albumId?: string
  artists: TrackArtistRef[]
  /** Positions proved by catalog aliases, not by matching display names. */
  artistIndexes: number[]
  /** Existing display duration. Matching uses tags.durationSeconds when available. */
  duration: number
  discNumber?: number
  trackNumber?: number
  isrc?: string
  tags: TrackIdentityTags
  /** Opaque, input-local directory cohort; never a path or a completeness claim. */
  albumCohort?: string
}
export interface IdentificationInput {
  entityId: string
  kind: CatalogKind
  version: string
  linkRevision: number
  name: string
  artist: string
  sources?: IdentificationSourceInput[]
  sourcesTruncated?: boolean
}
export interface IdentificationProposal {
  provider: string
  name: string
  summary: string
  references: MusicExternalReference[]
  evidence: IdentificationEvidence
  matcherVersion: string
}
/** An explicit request for an indexed entity; never a whole-library backfill. */
export interface IdentificationStart {
  entityId: string
  /** Caller-stable demand ID makes retries and cancellation unambiguous. */
  batchId: string
}
export interface IdentificationRecall {
  proposals: IdentificationProposal[]
  incomplete: boolean
  reasons: string[]
}
/** Private queue request, resolved by Core from its installed adapters. */
export interface IdentificationEnqueue extends IdentificationStart {
  providers: Array<{ id: string; matcherVersion: string }>
}
export interface IdentificationDatabaseApi {
  identificationEnqueue(request: IdentificationEnqueue, now: number): Promise<import('./entityMetadata.ts').EntityMetadataJob[]>
  identificationInput(entityId: string): Promise<IdentificationInput>
  identificationPublish(
    input: IdentificationInput,
    proposals: IdentificationProposal[],
    now: number
  ): Promise<IdentificationCandidate[]>
  identificationDetail(entityId: string): Promise<MusicIdentityDetail>
  identificationCandidates(
    query: IdentificationCandidatesQuery
  ): Promise<{ total: number; items: IdentificationCandidate[] }>
  identificationInbox(query: IdentificationInboxQuery): Promise<IdentificationInboxPage>
  identificationPreview(request: IdentificationReview): Promise<IdentificationPreview>
  identificationDecide(request: IdentificationDecision, now: number): Promise<MusicIdentityDetail>
  identificationDetach(linkId: string, revision: number, now: number): Promise<MusicIdentityDetail>
  identificationHistory(query: IdentificationHistoryQuery): Promise<IdentificationHistoryPage>
  identificationRestorePreview(request: IdentificationHistoryReview): Promise<IdentificationRestorePreview>
  identificationRestore(request: IdentificationHistoryReview, now: number): Promise<MusicIdentityDetail>
}

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max = 128): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0')
const uint = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
export const validIdentificationKind = (v: unknown): v is CatalogKind =>
  ['artist', 'recording', 'album_project', 'release'].includes(String(v))
export function validMusicExternalReference(raw: unknown): raw is MusicExternalReference {
  if (!record(raw)) return false
  return (
    Object.keys(raw).every((k) => ['provider', 'kind', 'idType', 'value'].includes(k)) &&
    text(raw.provider) &&
    /^[a-z0-9][a-z0-9._-]*$/i.test(raw.provider) &&
    validIdentificationKind(raw.kind) &&
    text(raw.idType, 64) &&
    /^[a-z0-9][a-z0-9._-]*$/i.test(raw.idType) &&
    text(raw.value, 512) &&
    (String(raw.provider).toLowerCase() !== 'musicbrainz' ||
      (String(raw.idType).toLowerCase() === 'mbid' &&
        /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(raw.value)))
  )
}
export function validIdentificationPayload(name: string, raw: unknown): boolean {
  if (!record(raw)) return false
  const keys = (...allowed: string[]) => Object.keys(raw).every((k) => allowed.includes(k))
  const review = () => text(raw.candidateId) && uint(raw.revision) && uint(raw.linkRevision)
  switch (name) {
    case 'identification.status':
      return keys()
    case 'identification.start':
      return keys('entityId', 'batchId') && text(raw.entityId) && text(raw.batchId)
    case 'identification.detail':
      return keys('entityId') && text(raw.entityId)
    case 'identification.history':
      return keys('entityId', 'offset', 'limit') && text(raw.entityId) &&
        (raw.offset === undefined || uint(raw.offset)) &&
        (raw.limit === undefined || (uint(raw.limit) && Number(raw.limit) >= 1 && Number(raw.limit) <= 100))
    case 'identification.restorePreview':
    case 'identification.restore':
      return keys('entityId', 'historySeq', 'linkRevision', 'inputVersion', 'ratingResolution', 'preferenceResolution') && text(raw.entityId) &&
        uint(raw.historySeq) && Number(raw.historySeq) > 0 && uint(raw.linkRevision) &&
        text(raw.inputVersion, 16384) && (raw.ratingResolution === undefined || validMusicRatingResolution(raw.ratingResolution)) &&
        (raw.preferenceResolution === undefined || validMusicPreferenceResolution(raw.preferenceResolution))
    case 'identification.inbox':
      return keys('kind', 'state', 'unresolvedOnly', 'offset', 'limit') &&
        (raw.kind === undefined || validIdentificationKind(raw.kind)) &&
        (raw.state === undefined || ['candidate', 'confirmed', 'rejected'].includes(String(raw.state))) &&
        (raw.unresolvedOnly === undefined || typeof raw.unresolvedOnly === 'boolean') &&
        (raw.offset === undefined || uint(raw.offset)) &&
        (raw.limit === undefined || (uint(raw.limit) && Number(raw.limit) >= 1 && Number(raw.limit) <= 100))
    case 'identification.candidates':
      return (
        keys('entityId', 'state', 'offset', 'limit') &&
        text(raw.entityId) &&
        (raw.state === undefined ||
          ['candidate', 'confirmed', 'rejected'].includes(String(raw.state))) &&
        (raw.offset === undefined || uint(raw.offset)) &&
        (raw.limit === undefined ||
          (uint(raw.limit) && Number(raw.limit) >= 1 && Number(raw.limit) <= 100))
      )
    case 'identification.preview':
      return keys('candidateId', 'revision', 'linkRevision') && review()
    case 'identification.decide':
      return (
        keys('candidateId', 'revision', 'linkRevision', 'decision', 'attachToCurrent', 'ratingResolution', 'preferenceResolution') &&
        review() &&
        ['confirm', 'reject'].includes(String(raw.decision)) &&
        (raw.attachToCurrent === undefined || (raw.attachToCurrent === true && raw.decision === 'confirm' &&
          raw.ratingResolution === undefined && raw.preferenceResolution === undefined)) &&
        (raw.ratingResolution === undefined || validMusicRatingResolution(raw.ratingResolution)) &&
        (raw.preferenceResolution === undefined || validMusicPreferenceResolution(raw.preferenceResolution))
      )
    case 'identification.detach':
      return keys('linkId', 'revision') && text(raw.linkId) && uint(raw.revision)
    default:
      return false
  }
}
