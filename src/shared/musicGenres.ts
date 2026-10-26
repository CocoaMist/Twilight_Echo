/** Classification identities are independent of the legacy exact genre string filter. */
export interface GenreTarget {
  kind: 'source' | 'collection'
  /** Source ID; or canonical local album collection / namespaced platform album key. */
  id: string
}
export interface MusicGenreNode {
  id: string
  name: string
  nameEn: string
  parentId: string | null
  dictionaryVersion: number
  userModified: boolean
  ancestorIds: string[]
  childCount: number
}
export interface GenreQuery {
  parentId?: string | null
  search?: string
  offset?: number
  limit?: number
  revision?: number
}
export interface GenrePage {
  revision: number
  dictionaryVersion: number
  offset: number
  total: number
  items: MusicGenreNode[]
}
export interface GenreUnmappedQuery {
  provider?: string
  search?: string
  includeIgnored?: boolean
  offset?: number
  limit?: number
  revision?: number
}
export interface GenreUnmappedItem {
  provider: string
  value: string
  normalized: string
  ignored: boolean
  targetCount: number
}
export interface GenreUnmappedPage {
  revision: number
  offset: number
  total: number
  items: GenreUnmappedItem[]
}
export interface GenreCreate {
  name: string
  nameEn: string
  parentId?: string | null
}
export type GenreEdit = { revision: number } & (
  | ({ action: 'create' } & GenreCreate)
  | { action: 'update'; genreId: string; name?: string; nameEn?: string; parentId?: string | null }
  /** Explicitly migrate children/references, or detach children and unmap references. */
  | { action: 'delete'; genreId: string; replacement: string | null }
)
export interface GenreMap {
  revision: number
  /** Exact provider scope; '*' explicitly applies to every source without a scoped decision. */
  provider: string
  value: string
  genreId?: string | null
  ignored?: boolean
  /** Create and map in one transaction. */
  create?: GenreCreate
}
export interface GenreMutationResult {
  revision: number
  genreId?: string
}
export interface GenreOverride {
  target: GenreTarget
  revision: number
  genreIds: string[] | null
}
export interface GenreSelection {
  target: GenreTarget
  revision: number
  genreIds: string[]
  /** null = automatic; [] = explicit empty manual collection. */
  override: string[] | null
  origin: 'manual' | 'source' | 'external' | 'none'
}
export type GenreRawEvidence =
  | { format: 'text'; value: string; separators?: string }
  | { format: 'array'; values: string[] }
/** Trusted ingestion seam, not a public command or permission to fetch external data. */
export interface GenreEvidenceInput {
  target: GenreTarget
  key: string
  provider: string
  origin: 'source' | 'external'
  provenance: string
  raw: GenreRawEvidence
}
export interface GenreEvidenceQuery {
  target: GenreTarget
  offset?: number
  limit?: number
  revision?: number
}
export interface GenreEvidenceItem extends GenreEvidenceInput {
  values: Array<{ value: string; normalized: string; genreId: string | null; ignored: boolean }>
}
export interface GenreEvidencePage {
  revision: number
  offset: number
  total: number
  selection: GenreSelection
  items: GenreEvidenceItem[]
}
export interface GenreAdvanceResult {
  revision: number
  processed: number
  pending: boolean
}
export interface GenreDatabaseApi {
  genresTree(query: GenreQuery): Promise<GenrePage>
  genresUnmapped(query: GenreUnmappedQuery): Promise<GenreUnmappedPage>
  genresEvidence(query: GenreEvidenceQuery): Promise<GenreEvidencePage>
  genresEdit(input: GenreEdit): Promise<GenreMutationResult>
  genresMap(input: GenreMap): Promise<GenreMutationResult>
  genresOverride(input: GenreOverride): Promise<GenreSelection>
  genresAdvance(limit?: number, separators?: string): Promise<GenreAdvanceResult>
}

/** Versioned normalization, deliberately not fuzzy matching or language/region inference. */
export const GENRE_NORMALIZATION_VERSION = 1
/** Includes encoded original IDs from imported provider dictionaries. Names remain limited to 512. */
export const MAX_GENRE_ID_LENGTH = 8192
export function normalizeGenreAlias(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
}

