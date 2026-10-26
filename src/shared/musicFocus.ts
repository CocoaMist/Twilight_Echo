import type { TrackData } from './track.ts'
import type { ClassificationDimension } from './musicClassificationDimensions.ts'
import { validClassificationDimension } from './musicClassificationDimensions.ts'
import { MAX_GENRE_ID_LENGTH } from './musicGenres.ts'

export interface MusicFocusNumber { eq?: number; gte?: number; lte?: number; exists?: boolean }
export interface MusicFocusSource {
  provider?: string; format?: string; bitDepth?: MusicFocusNumber; sampleRate?: MusicFocusNumber
}
export type MusicFocusNode =
  | { all: MusicFocusNode[] } | { any: MusicFocusNode[] } | { not: MusicFocusNode }
  | { genre: { id: string; includeDescendants?: boolean } }
  | { source: MusicFocusSource }
  | { rating: { target: 'self'; mode: 'personal' | 'base' | 'effective'; provider?: string; gteStars?: number; lteStars?: number; exists?: boolean } }
  | { tag: { id: string } }
  | { year: MusicFocusNumber & { target: 'release' | 'project' } }
  | { preference: 'none' | 'favorite' | 'ban' }
  | { automaticPlaybackBlocked: boolean }
  | { lastPlayed: MusicFocusNumber }
  | { notPlayedWithinDays: number }
  | { classification: { dimension: ClassificationDimension; values: string[] } }
  | { text: string }
export type MusicFocusSortField = 'title' | 'artist' | 'personalRating' | 'lastPlayed' | 'releaseYear'
export interface MusicFocusQuery {
  version: 1; entity: 'recording' | 'release'; scope?: 'library' | 'catalog'; where?: MusicFocusNode
  sort?: Array<{ field: MusicFocusSortField; direction: 'asc' | 'desc' }>
}
export interface MusicFocusState {
  savedRevision: number; catalogRevision: number; contentRevision: number; genresRevision: number
  metadataRevision: number; ratingsRevision: number; preferencesRevision: number; tagsRevision: number
  linkRevision: number; historyRevision: number
}
export interface MusicFocusToken extends MusicFocusState {
  queryKey: string; asOf: number; contextKey: string; expiresAt: number | null
}
/** Internal Core/database authorization context, never accepted from a public request. */
export interface MusicFocusReadContext { platformContexts?: Record<string, string> }
export interface MusicFocusPageQuery { query: MusicFocusQuery; offset?: number; limit?: number; token?: MusicFocusToken }
/** Private queue input. An anchor may select only an already-matched in-library source. */
export interface MusicFocusPlaybackPageQuery extends MusicFocusPageQuery { anchorSourceId?: string }
export interface MusicFocusItem {
  id: string; kind: 'recording' | 'release'; title: string; artist: string; sourceCount: number
  inLibrary: boolean; playable: boolean; sourceId: string | null; provider: string | null
  personalRating: number | null; lastPlayed: number | null; releaseYear: number | null
}
export interface MusicFocusPage { token: MusicFocusToken; offset: number; total: number; items: MusicFocusItem[] }
export type MusicFocusFacet = 'genre' | 'provider' | 'personalRating' | 'preference' | ClassificationDimension
export interface MusicFocusFacetsQuery extends MusicFocusPageQuery { facet: MusicFocusFacet }
export interface MusicFocusFacetItem { value: string; label: string; count: number }
export interface MusicFocusFacetsPage { token: MusicFocusToken; facet: MusicFocusFacet; offset: number; total: number; items: MusicFocusFacetItem[] }
export interface MusicFocusSaved {
  id: string; name: string; query: MusicFocusQuery; nameRevision: number; queryRevision: number; updatedAt: number
}
export interface MusicFocusSavedListQuery { offset?: number; limit?: number; search?: string; savedRevision?: number }
export interface MusicFocusSavedPage { savedRevision: number; offset: number; total: number; items: MusicFocusSaved[] }
export interface MusicFocusCreate { name: string; query: MusicFocusQuery; savedRevision: number }
export interface MusicFocusRename { id: string; name: string; nameRevision: number }
export interface MusicFocusUpdate { id: string; query: MusicFocusQuery; queryRevision: number }
export interface MusicFocusDelete { id: string; nameRevision: number; queryRevision: number }
export interface MusicFocusWriteResult { savedRevision: number; item: MusicFocusSaved }
export interface MusicFocusDeleteResult { savedRevision: number; deletedId: string }
export interface MusicFocusPlay { query: MusicFocusQuery; token: MusicFocusToken; sourceId?: string }
export interface MusicFocusPlayResult { total: number; selectedIndex: number }
export interface MusicFocusPlayStatusQuery { requestId: string; epoch: string }
/** Queue adoption is separate from native acknowledgement; failed means the call rejected,
 * including a lost native reply, and does not prove that playback never started. */
