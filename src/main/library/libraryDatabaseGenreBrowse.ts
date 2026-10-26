import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type {
  GenreBrowseItem,
  GenreBrowseMember,
  GenreBrowsePage,
  GenreBrowseQuery,
  GenreBrowseSummary,
  GenreBrowseToken,
  GenreBrowseReadContext,
  GenreFacetsPage,
  GenreFacetsQuery,
  GenreMemberClassification,
  GenreMembersPage,
  GenreMembersQuery
} from '../../shared/musicGenreBrowse.ts'
import { validGenreBrowsePayload } from '../../shared/musicGenreBrowse.ts'
import {
  classificationDimensionAvailability,
  classificationFacetLabel,
  type ClassificationDimension
} from '../../shared/musicClassificationDimensions.ts'
import {
  classificationDimensionsContext,
  classificationDimensionsCtes,
  classificationFacetSql,
  compileClassificationFilters
} from './libraryDatabaseClassificationDimensions.ts'

type Row = Record<string, unknown>
export interface GenreBrowseOwner {
  sql: DatabaseSync
  albumAliases(): Map<string, string[]>
  contentRevision(): number
  metadataRevision(): number
  now?(): number
}

/** Refresh before preparing SQL; the UDF only reads this map and never re-enters SQLite. */
export function genreBrowseCollectionMap(aliases: Map<string, string[]>): Map<string, string> {
  const result = new Map<string, string>()
  for (const [canonical, keys] of aliases) for (const key of keys) result.set(key, canonical)
  return result
}

/** Match catalog's string albumId.trim(), including ECMAScript Unicode whitespace. Uses source alias s. */
export const GENRE_PLATFORM_ALBUM_TARGET_SQL = `json_type(s.payload,'$.albumId')='text'
  AND length(trim(json_extract(s.payload,'$.albumId'),char(9,10,11,12,13,32,160,5760,
    8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))>0`