export function validGenresPayload(name: string, raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const v = raw as Record<string, unknown>
  const text = (x: unknown, max = 512) =>
    typeof x === 'string' && !!x.trim() && x.length <= max && !x.includes('\0')
  const uint = (x: unknown) => Number.isSafeInteger(x) && Number(x) >= 0
  const keys = (names: string[]) => Object.keys(v).every((k) => names.includes(k))
  const page = () =>
    (v.offset === undefined || uint(v.offset)) &&
    (v.limit === undefined || (uint(v.limit) && Number(v.limit) >= 1 && Number(v.limit) <= 200)) &&
    (v.revision === undefined || uint(v.revision))
  const genreId = (x: unknown) => text(x, MAX_GENRE_ID_LENGTH)
  const parent = (x: unknown) => x === null || genreId(x)
  const target = (x: unknown) =>
    !!x &&
    typeof x === 'object' &&
    !Array.isArray(x) &&
    Object.keys(x).every((k) => ['kind', 'id'].includes(k)) &&
    ['source', 'collection'].includes(String((x as GenreTarget).kind)) &&
    text((x as GenreTarget).id, 16384)
  const create = (x: unknown) =>
    !!x &&
    typeof x === 'object' &&
    !Array.isArray(x) &&
    Object.keys(x).every((k) => ['name', 'nameEn', 'parentId'].includes(k)) &&
    text((x as GenreCreate).name) &&
    text((x as GenreCreate).nameEn) &&
    ((x as GenreCreate).parentId === undefined || parent((x as GenreCreate).parentId))
  if (name === 'genres.tree')
    return (
      keys(['parentId', 'search', 'offset', 'limit', 'revision']) &&
      page() &&
      (v.parentId === undefined || parent(v.parentId)) &&
      (v.search === undefined || (typeof v.search === 'string' && v.search.length <= 512))
    )
  if (name === 'genres.unmapped')
    return (
      keys(['provider', 'search', 'includeIgnored', 'offset', 'limit', 'revision']) &&
      page() &&
      (v.provider === undefined || text(v.provider, 128)) &&
      (v.search === undefined || (typeof v.search === 'string' && v.search.length <= 512)) &&
      (v.includeIgnored === undefined || typeof v.includeIgnored === 'boolean')
    )
  if (name === 'genres.evidence')
    return keys(['target', 'offset', 'limit', 'revision']) && page() && target(v.target)
  if (name === 'genres.override')
    return (
      keys(['target', 'revision', 'genreIds']) &&
      target(v.target) &&
      uint(v.revision) &&
      (v.genreIds === null ||
        (Array.isArray(v.genreIds) && v.genreIds.length <= 200 && v.genreIds.every(genreId)))
    )
  if (name === 'genres.map')
    return (
      keys(['revision', 'provider', 'value', 'genreId', 'ignored', 'create']) &&
      uint(v.revision) &&
      text(v.provider, 128) &&
      text(v.value, 32768) &&
      (v.ignored === undefined || typeof v.ignored === 'boolean') &&
      (v.create !== undefined
        ? create(v.create) && v.genreId === undefined && !v.ignored
        : (v.genreId === null || genreId(v.genreId)) && !(v.ignored && v.genreId !== null))
    )
  if (name !== 'genres.edit' || !uint(v.revision)) return false
  if (v.action === 'create')
    return (
      keys(['action', 'revision', 'name', 'nameEn', 'parentId']) &&
      create({
        name: v.name,
        nameEn: v.nameEn,
        ...(v.parentId !== undefined ? { parentId: v.parentId } : {})
      })
    )
  if (v.action === 'update')
    return (
      keys(['action', 'revision', 'genreId', 'name', 'nameEn', 'parentId']) &&
      genreId(v.genreId) &&
      (v.name !== undefined || v.nameEn !== undefined || v.parentId !== undefined) &&
      (v.name === undefined || text(v.name)) &&
      (v.nameEn === undefined || text(v.nameEn)) &&
      (v.parentId === undefined || parent(v.parentId))
    )
  return (
    v.action === 'delete' &&
    keys(['action', 'revision', 'genreId', 'replacement']) &&
    genreId(v.genreId) &&
    parent(v.replacement)
  )
}