export type MusicFocusPlayStatus =
  | { status: 'pending' }
  | { status: 'not_committed' }
  | { status: 'committed'; result: MusicFocusPlayResult; playback: 'pending' | 'confirmed' | 'failed' }
  | { status: 'unknown' }
export interface MusicFocusPlaybackItem { recordingId: string; sourceId: string; provider: string; track: TrackData }
/** Private transport only; never return tracks or file paths on public Focus pages. */
export interface MusicFocusPlaybackPage { token: MusicFocusToken; offset: number; total: number; items: MusicFocusPlaybackItem[] }
export interface MusicFocusDatabaseApi {
  focusState(): Promise<MusicFocusState>
  focusQuery(query: MusicFocusPageQuery, context?: MusicFocusReadContext): Promise<MusicFocusPage>
  focusFacets(query: MusicFocusFacetsQuery, context?: MusicFocusReadContext): Promise<MusicFocusFacetsPage>
  focusPlaybackPage(query: MusicFocusPlaybackPageQuery, context?: MusicFocusReadContext): Promise<MusicFocusPlaybackPage>
  focusSavedList(query: MusicFocusSavedListQuery): Promise<MusicFocusSavedPage>
  focusSavedCreate(input: MusicFocusCreate, now: number): Promise<MusicFocusWriteResult>
  focusSavedRename(input: MusicFocusRename, now: number): Promise<MusicFocusWriteResult>
  focusSavedUpdate(input: MusicFocusUpdate, now: number): Promise<MusicFocusWriteResult>
  focusSavedDelete(input: MusicFocusDelete): Promise<MusicFocusDeleteResult>
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const uint = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const text = (v: unknown, max = 128): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !v.includes('\0')
const keys = (v: Record<string, unknown>, ...names: string[]) => Object.keys(v).every(k => names.includes(k))
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER
function number(v: unknown, extra: string[] = []): boolean {
  return record(v) && keys(v, 'eq', 'gte', 'lte', 'exists', ...extra) &&
    ['eq', 'gte', 'lte', 'exists'].some(k => v[k] !== undefined) &&
    ['eq', 'gte', 'lte'].every(k => v[k] === undefined || finite(v[k])) &&
    (v.exists === undefined || typeof v.exists === 'boolean') &&
    !(v.exists === false && ['eq', 'gte', 'lte'].some(k => v[k] !== undefined))
}
export const normalizeMusicFocusName = (v: string): string => v.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
export function validMusicFocusQuery(value: unknown): value is MusicFocusQuery {
  if (!record(value) || !keys(value, 'version', 'entity', 'scope', 'where', 'sort') || value.version !== 1 ||
    !['recording', 'release'].includes(String(value.entity)) || (value.scope !== undefined && !['library', 'catalog'].includes(String(value.scope)))) return false
  let leaves = 0, nodes = 0
  const node = (v: unknown, depth: number): boolean => {
    if (++nodes > 512 || depth > 8 || !record(v) || Object.keys(v).length !== 1) return false
    if ('all' in v || 'any' in v) { const children = v.all ?? v.any; return Array.isArray(children) && children.length <= 64 && children.every(c => node(c, depth + 1)) }
    if ('not' in v) return node(v.not, depth + 1)
    if (++leaves > 64) return false
    if ('genre' in v) return record(v.genre) && keys(v.genre, 'id', 'includeDescendants') && text(v.genre.id, MAX_GENRE_ID_LENGTH) && (v.genre.includeDescendants === undefined || typeof v.genre.includeDescendants === 'boolean')
    if ('source' in v) return record(v.source) && keys(v.source, 'provider', 'format', 'bitDepth', 'sampleRate') && Object.keys(v.source).length > 0 &&
      (v.source.provider === undefined || text(v.source.provider)) && (v.source.format === undefined || text(v.source.format, 64)) &&
      (v.source.bitDepth === undefined || number(v.source.bitDepth)) && (v.source.sampleRate === undefined || number(v.source.sampleRate))
    if ('rating' in v) {
      const rating = v.rating
      return record(rating) && keys(rating, 'target', 'mode', 'provider', 'gteStars', 'lteStars', 'exists') && rating.target === 'self' &&
        ['personal', 'base', 'effective'].includes(String(rating.mode)) && (rating.provider === undefined || text(rating.provider)) &&
        ['gteStars', 'lteStars'].every(k => rating[k] === undefined || (finite(rating[k]) && Number(rating[k]) <= 5)) &&
        (rating.exists === undefined || typeof rating.exists === 'boolean') &&
        ['gteStars', 'lteStars', 'exists'].some(k => rating[k] !== undefined) &&
        !(rating.exists === false && (rating.gteStars !== undefined || rating.lteStars !== undefined))
    }
    if ('tag' in v) return record(v.tag) && keys(v.tag, 'id') && text(v.tag.id)
    if ('year' in v) return record(v.year) && ['release', 'project'].includes(String(v.year.target)) && number(v.year, ['target'])
    if ('preference' in v) return ['none', 'favorite', 'ban'].includes(String(v.preference))
    if ('automaticPlaybackBlocked' in v) return typeof v.automaticPlaybackBlocked === 'boolean'
    if ('lastPlayed' in v) return number(v.lastPlayed)
    if ('notPlayedWithinDays' in v) return finite(v.notPlayedWithinDays) && v.notPlayedWithinDays <= 365000
    if ('classification' in v) return record(v.classification) && keys(v.classification, 'dimension', 'values') && validClassificationDimension(v.classification.dimension) &&
      Array.isArray(v.classification.values) && v.classification.values.length >= 1 && v.classification.values.length <= 64 && v.classification.values.every(x => text(x))
    if ('text' in v) return text(v.text, 512)
    return false
  }
  return (value.where === undefined || node(value.where, 1)) && (value.sort === undefined || (Array.isArray(value.sort) && value.sort.length >= 1 && value.sort.length <= 5 &&
    value.sort.every(s => record(s) && keys(s, 'field', 'direction') && ['title', 'artist', 'personalRating', 'lastPlayed', 'releaseYear'].includes(String(s.field)) && ['asc', 'desc'].includes(String(s.direction))) &&
    new Set(value.sort.map(s => s.field)).size === value.sort.length))
}
const STATE_KEYS = ['savedRevision', 'catalogRevision', 'contentRevision', 'genresRevision', 'metadataRevision', 'ratingsRevision', 'preferencesRevision', 'tagsRevision', 'linkRevision', 'historyRevision'] as const
export function validMusicFocusToken(v: unknown): v is MusicFocusToken {
  return record(v) && Object.keys(v).length === 14 && STATE_KEYS.every(k => uint(v[k])) && uint(v.asOf) && text(v.queryKey, 1048576) && text(v.contextKey) &&
    (v.expiresAt === null || (uint(v.expiresAt) && v.expiresAt > v.asOf))
}
export const sameFocusToken = (a: MusicFocusToken, b: MusicFocusToken): boolean => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k as keyof MusicFocusToken] === b[k as keyof MusicFocusToken])
export const sameFocusState = (a: MusicFocusState, b: MusicFocusState): boolean => STATE_KEYS.every(k => a[k] === b[k])
/** Canonical JSON is a query identity, not a hash or authorization token. */
export function musicFocusQueryKey(query: MusicFocusQuery): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : record(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
  return JSON.stringify(canonical({ ...query, scope: query.scope ?? 'library' }))
}
export function validMusicFocusPayload(name: string, v: unknown): boolean {
  if (!record(v)) return false
  const page = () => (v.offset === undefined || uint(v.offset)) && (v.limit === undefined || (uint(v.limit) && v.limit >= 1 && v.limit <= 200))
  const query = () => validMusicFocusQuery(v.query) && page() && (v.token === undefined || validMusicFocusToken(v.token))
  const validName = () => text(v.name, 80) && !!normalizeMusicFocusName(v.name)
  switch (name) {
    case 'focus.play.status': return keys(v, 'requestId', 'epoch') && text(v.requestId, 256) && text(v.epoch, 256)
    case 'focus.query': return keys(v, 'query', 'offset', 'limit', 'token') && query()
    case 'focus.facets': return keys(v, 'query', 'offset', 'limit', 'token', 'facet') && query() && (['genre', 'provider', 'personalRating', 'preference'].includes(String(v.facet)) || validClassificationDimension(v.facet))
    case 'focus.play': return keys(v, 'query', 'token', 'sourceId') && validMusicFocusQuery(v.query) && validMusicFocusToken(v.token) && (v.sourceId === undefined || text(v.sourceId))
    case 'focus.saved.list': return keys(v, 'offset', 'limit', 'search', 'savedRevision') && page() && (v.savedRevision === undefined || uint(v.savedRevision)) && (v.search === undefined || (typeof v.search === 'string' && v.search.length <= 160 && !v.search.includes('\0')))
    case 'focus.saved.create': return keys(v, 'name', 'query', 'savedRevision') && validName() && validMusicFocusQuery(v.query) && uint(v.savedRevision)
    case 'focus.saved.rename': return keys(v, 'id', 'name', 'nameRevision') && text(v.id) && validName() && uint(v.nameRevision)
    case 'focus.saved.update': return keys(v, 'id', 'query', 'queryRevision') && text(v.id) && validMusicFocusQuery(v.query) && uint(v.queryRevision)
    case 'focus.saved.delete': return keys(v, 'id', 'nameRevision', 'queryRevision') && text(v.id) && uint(v.nameRevision) && uint(v.queryRevision)
    default: return false
  }
}
export function validMusicFocusPlaybackPageQuery(value: unknown): value is MusicFocusPlaybackPageQuery {
  if (!record(value)) return false
  const { anchorSourceId, ...page } = value
  return (anchorSourceId === undefined || text(anchorSourceId)) && validMusicFocusPayload('focus.query', page)
}
