import type { GenreTarget } from './musicGenres.ts'
import { MAX_GENRE_ID_LENGTH } from './musicGenres.ts'
import type {
  ClassificationFacetItem,
  ClassificationFacetQuery,
  ClassificationFilter
} from './musicClassificationDimensions.ts'
import {
  validClassificationFacetQuery,
  validClassificationFilters
} from './musicClassificationDimensions.ts'

/** Internal Core/database authorization input, not a public request field. */
export interface GenreBrowseReadContext {
  platformContexts?: Record<string, string>
}

export interface GenreBrowseToken {
  genresRevision: number
  catalogRevision: number
  contentRevision: number
  metadataRevision: number
  asOf: number
  expiresAt: number | null
  contextKey: string
}
export interface GenreBrowseQuery {
  kind: 'recording' | 'release'
  genreId?: string
  includeDescendants?: boolean
  source?: string
  search?: string
  offset?: number
  limit?: number
  token?: GenreBrowseToken
  filters?: ClassificationFilter[]
}
export interface GenreBrowseSummary {
  items: Array<{ id: string; name: string; nameEn: string }>
  total: number
  truncated: boolean
}
export interface GenreBrowseItem {
  id: string
  kind: 'recording' | 'release'
  title: string
  artist: string
  identity: 'source' | 'manual'
  sourceCount: number
  genres: GenreBrowseSummary
  classification: 'direct' | 'from-tracks' | 'none'
}
export interface GenreBrowsePage {
  token: GenreBrowseToken
  offset: number
  total: number
  items: GenreBrowseItem[]
  /** Library providers, independent of the current genre/search/source filter. */
  providers: string[]
}
export interface GenreMembersQuery extends Omit<GenreBrowseQuery, 'kind'> {
  entityId: string
}
export interface GenreMemberClassification {
  genres: GenreBrowseSummary
  origin: 'manual' | 'source' | 'external' | 'none'
}
export interface GenreBrowseMember {
  sourceId: string
  provider: string
  title: string
  artist: string
  availability: 'indexed' | 'unknown' | 'missing'
  sourceTarget: GenreTarget
  collectionTarget: GenreTarget | null
  sourceClassification: GenreMemberClassification
  collectionClassification: GenreMemberClassification | null
}
export interface GenreMembersPage {
  token: GenreBrowseToken
  offset: number
  total: number
  entity: GenreBrowseItem | null
  items: GenreBrowseMember[]
}
export interface GenreFacetsQuery extends GenreBrowseQuery, ClassificationFacetQuery {}
export interface GenreFacetsPage {
  token: GenreBrowseToken
  dimension: ClassificationFacetQuery['dimension']
  available: boolean
  reason: string | null
  offset: number
  total: number
  items: ClassificationFacetItem[]
}
export interface GenreBrowseDatabaseApi {
  /** Private playback fence; never exposed as a public read operation. */
  genresContainsSources(query: GenreMembersQuery & { token: GenreBrowseToken }, sourceIds: string[], context?: GenreBrowseReadContext): Promise<string[]>
  genresBrowse(query: GenreBrowseQuery, context?: GenreBrowseReadContext): Promise<GenreBrowsePage>
  genresMembers(
    query: GenreMembersQuery,
    context?: GenreBrowseReadContext
  ): Promise<GenreMembersPage>
  genresFacets(query: GenreFacetsQuery, context?: GenreBrowseReadContext): Promise<GenreFacetsPage>
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const uint = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0
const text = (value: unknown, max: number): boolean =>
  typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0')
export function validGenreBrowseToken(value: unknown): value is GenreBrowseToken {
  return (
    record(value) &&
    Object.keys(value).length === 7 &&
    ['genresRevision', 'catalogRevision', 'contentRevision', 'metadataRevision', 'asOf'].every(
      (key) => uint(value[key])
    ) &&
    (value.expiresAt === null ||
      (uint(value.expiresAt) && Number(value.expiresAt) > Number(value.asOf))) &&
    text(value.contextKey, 4096)
  )
}
export function validGenreBrowsePayload(name: string, value: unknown): boolean {
  if (!record(value) || !['genres.browse', 'genres.members', 'genres.facets'].includes(name))
    return false
  const fields = [
    'genreId',
    'includeDescendants',
    'source',
    'search',
    'offset',
    'limit',
    'token',
    'filters',
    ...(name === 'genres.facets' ? ['dimension', 'facetSearch'] : []),
    name === 'genres.members' ? 'entityId' : 'kind'
  ]
  return (
    Object.keys(value).every((key) => fields.includes(key)) &&
    (name === 'genres.members'
      ? text(value.entityId, 128)
      : ['recording', 'release'].includes(String(value.kind))) &&
    (value.genreId === undefined || text(value.genreId, MAX_GENRE_ID_LENGTH)) &&
    (value.includeDescendants === undefined || typeof value.includeDescendants === 'boolean') &&
    (value.source === undefined || text(value.source, 128)) &&
    (value.search === undefined ||
      (typeof value.search === 'string' &&
        value.search.length <= 512 &&
        !value.search.includes('\0'))) &&
    (value.offset === undefined || uint(value.offset)) &&
    (value.limit === undefined ||
      (uint(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 200)) &&
    (value.token === undefined || validGenreBrowseToken(value.token)) &&
    (value.filters === undefined || validClassificationFilters(value.filters)) &&
    (name !== 'genres.facets' || validClassificationFacetQuery(value))
  )
}