/** Shared relational meaning for pages, counts, member details and classification facets. */
export function genreBrowseCtes(extension: { ctes?: string; sourceFilter?: string; physical?: boolean; scope?: 'library' | 'catalog'; kind?: 'recording' | 'release'; collectionDetails?: boolean; deferSourceDetails?: boolean; recordingOnly?: boolean; deferClassification?: boolean; hasGenreFilter?: boolean; hasEntityFilter?: boolean } = {}): string {
  // Recording queries without release-level dimensions need no album bindings or
  // playback preference details. Keep the default graph for other consumers.
  const recordingOnly = extension.recordingOnly && extension.kind === 'recording' && !extension.physical
  const source = extension.physical
    ? `(SELECT cs.*,cs.recording_id recording,cs.release_id release,
        ${extension.deferSourceDetails ? '0 preferred_recording,0 preferred_release FROM catalog_sources cs' : 'b.preferred_recording,b.preferred_release FROM catalog_sources cs JOIN catalog_bindings b ON b.id=cs.id'})`
    : 'catalog_bindings'
  const entitySources = extension.kind
    ? `(SELECT ${extension.physical ? `${extension.kind}_id` : extension.kind} entity_id,id source_id
        FROM ${extension.physical ? 'catalog_sources' : 'catalog_bindings'}
        ${extension.kind === 'release' ? `WHERE ${extension.physical ? 'release_id' : 'release'} IS NOT NULL` : ''})`
    : extension.physical ? `(SELECT recording_id entity_id,id source_id FROM catalog_sources
        UNION ALL SELECT release_id,id FROM catalog_sources WHERE release_id IS NOT NULL)`
    : 'catalog_entity_sources'
  const entityId = extension.kind
    ? `s.${extension.kind}`
    : 'b.entity_id'
  return `
  query_args(genre_id,descendants,provider,search,kind,entity_id) AS (VALUES(?,?,?,?,?,?)),
  ${extension.ctes ? `${extension.ctes},` : ''}
  genre_tree(id) AS (
    SELECT id FROM music_genres WHERE id=(SELECT genre_id FROM query_args)
    UNION SELECT g.id FROM music_genres g JOIN genre_tree p ON g.parent_id=p.id
      WHERE (SELECT descendants FROM query_args)=1),
  scoped_sources AS MATERIALIZED (
    SELECT s.id,s.provider,s.track_id,s.recording,${recordingOnly ? 'NULL' : 's.release'} release,
      s.availability,${recordingOnly ? '0' : 's.preferred_recording'} preferred_recording,
      ${extension.kind === 'recording' && !extension.collectionDetails ? 'NULL' : `CASE WHEN s.provider='local' THEN genre_browse_collection(t.album_key)
      WHEN ${GENRE_PLATFORM_ALBUM_TARGET_SQL}
      THEN nullif(s.album_key,'') ELSE NULL END`} collection_id
    FROM ${source} s LEFT JOIN tracks t ON s.provider='local' AND t.id=s.track_id
    WHERE ${extension.scope === 'catalog' ? '1' : `EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)
      AND (s.provider<>'local' OR (t.id IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM catalog_pending p WHERE p.track_id=s.track_id)))`}),
  genre_targets AS MATERIALIZED (
    SELECT 'source' target_kind,id target_id FROM scoped_sources
    ${extension.kind === 'recording' && !extension.collectionDetails ? '' : "UNION SELECT 'collection',collection_id FROM scoped_sources WHERE collection_id IS NOT NULL"}),
  manual_targets AS MATERIALIZED (
    SELECT o.target_kind,o.target_id,o.genre_ids FROM music_genre_overrides o
    UNION ALL SELECT o.target_kind,o.target_id,o.genre_ids FROM music_genre_import_overrides o
      WHERE NOT EXISTS(SELECT 1 FROM music_genre_overrides m
        WHERE m.target_kind=o.target_kind AND m.target_id=o.target_id)),
  bridge_groups AS (
    SELECT provider,normalized,min(genre_id) genre_id,min(ignored) ignored,
      count(DISTINCT coalesce(genre_id,'')||':'||ignored) variants
    FROM music_genre_alias_bridges GROUP BY provider,normalized),
  evidence_patterns AS MATERIALIZED (
    SELECT DISTINCT provider,values_json FROM music_genre_evidence),
  evidence_pattern_genres AS MATERIALIZED (
    SELECT DISTINCT p.provider,p.values_json,g.id genre_id
    FROM evidence_patterns p,json_each(p.values_json) v
    LEFT JOIN music_genre_aliases a ON a.provider=p.provider AND a.normalized=json_extract(v.value,'$.normalized')
    LEFT JOIN bridge_groups b ON b.provider=p.provider AND b.normalized=json_extract(v.value,'$.normalized')
    LEFT JOIN music_genre_aliases ga ON ga.provider='*' AND ga.normalized=json_extract(v.value,'$.normalized')
    JOIN music_genres g ON g.id=CASE WHEN a.provider IS NOT NULL THEN a.genre_id
      WHEN b.provider IS NOT NULL THEN CASE WHEN b.variants=1 THEN b.genre_id ELSE NULL END
      ELSE ga.genre_id END),
  target_levels AS (
    SELECT t.target_kind,t.target_id,CASE
      WHEN EXISTS(SELECT 1 FROM manual_targets m WHERE m.target_kind=t.target_kind AND m.target_id=t.target_id) THEN 'manual'
      WHEN EXISTS(SELECT 1 FROM music_genre_evidence e CROSS JOIN evidence_pattern_genres p ON p.provider=e.provider AND p.values_json=e.values_json
        WHERE e.target_kind=t.target_kind AND e.target_id=t.target_id AND e.origin='source') THEN 'source'
      WHEN EXISTS(SELECT 1 FROM music_genre_evidence e CROSS JOIN evidence_pattern_genres p ON p.provider=e.provider AND p.values_json=e.values_json
        WHERE e.target_kind=t.target_kind AND e.target_id=t.target_id AND e.origin='external') THEN 'external'
      ELSE 'none' END origin
    FROM genre_targets t),
  target_genres AS (
    SELECT m.target_kind,m.target_id,CAST(v.value AS TEXT) genre_id
    FROM manual_targets m,json_each(m.genre_ids) v JOIN music_genres g ON g.id=v.value
    UNION ALL SELECT e.target_kind,e.target_id,p.genre_id
    FROM music_genre_evidence e
    CROSS JOIN evidence_pattern_genres p ON p.provider=e.provider AND p.values_json=e.values_json
    WHERE NOT EXISTS(SELECT 1 FROM manual_targets m
      WHERE m.target_kind=e.target_kind AND m.target_id=e.target_id)
      AND (e.origin='source' OR (e.origin='external' AND NOT EXISTS(
        SELECT 1 FROM music_genre_evidence s
        CROSS JOIN evidence_pattern_genres sp ON sp.provider=s.provider AND sp.values_json=s.values_json
        WHERE s.target_kind=e.target_kind AND s.target_id=e.target_id AND s.origin='source')))),
  entity_source_bindings AS MATERIALIZED (SELECT * FROM ${entitySources}),
  entity_sources AS MATERIALIZED (
    SELECT ${extension.kind ? '' : 'DISTINCT'} ${entityId} entity_id,s.id source_id,s.provider,s.collection_id,
      s.availability
    FROM scoped_sources s ${extension.kind ? '' : `CROSS JOIN entity_source_bindings b ON b.source_id=s.id
      CROSS JOIN catalog_entities e ON e.id=${entityId}`} CROSS JOIN query_args q
    WHERE ${extension.kind ? `${extension.kind === 'release' ? `${entityId} IS NOT NULL AND ` : ''}q.kind='${extension.kind}'` : 'e.kind=q.kind'}
      AND (q.provider IS NULL OR s.provider=q.provider)
      AND (q.entity_id IS NULL OR ${entityId}=q.entity_id)
      ${extension.sourceFilter ? `AND (${extension.sourceFilter})` : ''}),
  entity_direct AS (
    ${extension.kind === 'recording' ? 'SELECT NULL entity_id WHERE 0' : `SELECT DISTINCT s.entity_id FROM entity_sources s JOIN target_levels l
      ON l.target_kind='collection' AND l.target_id=s.collection_id
    WHERE (SELECT kind FROM query_args)='release' AND l.origin<>'none'`}),
  entity_genres AS ${extension.kind === 'recording' ? '' : 'MATERIALIZED '}(
    SELECT s.entity_id,g.genre_id FROM entity_sources s CROSS JOIN target_genres g
      ON g.target_kind='source' AND g.target_id=s.source_id
    WHERE (SELECT kind FROM query_args)='recording'
      OR NOT EXISTS(SELECT 1 FROM entity_direct d WHERE d.entity_id=s.entity_id)
    ${extension.kind === 'recording' ? '' : `UNION SELECT s.entity_id,g.genre_id FROM entity_sources s CROSS JOIN target_genres g
      ON g.target_kind='collection' AND g.target_id=s.collection_id
      WHERE (SELECT kind FROM query_args)='release'`}),
  entity_counts AS MATERIALIZED (SELECT entity_id,count(${extension.kind ? '*' : 'DISTINCT source_id'}) source_count FROM entity_sources GROUP BY entity_id),
  selected_entities AS MATERIALIZED (
    SELECT e.id,e.kind,e.title,e.artist,e.identity,s.source_count${extension.deferClassification ? '' : `,
      CASE WHEN e.kind='recording' AND e.id IN (SELECT entity_id FROM entity_genres) THEN 'direct'
        WHEN e.kind='release' AND e.id IN (SELECT entity_id FROM entity_direct) THEN 'direct'
        WHEN e.id IN (SELECT entity_id FROM entity_genres) THEN 'from-tracks' ELSE 'none' END classification`}
    FROM (
      SELECT * FROM entity_counts s
      ${extension.hasGenreFilter === false ? '' : 'WHERE (SELECT genre_id FROM query_args) IS NULL OR s.entity_id IN (SELECT g.entity_id FROM genre_tree t CROSS JOIN entity_genres g ON g.genre_id=t.id)'}
    ) s CROSS JOIN catalog_entities e ON e.id=s.entity_id CROSS JOIN query_args q
    WHERE (q.search='' OR instr(lower(e.title),q.search)>0 OR instr(lower(e.artist),q.search)>0)),
  matched_members AS (
    SELECT s.* FROM entity_sources s
    ${extension.hasEntityFilter === false ? (extension.hasGenreFilter ? 'WHERE s.entity_id IN (SELECT g.entity_id FROM genre_tree t CROSS JOIN entity_genres g ON g.genre_id=t.id)' : '') : 'JOIN selected_entities e ON e.id=s.entity_id'})
  `
}

