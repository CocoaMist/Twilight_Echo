import type { CatalogEntityReference } from './musicCatalog.ts'
import type { TrackData } from './track.ts'
import type { Playlist } from './playlists.ts'
import type { VersionedDataEnvelope } from './versionedPersistence.ts'

export type MusicPreferenceKind = 'recording' | 'release' | 'artist' | 'work'
export type MusicPreferenceState = 'none' | 'favorite' | 'ban'
/** null value means never set; state=none is an explicit clearing receipt. */
export interface MusicPreferenceValue { state: MusicPreferenceState; revision: number; updatedAt: number }
export interface MusicPreferencesToken { preferencesRevision: number; linkRevision: number; targetKey: string }
export interface MusicPreferencesDetail {
  entityId: string; kind: MusicPreferenceKind; scope: 'entity' | 'identity'
  value: MusicPreferenceValue | null; token: MusicPreferencesToken
}
export interface MusicPreferencesSet { entityId: string; token: MusicPreferencesToken; state: MusicPreferenceState }
export interface MusicPreferencesTargetsQuery {
  entityId: string; offset?: number; limit?: number; trackContext?: { provider: string; id: string }
}
export interface MusicPreferencesTargetsPage { entityId: string; offset: number; total: number; items: Array<Omit<CatalogEntityReference, 'kind'> & { kind: MusicPreferenceKind }> }
export interface MusicPreferencesHistoryQuery { entityId: string; offset?: number; limit?: number }
export type MusicPreferenceChangeReason = 'set' | 'clear' | 'legacy_favorite' | 'playlist_favorite' | 'playlist_unfavorite' | 'identity_carry' | 'identity_current' | 'identity_clear'
export interface MusicPreferencesHistoryPage {
  entityId: string; kind: MusicPreferenceKind; scope: 'entity' | 'identity'; offset: number; total: number
  items: Array<MusicPreferenceValue & { seq: number; reason: MusicPreferenceChangeReason }>
}
export interface MusicPreferenceImpact {
  revision: number; current: MusicPreferenceValue | null; target: MusicPreferenceValue | null
  conflict: boolean; action: 'keep' | 'carry' | 'share' | 'choose'
  related?: Array<{ entityId: string; title: string; value: MusicPreferenceValue }>
}
export interface MusicPreferenceResolution { revision: number; choice: 'current' | 'target' | 'clear' | `related:${string}` }
export interface MusicPreferencesMigrationReceipt {
  sourceRevision: number; defaultPlaylistId: string; migratedAt: number
  rawRowCount: number; logicalMemberCount: number | null; resolvedRowCount: number; unresolvedRowCount: number
  items: Array<{ position: number; trackId: string; status: 'resolved'; sourceId: string; recordingId: string; targetKey: string } |
    { position: number; trackId: string; status: 'unresolved'; reason: 'missing_track' | 'unsupported_source' }>
}
export interface MusicPreferencesDatabaseApi {
  preferencesTargets(query: MusicPreferencesTargetsQuery): Promise<MusicPreferencesTargetsPage>
  preferencesDetail(entityId: string): Promise<MusicPreferencesDetail>
  preferencesSet(request: MusicPreferencesSet, now: number): Promise<MusicPreferencesDetail>
  preferencesHistory(query: MusicPreferencesHistoryQuery): Promise<MusicPreferencesHistoryPage>
  /** Private automatic-selection gate. Reads precise source/native identities, never imports candidates. */
  preferencesAutomaticEligibility(tracks: TrackData[]): Promise<boolean[]>
  preferencesTrackStates(tracks: TrackData[]): Promise<Array<MusicPreferenceState | null>>
  preferencesPlaylistsLoad(): Promise<VersionedDataEnvelope<Playlist[]> | null>
  preferencesPlaylistsMigrate(envelope: VersionedDataEnvelope<Playlist[]>, now: number, audit?: { logicalMemberCount: number }): Promise<VersionedDataEnvelope<Playlist[]>>
  preferencesPlaylistsMigrationReceipt(): Promise<MusicPreferencesMigrationReceipt | null>
  preferencesPlaylistsSave(data: Playlist[], expectedRevision: number, now: number): Promise<VersionedDataEnvelope<Playlist[]>>
  preferencesPlaylistsRestore(data: Playlist[], restoreId: string, expectedRevision: number, now: number): Promise<VersionedDataEnvelope<Playlist[]>>
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max = 128): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !v.includes('\0')
const uint = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) >= 0
export const validMusicPreferenceState = (v: unknown): v is MusicPreferenceState => v === 'none' || v === 'favorite' || v === 'ban'
export function validMusicPreferenceChoice(choice: unknown, impact?: MusicPreferenceImpact): choice is MusicPreferenceResolution['choice'] {
  if (typeof choice !== 'string') return false
  if (['current', 'target', 'clear'].includes(choice)) return true
  return choice.startsWith('related:') && text(choice.slice(8)) &&
    (!impact || !!impact.related?.some(value => value.entityId === choice.slice(8)))
}
export function validMusicPreferenceResolution(v: unknown): v is MusicPreferenceResolution {
  return record(v) && Object.keys(v).length === 2 && uint(v.revision) && validMusicPreferenceChoice(v.choice)
}
export function validMusicPreferencesPayload(name: string, raw: unknown): boolean {
  if (!record(raw)) return false
  const keys = (...allowed: string[]) => Object.keys(raw).every(k => allowed.includes(k))
  const page = () => (raw.offset === undefined || uint(raw.offset)) &&
    (raw.limit === undefined || (uint(raw.limit) && Number(raw.limit) >= 1 && Number(raw.limit) <= 100))
  switch (name) {
    case 'preferences.detail': return keys('entityId') && text(raw.entityId)
    case 'preferences.set': return keys('entityId', 'token', 'state') && text(raw.entityId) && validMusicPreferenceState(raw.state) &&
      record(raw.token) && Object.keys(raw.token).length === 3 && uint(raw.token.preferencesRevision) && uint(raw.token.linkRevision) && text(raw.token.targetKey, 512)
    case 'preferences.history': return keys('entityId', 'offset', 'limit') && text(raw.entityId) && page()
    case 'preferences.targets': return keys('entityId', 'offset', 'limit', 'trackContext') && text(raw.entityId) && page() &&
      (raw.trackContext === undefined || (record(raw.trackContext) && Object.keys(raw.trackContext).length === 2 &&
        typeof raw.trackContext.provider === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(raw.trackContext.provider) && text(raw.trackContext.id, 8192)))
    default: return false
  }
}
