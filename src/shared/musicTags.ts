import type { CatalogEntityReference } from './musicCatalog.ts'
import type { TrackData } from './track.ts'

/** Tags retain physical catalog references. Confirming identity never moves membership. */
export interface MusicTag {
  id: string; name: string; nameRevision: number; membersRevision: number; memberCount: number; updatedAt: number
}
export interface MusicTagsToken { tagsRevision: number; catalogRevision: number; contentRevision: number; linkRevision: number }
export interface MusicTagsPageQuery { offset?: number; limit?: number; token?: MusicTagsToken }
export interface MusicTagsListQuery extends MusicTagsPageQuery { search?: string }
export interface MusicTagsEntityQuery extends MusicTagsPageQuery { entityId: string }
export interface MusicTagsMembersQuery extends MusicTagsPageQuery { tagId: string }
export interface MusicTagsListPage { token: MusicTagsToken; offset: number; total: number; items: MusicTag[] }
export interface MusicTagsEntityPage extends MusicTagsListPage { entityId: string }
export type MusicTagMemberKind = 'recording' | 'release' | 'artist' | 'work'
export interface MusicTagMember extends Omit<CatalogEntityReference, 'kind'> {
  kind: MusicTagMemberKind; inLibrary: boolean
  /** Current available participation sources at read time, not frozen pagination or playback selection. */
  sourceCount: number
}
export interface MusicTagsMembersPage { token: MusicTagsToken; tag: MusicTag; offset: number; total: number; items: MusicTagMember[] }
export interface MusicTagRecording { recordingId: string; title: string; artist: string; sourceId: string; provider: string; sourceCount: number }
export interface MusicTagsRecordingsPage { token: MusicTagsToken; tag: MusicTag; offset: number; total: number; items: MusicTagRecording[] }
export interface MusicTagsCreate { name: string; tagsRevision: number }
export interface MusicTagsRename { tagId: string; name: string; nameRevision: number }
export interface MusicTagsDelete { tagId: string; nameRevision: number; membersRevision: number }
export interface MusicTagsMemberSet { tagId: string; entityId: string; present: boolean; membersRevision: number }
export interface MusicTagsWriteResult { token: MusicTagsToken; tag: MusicTag }
export interface MusicTagsDeleteResult { token: MusicTagsToken; deletedId: string }
export interface MusicTagsPlay { tagId: string; token: MusicTagsToken; sourceId?: string }
export interface MusicTagsPlayResult { total: number; selectedIndex: number }
/** Private transport only. Public pages never contain paths, legacy Track IDs or snapshots. */
export interface MusicTagsPlaybackPage extends Omit<MusicTagsRecordingsPage, 'items'> { items: Array<MusicTagRecording & { track: TrackData }> }
export interface MusicTagsDatabaseApi {
  tagsState(): Promise<MusicTagsToken>
  tagsList(query: MusicTagsListQuery): Promise<MusicTagsListPage>
  tagsEntity(query: MusicTagsEntityQuery): Promise<MusicTagsEntityPage>
  tagsMembers(query: MusicTagsMembersQuery): Promise<MusicTagsMembersPage>
  tagsRecordings(query: MusicTagsMembersQuery): Promise<MusicTagsRecordingsPage>
  tagsCreate(input: MusicTagsCreate, now: number): Promise<MusicTagsWriteResult>
  tagsRename(input: MusicTagsRename, now: number): Promise<MusicTagsWriteResult>
  tagsDelete(input: MusicTagsDelete): Promise<MusicTagsDeleteResult>
  tagsMemberSet(input: MusicTagsMemberSet, now: number): Promise<MusicTagsWriteResult>
  tagsPlaybackPage(query: MusicTagsMembersQuery): Promise<MusicTagsPlaybackPage>
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const uint = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) >= 0
const text = (v: unknown, max = 128): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !v.includes('\0')
export const normalizeMusicTagName = (name: string): string => name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
export const validMusicTagName = (name: unknown): name is string => text(name, 80) && normalizeMusicTagName(name).length > 0
export function validMusicTagsToken(value: unknown): value is MusicTagsToken {
  return record(value) && Object.keys(value).length === 4 && ['tagsRevision', 'catalogRevision', 'contentRevision', 'linkRevision'].every(k => uint(value[k]))
}
export function validMusicTagsPayload(name: string, value: unknown): boolean {
  if (!record(value)) return false
  const keys = (...allowed: string[]) => Object.keys(value).every(k => allowed.includes(k))
  const page = () => (value.offset === undefined || uint(value.offset)) &&
    (value.limit === undefined || (uint(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 100)) &&
    (value.token === undefined || validMusicTagsToken(value.token))
  switch (name) {
    case 'tags.list': return keys('search', 'offset', 'limit', 'token') && page() &&
      (value.search === undefined || (typeof value.search === 'string' && value.search.length <= 160 && !value.search.includes('\0')))
    case 'tags.entity': return keys('entityId', 'offset', 'limit', 'token') && text(value.entityId) && page()
    case 'tags.members': case 'tags.recordings': return keys('tagId', 'offset', 'limit', 'token') && text(value.tagId) && page()
    case 'tags.create': return keys('name', 'tagsRevision') && validMusicTagName(value.name) && uint(value.tagsRevision)
    case 'tags.rename': return keys('tagId', 'name', 'nameRevision') && text(value.tagId) && validMusicTagName(value.name) && uint(value.nameRevision)
    case 'tags.delete': return keys('tagId', 'nameRevision', 'membersRevision') && text(value.tagId) && uint(value.nameRevision) && uint(value.membersRevision)
    case 'tags.member.set': return keys('tagId', 'entityId', 'present', 'membersRevision') && text(value.tagId) && text(value.entityId) && typeof value.present === 'boolean' && uint(value.membersRevision)
    case 'tags.play': return keys('tagId', 'token', 'sourceId') && text(value.tagId) && validMusicTagsToken(value.token) && (value.sourceId === undefined || text(value.sourceId))
    default: return false
  }
}