const emptySummary = (): GenreBrowseSummary => ({ items: [], total: 0, truncated: false })
const stale = () =>
  Object.assign(new Error('分类或音乐库已变化，请刷新后重试'), { code: 'STALE_REVISION' })

/** Read-only, SQL-paged library classification. No ingestion or network work starts here. */
export class LibraryDatabaseGenreBrowse {
  private readonly owner: GenreBrowseOwner
  private collections = new Map<string, string>()
  private collectionsRevision = -1
  private readonly totalCache = new Map<string, number>()
  private readonly browseCache = new Map<string, { items: GenreBrowseItem[]; total: number; providers: string[] }>()
  private readonly facetCache = new Map<string, Omit<GenreFacetsPage, 'token'>>()
  private readClock = 0
  constructor(owner: GenreBrowseOwner) {
    this.owner = owner
    owner.sql.function(
      'genre_browse_collection',
      (key) => this.collections.get(String(key)) ?? null
    )
  }
  private get sql() {
    return this.owner.sql
  }
  private read<T extends { token: GenreBrowseToken }>(action: () => T): T {
    const previousClock = this.readClock,
      ownTransaction = !this.sql.isTransaction
    this.readClock = this.owner.now?.() ?? Date.now()
    try {
      if (ownTransaction) this.sql.exec('BEGIN')
      const result = action()
      if (
        result.token.expiresAt !== null &&
        (this.owner.now?.() ?? Date.now()) >= result.token.expiresAt
      )
        throw stale()
      if (ownTransaction) this.sql.exec('COMMIT')
      return result
    } catch (error) {
      if (ownTransaction && this.sql.isTransaction) this.sql.exec('ROLLBACK')
      throw error
    } finally {
      this.readClock = previousClock
    }
  }
  private token(
    expected?: GenreBrowseToken,
    context: GenreBrowseReadContext = {}
  ): GenreBrowseToken {
    const now = this.readClock
    const token = {
      genresRevision: Number(
        this.sql.prepare("SELECT value FROM music_genre_state WHERE key='revision'").get()!.value
      ),
      catalogRevision: Number(
        this.sql.prepare("SELECT value FROM catalog_state WHERE key='revision'").get()!.value
      ),
      contentRevision: this.owner.contentRevision(),
      metadataRevision: this.owner.metadataRevision(),
      asOf: expected?.asOf ?? now,
      ...classificationDimensionsContext(this.sql, context, now)
    }
    if (
      expected &&
      (expected.asOf > now ||
        (expected.expiresAt !== null && expected.expiresAt <= now) ||
        Object.keys(token).some(
          (k) => token[k as keyof GenreBrowseToken] !== expected[k as keyof GenreBrowseToken]
        ))
    )
      throw stale()
    return token
  }
  private ensureCollections(contentRevision: number): void {
    if (this.collectionsRevision !== contentRevision) {
      this.collections = genreBrowseCollectionMap(this.owner.albumAliases())
      this.collectionsRevision = contentRevision
    }
  }
  private params(
    query: Omit<GenreBrowseQuery, 'kind'>,
    kind: GenreBrowseQuery['kind'],
    entityId?: string
  ): SQLInputValue[] {
    return [
      query.genreId ?? null,
      query.includeDescendants ? 1 : 0,
      query.source ?? null,
      query.search?.trim().toLowerCase() ?? '',
      kind,
      entityId ?? null
    ]
  }
  private plan(
    query: Omit<GenreBrowseQuery, 'kind'>,
    kind: GenreBrowseQuery['kind'],
    token: GenreBrowseToken,
    context: GenreBrowseReadContext,
    entityId?: string,
    facet?: ClassificationDimension
  ): { sql: string; params: SQLInputValue[] } {
    if (kind !== 'recording' || entityId !== undefined) this.ensureCollections(token.contentRevision)
    const requestedDimensions = [...new Set([...(query.filters ?? []).map(filter => filter.dimension), ...(facet ? [facet] : [])])]
    const dimensions = classificationDimensionsCtes(kind, token.asOf, context, this.readClock, requestedDimensions)
    const filters = compileClassificationFilters(query.filters)
    const recordingOnly = kind === 'recording' && !requestedDimensions.some(dimension =>
      ['region', 'releaseYear', 'projectYear', 'albumType', 'management'].includes(dimension))
    return {
      sql: genreBrowseCtes({
        ctes: dimensions.sql,
        sourceFilter: filters.sql,
        kind,
        collectionDetails: entityId !== undefined,
        recordingOnly,
        deferClassification: true,
        hasGenreFilter: Boolean(query.genreId),
        hasEntityFilter: Boolean(query.search?.trim())
      }),
      params: [...this.params(query, kind, entityId), ...dimensions.params, ...filters.params]
    }
  }
  private revisionKey(token: GenreBrowseToken): string {
    const changes = Number((this.sql.prepare('SELECT total_changes() c').get() as Row)?.c ?? 0)
    return `${changes}:${token.genresRevision}:${token.catalogRevision}:${token.contentRevision}:${token.metadataRevision}:${token.contextKey}:${token.expiresAt ?? ''}:${token.expiresAt !== null ? `${token.asOf}:${this.readClock}` : ''}`
  }
  private entities(
    query: GenreBrowseQuery,
    token: GenreBrowseToken,
    context: GenreBrowseReadContext,
    entityId?: string
  ): { items: GenreBrowseItem[]; total: number; providers: string[] } {
    const limit = query.limit ?? 50,
      offset = query.offset ?? 0,
      filterKey = JSON.stringify([
        this.revisionKey(token),
        query.kind,
        query.genreId ?? null,
        query.includeDescendants ? 1 : 0,
        query.source ?? null,
        query.search?.trim().toLowerCase() ?? '',
        query.filters ?? [],
        entityId ?? null
      ]),
      pageKey = `${filterKey}:${offset}:${limit}`,
      cached = this.browseCache.get(pageKey)
    if (cached) return cached
    const plan = this.plan(query, query.kind, token, context, entityId),
      params = plan.params,
      knownTotal = this.totalCache.get(filterKey),
      reverse = knownTotal !== undefined && offset > knownTotal / 2 && offset < knownTotal,
      pageLimit = reverse ? Math.min(limit, Math.max(0, knownTotal - offset)) : limit,
      pageOffset = reverse ? Math.max(0, knownTotal - offset - limit) : offset
    const rows = this.sql
      .prepare(
        `WITH RECURSIVE ${plan.sql}
      , selected_page_raw AS MATERIALIZED (
        SELECT * FROM selected_entities ORDER BY title COLLATE NOCASE ${reverse ? 'DESC' : 'ASC'},id ${reverse ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?),
      page_entity_sources AS MATERIALIZED (
        SELECT s.* FROM entity_sources s CROSS JOIN selected_page_raw p ON p.id=s.entity_id),
      page_entity_direct AS MATERIALIZED (
        ${query.kind === 'recording' ? 'SELECT NULL entity_id WHERE 0' : `SELECT DISTINCT s.entity_id FROM page_entity_sources s JOIN target_levels l
          ON l.target_kind='collection' AND l.target_id=s.collection_id
        WHERE (SELECT kind FROM query_args)='release' AND l.origin<>'none'`}),
      page_entity_genres AS MATERIALIZED (
        SELECT DISTINCT s.entity_id,g.genre_id FROM page_entity_sources s CROSS JOIN target_genres g
          ON g.target_kind='source' AND g.target_id=s.source_id
        WHERE (SELECT kind FROM query_args)='recording'
          OR NOT EXISTS(SELECT 1 FROM page_entity_direct d WHERE d.entity_id=s.entity_id)
        ${query.kind === 'recording' ? '' : `UNION SELECT s.entity_id,g.genre_id FROM page_entity_sources s CROSS JOIN target_genres g
          ON g.target_kind='collection' AND g.target_id=s.collection_id
          WHERE (SELECT kind FROM query_args)='release'`}),
      selected_page AS MATERIALIZED (
        SELECT p.*,CASE WHEN p.kind='recording' AND p.id IN (SELECT entity_id FROM page_entity_genres) THEN 'direct'
          WHEN p.kind='release' AND p.id IN (SELECT entity_id FROM page_entity_direct) THEN 'direct'
          WHEN p.id IN (SELECT entity_id FROM page_entity_genres) THEN 'from-tracks' ELSE 'none' END classification
        FROM selected_page_raw p),
      page_genre_rows AS (
        SELECT g.entity_id,n.id,n.name,n.name_en,count(*) OVER(PARTITION BY g.entity_id) genre_total,
          row_number() OVER(PARTITION BY g.entity_id ORDER BY n.name_en,n.id) ordinal
        FROM page_entity_genres g JOIN selected_page p ON p.id=g.entity_id JOIN music_genres n ON n.id=g.genre_id),
      page_genres AS (
        SELECT entity_id,max(genre_total) genre_total,
          json_group_array(json_object('id',id,'name',name,'nameEn',name_en)) genres
        FROM (SELECT * FROM page_genre_rows WHERE ordinal<=32 ORDER BY entity_id,ordinal) GROUP BY entity_id)
      SELECT p.*,t.total,t.providers,g.genres,g.genre_total FROM (
        SELECT count(*) total,(SELECT json_group_array(provider) FROM (
          SELECT DISTINCT provider FROM scoped_sources ORDER BY provider)) providers FROM selected_entities
      ) t LEFT JOIN selected_page p ON 1 LEFT JOIN page_genres g ON g.entity_id=p.id
      ORDER BY p.title COLLATE NOCASE,p.id`
      )
      .all(...params, pageLimit, pageOffset) as Row[]
    const total = Number(rows[0].total), page = rows.filter(row => row.id !== null)
    const providers = JSON.parse(String(rows[0].providers)) as string[]
    const result = { total, providers, items: page.map((row) => this.entity(row, {
      items: row.genres == null ? [] : JSON.parse(String(row.genres)) as GenreBrowseSummary['items'],
      total: Number(row.genre_total ?? 0), truncated: Number(row.genre_total ?? 0) > 32
    })) }
    this.totalCache.set(filterKey, total)
    while (this.totalCache.size > 32) this.totalCache.delete(this.totalCache.keys().next().value!)
    this.browseCache.set(pageKey, result)
    while (this.browseCache.size > 32) this.browseCache.delete(this.browseCache.keys().next().value!)
    return result
  }
  private entity(row: Row, genres: GenreBrowseSummary): GenreBrowseItem {
    return {
      id: String(row.id),
      kind: row.kind as GenreBrowseItem['kind'],
      title: String(row.title),
      artist: String(row.artist),
      identity: row.identity as GenreBrowseItem['identity'],
      sourceCount: Number(row.source_count),
      classification: row.classification as GenreBrowseItem['classification'],
      genres
    }
  }
  private summaries(sql: string, params: SQLInputValue[]): Map<string, GenreBrowseSummary> {
    const result = new Map<string, GenreBrowseSummary>()
    for (const row of this.sql.prepare(sql).all(...params) as Row[]) {
      const key = String(row.target_id)
      let summary = result.get(key)
      if (!summary) {
        summary = { items: [], total: Number(row.total), truncated: Number(row.total) > 32 }
        result.set(key, summary)
      }
      summary.items.push({
        id: String(row.id),
        name: String(row.name),
        nameEn: String(row.name_en)
      })
    }
    return result
  }
  browse(query: GenreBrowseQuery, context: GenreBrowseReadContext = {}): GenreBrowsePage {
    if (!validGenreBrowsePayload('genres.browse', query)) throw new Error('无效的分类浏览参数')
    return this.read(() => {
      const token = this.token(query.token, context)
      const { total, items, providers } = this.entities(query, token, context)
      return {
        token,
        offset: query.offset ?? 0,
        total,
        items,
        providers
      }
    })
  }
  members(query: GenreMembersQuery, context: GenreBrowseReadContext = {}): GenreMembersPage {
    if (!validGenreBrowsePayload('genres.members', query)) throw new Error('无效的分类来源参数')
    return this.read(() => {
      const token = this.token(query.token, context)
      const found = this.sql
        .prepare("SELECT kind FROM catalog_entities WHERE id=? AND kind IN ('recording','release')")
        .get(query.entityId)
      if (!found) return { token, offset: query.offset ?? 0, total: 0, entity: null, items: [] }
      const kind = found.kind as GenreBrowseQuery['kind'],
        plan = this.plan(query, kind, token, context, query.entityId),
        params = plan.params
      const entity =
        this.entities({ ...query, kind, offset: 0, limit: 1 }, token, context, query.entityId).items[0] ??
        null
      if (!entity) return { token, offset: query.offset ?? 0, total: 0, entity, items: [] }
      const total = Number(
        this.sql
          .prepare(`WITH RECURSIVE ${plan.sql} SELECT count(*) total FROM matched_members`)
          .get(...params)!.total
      )
      const rows = this.sql
        .prepare(
          `WITH RECURSIVE ${plan.sql}, member_page AS (
        SELECT * FROM matched_members ORDER BY provider,source_id LIMIT ? OFFSET ?)
        SELECT p.*,s.payload FROM member_page p JOIN catalog_sources s ON s.id=p.source_id
        ORDER BY p.provider,p.source_id`
        )
        .all(...params, query.limit ?? 50, query.offset ?? 0) as Row[]
      const targets = rows.flatMap((row) => [
        { kind: 'source', id: row.source_id },
        ...(row.collection_id ? [{ kind: 'collection', id: row.collection_id }] : [])
      ])
      const targetArgs = [...params, JSON.stringify(targets)]
      const selection = new Map<string, GenreMemberClassification>()
      for (const row of this.sql
        .prepare(
          `WITH RECURSIVE ${plan.sql}, page_targets AS (
        SELECT json_extract(value,'$.kind') target_kind,json_extract(value,'$.id') target_id FROM json_each(?))
        SELECT DISTINCT l.* FROM target_levels l JOIN page_targets p USING(target_kind,target_id)`
        )
        .all(...targetArgs) as Row[]) {
        selection.set(`${row.target_kind}:${row.target_id}`, {
          origin: row.origin as GenreMemberClassification['origin'],
          genres: emptySummary()
        })
      }
      const summaries = this.summaries(
        `WITH RECURSIVE ${plan.sql}, page_targets AS (
        SELECT DISTINCT json_extract(value,'$.kind') target_kind,json_extract(value,'$.id') target_id FROM json_each(?)),
        ranked AS (SELECT g.target_kind||':'||g.target_id target_id,n.id,n.name,n.name_en,
          count(*) OVER(PARTITION BY g.target_kind,g.target_id) total,
          row_number() OVER(PARTITION BY g.target_kind,g.target_id ORDER BY n.name_en,n.id) ordinal
          FROM (SELECT DISTINCT g.target_kind,g.target_id,g.genre_id FROM target_genres g JOIN page_targets p USING(target_kind,target_id)) g JOIN music_genres n ON n.id=g.genre_id)
        SELECT * FROM ranked WHERE ordinal<=32 ORDER BY target_id,ordinal`,
        targetArgs
      )
      for (const [key, genres] of summaries) selection.get(key)!.genres = genres
      const items: GenreBrowseMember[] = rows.map((row) => {
        const payload = JSON.parse(String(row.payload)) as { title?: string; artist?: string }
        return {
          sourceId: String(row.source_id),
          provider: String(row.provider),
          title: payload.title ?? '',
          artist: payload.artist ?? '',
          availability: row.availability as GenreBrowseMember['availability'],
          sourceTarget: { kind: 'source', id: String(row.source_id) },
          collectionTarget: row.collection_id
            ? { kind: 'collection', id: String(row.collection_id) }
            : null,
          sourceClassification: selection.get(`source:${row.source_id}`)!,
          collectionClassification: row.collection_id
            ? selection.get(`collection:${row.collection_id}`)!
            : null
        }
      })
      return { token, offset: query.offset ?? 0, total, entity, items }
    })
  }
  containsSources(query: GenreMembersQuery & { token: GenreBrowseToken }, sourceIds: string[], context: GenreBrowseReadContext = {}): string[] {
    if (!query.token || !validGenreBrowsePayload('genres.members', query) || !Array.isArray(sourceIds) ||
      sourceIds.length > 200 || sourceIds.some(id => typeof id !== 'string' || !id || id.length > 128))
      throw new Error('无效的分类播放范围')
    return this.read(() => {
      const token = this.token(query.token, context)
      const found = this.sql.prepare("SELECT kind FROM catalog_entities WHERE id=? AND kind IN ('recording','release')").get(query.entityId)
      if (!found) return { token, items: [] as string[] }
      const plan = this.plan(query, found.kind as GenreBrowseQuery['kind'], token, context, query.entityId)
      const items = this.sql.prepare(`WITH RECURSIVE ${plan.sql} SELECT source_id FROM matched_members
        WHERE source_id IN (SELECT value FROM json_each(?)) ORDER BY source_id`)
        .all(...plan.params, JSON.stringify(sourceIds)).map(row => String(row.source_id))
      return { token, items }
    }).items
  }
  facets(query: GenreFacetsQuery, context: GenreBrowseReadContext = {}): GenreFacetsPage {
    if (!validGenreBrowsePayload('genres.facets', query)) throw new Error('无效的分类分面参数')
    return this.read(() => {
      const token = this.token(query.token, context),
        facetKey = JSON.stringify([
          this.revisionKey(token),
          query.kind,
          query.dimension,
          query.genreId ?? null,
          query.includeDescendants ? 1 : 0,
          query.source ?? null,
          query.search?.trim().toLowerCase() ?? '',
          query.filters ?? [],
          query.facetSearch ?? '',
          query.offset ?? 0,
          query.limit ?? 50
        ]),
        cached = this.facetCache.get(facetKey)
      if (cached) return { ...cached, token }
      const plan = this.plan(query, query.kind, token, context, undefined, query.dimension)
      const facet = classificationFacetSql(query),
        params = [...plan.params, ...facet.params]
      const rows = this.sql
        .prepare(
          `WITH RECURSIVE ${plan.sql}, facet_values AS MATERIALIZED (${facet.sql}), facet_page AS (
            SELECT * FROM facet_values ORDER BY value='unknown',value COLLATE NOCASE LIMIT ? OFFSET ?)
          SELECT p.*,t.total FROM (SELECT count(*) total FROM facet_values) t LEFT JOIN facet_page p ON 1
          ORDER BY value='unknown',value COLLATE NOCASE`
        )
        .all(...params, query.limit ?? 50, query.offset ?? 0)
      const page = {
        dimension: query.dimension,
        ...classificationDimensionAvailability(query.dimension),
        offset: query.offset ?? 0,
        total: Number(rows[0].total),
        items: rows.filter(row => row.value !== null).map((row) => ({
          value: String(row.value),
          label: classificationFacetLabel(query.dimension, String(row.value)),
          count: Number(row.count)
        }))
      }
      this.facetCache.set(facetKey, page)
      while (this.facetCache.size > 32) this.facetCache.delete(this.facetCache.keys().next().value!)
      return { token, ...page }
    })
  }
}
