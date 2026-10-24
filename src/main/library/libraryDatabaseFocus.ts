import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { TrackData } from '../../shared/track.ts'
import {
  musicFocusQueryKey, normalizeMusicFocusName, sameFocusToken, validMusicFocusPayload, validMusicFocusPlaybackPageQuery,
  type MusicFocusNode, type MusicFocusNumber, type MusicFocusSource, type MusicFocusQuery,
  type MusicFocusState, type MusicFocusToken, type MusicFocusReadContext, type MusicFocusPageQuery,
  type MusicFocusItem, type MusicFocusPage, type MusicFocusFacetsQuery, type MusicFocusFacetsPage,
  type MusicFocusPlaybackPage, type MusicFocusPlaybackPageQuery, type MusicFocusSaved, type MusicFocusSavedListQuery,
  type MusicFocusSavedPage, type MusicFocusCreate, type MusicFocusRename, type MusicFocusUpdate,
  type MusicFocusDelete, type MusicFocusWriteResult, type MusicFocusDeleteResult
} from '../../shared/musicFocus.ts'
import { classificationFacetLabel, type ClassificationDimension } from '../../shared/musicClassificationDimensions.ts'
import { genreBrowseCtes, genreBrowseCollectionMap } from './libraryDatabaseGenreBrowse.ts'
import { classificationDimensionsContext, classificationDimensionsCtes } from './libraryDatabaseClassificationDimensions.ts'

export const FOCUS_SCHEMA_OBJECTS = ['personal_focus_state', 'personal_focus_queries']
export const FOCUS_SCHEMA_SQL = `
CREATE TABLE personal_focus_state(profile_id TEXT PRIMARY KEY CHECK(profile_id='default'),revision INTEGER NOT NULL);
INSERT INTO personal_focus_state VALUES('default',0);
CREATE TABLE personal_focus_queries(profile_id TEXT NOT NULL CHECK(profile_id='default'),id TEXT NOT NULL,
 name TEXT NOT NULL,normalized_name TEXT NOT NULL,query TEXT NOT NULL,name_revision INTEGER NOT NULL,
 query_revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(profile_id,id),UNIQUE(profile_id,normalized_name));
`
export interface MusicFocusOwner {
  sql: DatabaseSync; transaction<T>(action: () => T): T; contentRevision(): number; metadataRevision(): number
  albumAliases(): Map<string, string[]>; resolve(sourceId: string, catalogRevision: number): TrackData | null; now?(): number
}
type Row = Record<string, unknown>
type Sql = { sql: string; params: SQLInputValue[] }
const stale = () => Object.assign(new Error('Focus 条件或音乐库已变化，请刷新后重试'), { code: 'STALE_REVISION' })
const invalid = () => Object.assign(new Error('无效的 Focus 条件'), { code: 'INVALID_PAYLOAD' })
const conflict = () => Object.assign(new Error('已有同名 Focus，请换一个名称'), { code: 'FOCUS_NAME_CONFLICT' })
const displayName = (v: string) => v.normalize('NFKC').trim().replace(/\s+/gu, ' ')
const combine = (parts: Sql[], join = 'AND', empty = '1'): Sql => ({ sql: parts.length ? `(${parts.map(p => p.sql).join(` ${join} `)})` : empty, params: parts.flatMap(p => p.params) })
function numeric(expr: string, value: MusicFocusNumber): Sql {
  const clauses: Sql[] = []
  if (value.exists !== undefined) clauses.push({ sql: `${expr} IS ${value.exists ? 'NOT ' : ''}NULL`, params: [] })
  for (const [key, operator] of [['eq', '='], ['gte', '>='], ['lte', '<=']] as const)
    if (value[key] !== undefined) clauses.push({ sql: `coalesce(${expr}${operator}?,0)`, params: [value[key]!] })
  return combine(clauses)
}

/** One parameterized relation defines entities, counts, facets and queue materialization. */
export class LibraryDatabaseFocus {
  private readonly owner: MusicFocusOwner
  private collections = new Map<string, string>()
  private clock = 0
  constructor(owner: MusicFocusOwner) {
    this.owner = owner
    // Same UDF contract as GenreBrowse; this name avoids replacing its live closure.
    owner.sql.function('focus_collection', key => this.collections.get(String(key)) ?? null)
  }
  private get sql() { return this.owner.sql }
  private valid(name: string, value: unknown) { if (!validMusicFocusPayload(name, value)) throw invalid() }
  private transaction<T>(action: () => T): T { return this.sql.isTransaction ? action() : this.owner.transaction(action) }
  private read<T>(action: () => T): T {
    const own = !this.sql.isTransaction, previous = this.clock
    this.clock = this.owner.now?.() ?? Date.now()
    try { if (own) this.sql.exec('BEGIN'); const result = action(); if (own) this.sql.exec('COMMIT'); return result }
    catch (error) { if (own && this.sql.isTransaction) this.sql.exec('ROLLBACK'); throw error }
    finally { this.clock = previous }
  }
  state(): MusicFocusState {
    return this.read(() => ({
      savedRevision: this.savedRevision(),
      catalogRevision: Number(this.sql.prepare("SELECT value FROM catalog_state WHERE key='revision'").get()!.value),
      contentRevision: this.owner.contentRevision(), genresRevision: Number(this.sql.prepare("SELECT value FROM music_genre_state WHERE key='revision'").get()!.value),
      metadataRevision: this.owner.metadataRevision(), ratingsRevision: Number(this.sql.prepare("SELECT revision FROM personal_ratings_state WHERE profile_id='default'").get()!.revision),
      preferencesRevision: Number(this.sql.prepare("SELECT revision FROM personal_preferences_state WHERE profile_id='default'").get()!.revision),
      tagsRevision: Number(this.sql.prepare("SELECT revision FROM personal_tags_state WHERE profile_id='default'").get()!.revision),
      linkRevision: Number(this.sql.prepare("SELECT link_revision FROM personal_tags_state WHERE profile_id='default'").get()!.link_revision),
      historyRevision: Number(this.sql.prepare("SELECT value FROM meta WHERE key='history_revision'").get()!.value)
    }))
  }
  private savedRevision() { return Number(this.sql.prepare("SELECT revision FROM personal_focus_state WHERE profile_id='default'").get()!.revision) }
  private token(query: MusicFocusQuery, expected?: MusicFocusToken, context: MusicFocusReadContext = {}): MusicFocusToken {
    const now = this.clock, token = { ...this.state(), queryKey: musicFocusQueryKey(query), asOf: expected?.asOf ?? now,
      ...classificationDimensionsContext(this.sql, context, now) }
    if (expected && (expected.asOf > now || (expected.expiresAt !== null && expected.expiresAt <= now) || !sameFocusToken(expected, token))) throw stale()
    this.collections = genreBrowseCollectionMap(this.owner.albumAliases())
    return token
  }
  private finish(token: MusicFocusToken) { if (token.expiresAt !== null && (this.owner.now?.() ?? Date.now()) >= token.expiresAt) throw stale() }
  private source(value: MusicFocusSource, alias = 's'): Sql {
    const conditions: Sql[] = []
    if (value.provider !== undefined) conditions.push({ sql: `${alias}.provider=?`, params: [value.provider] })
    if (value.format !== undefined) conditions.push({ sql: `EXISTS(SELECT 1 FROM source_dimensions d WHERE d.source_id=${alias}.id AND d.dimension='format' AND d.value=?)`, params: [value.format.trim().toUpperCase()] })
    for (const field of ['bitDepth', 'sampleRate'] as const) if (value[field]) {
      const expr = `(SELECT CAST(d.value AS INTEGER) FROM source_dimensions d WHERE d.source_id=${alias}.id AND d.dimension='${field}' AND d.value<>'unknown' LIMIT 1)`
      conditions.push(numeric(expr, value[field]!))
    }
    return combine(conditions)
  }
  /** Source-local leaves carry the exact candidate set forward into playback. */
  private sourceLeaf(node: MusicFocusNode, alias = 's'): Sql | null {
    if ('source' in node) return this.source(node.source, alias)
    if ('automaticPlaybackBlocked' in node) return { sql: `${alias}.blocked=?`, params: [Number(node.automaticPlaybackBlocked)] }
    if ('classification' in node) return { sql: `EXISTS(SELECT 1 FROM source_dimensions d WHERE d.source_id=${alias}.id AND d.dimension=? AND d.value IN (${node.classification.values.map(() => '?').join(',')}))`, params: [node.classification.dimension, ...node.classification.values] }
    if ('year' in node) {
      const dimension = node.year.target === 'project' ? 'projectYear' : 'releaseYear'
      const known = `SELECT 1 FROM source_dimensions d WHERE d.source_id=${alias}.id AND d.dimension='${dimension}' AND d.value<>'unknown'`
      if (node.year.exists === false) return { sql: `NOT EXISTS(${known})`, params: [] }
      const comparison = numeric('CAST(d.value AS INTEGER)', node.year)
      return { sql: `EXISTS(${known} AND ${comparison.sql})`, params: comparison.params }
    }
    return null
  }
  private predicate(node: MusicFocusNode): Sql {
    if ('all' in node) return combine(node.all.map(n => this.predicate(n)))
    if ('any' in node) return combine(node.any.map(n => this.predicate(n)), 'OR', '0')
    if ('not' in node) { const p = this.predicate(node.not); return { sql: `NOT (${p.sql})`, params: p.params } }
    const source = this.sourceLeaf(node)
    if (source) return { sql: `EXISTS(SELECT 1 FROM focus_sources s WHERE s.group_key=e.group_key AND ${source.sql})`, params: source.params }
    if ('genre' in node) return { sql: `e.group_key IN (SELECT eg.group_key FROM focus_genres eg JOIN focus_genre_tree gt ON gt.ancestor=? AND gt.id=eg.genre_id WHERE (?=1 OR gt.id=gt.ancestor))`, params: [node.genre.id, Number(node.genre.includeDescendants ?? false)] }
    if ('rating' in node) return numeric(node.rating.mode === 'base' ? 'NULL' : 'e.personal_rating', { ...(node.rating.gteStars !== undefined ? { gte: node.rating.gteStars } : {}), ...(node.rating.lteStars !== undefined ? { lte: node.rating.lteStars } : {}), ...(node.rating.exists !== undefined ? { exists: node.rating.exists } : {}) })
    if ('tag' in node) return { sql: `EXISTS(SELECT 1 FROM focus_sources ts JOIN personal_tag_members tm ON tm.profile_id='default' AND tm.tag_id=? AND (tm.entity_id=ts.${this.kind === 'recording' ? 'recording_id' : 'release_id'} ${this.kind === 'recording' ? 'OR tm.entity_id=ts.release_id' : ''}) WHERE ts.group_key=e.group_key)`, params: [node.tag.id] }
    if ('preference' in node) return { sql: 'e.preference=?', params: [node.preference] }
    if ('lastPlayed' in node) return numeric('e.last_played', node.lastPlayed)
    if ('notPlayedWithinDays' in node) return { sql: '(e.last_played IS NULL OR e.last_played<(SELECT as_of FROM dimension_clock)-?)', params: [node.notPlayedWithinDays * 86400000] }
    if ('text' in node) return { sql: '(instr(lower(e.title),lower(?))>0 OR instr(lower(e.artist),lower(?))>0)', params: [node.text, node.text] }
    throw invalid()
  }
  private hasSource(node: MusicFocusNode): boolean {
    if ('all' in node) return node.all.some(n => this.hasSource(n))
    if ('any' in node) return node.any.some(n => this.hasSource(n))
    if ('not' in node) return false
    if ('automaticPlaybackBlocked' in node) return false
    return this.sourceLeaf(node) !== null
  }
  private needsBlocked(node?: MusicFocusNode): boolean {
    if (!node) return false
    if ('all' in node) return node.all.some(n => this.needsBlocked(n))
    if ('any' in node) return node.any.some(n => this.needsBlocked(n))
    if ('not' in node) return this.needsBlocked(node.not)
    return 'automaticPlaybackBlocked' in node
  }
  private mandatoryAutomatic(node: MusicFocusNode): Sql {
    if ('all' in node) return combine(node.all.map(n => this.mandatoryAutomatic(n)))
    if ('any' in node) return combine(node.any.map(n => this.mandatoryAutomatic(n)), 'OR', '0')
    if ('automaticPlaybackBlocked' in node) return this.sourceLeaf(node)!
    return { sql: '1', params: [] }
  }
  private range(node: MusicFocusNode): Sql {
    if ('all' in node) {
      const full = this.predicate(node), constrained = node.all.filter(n => this.hasSource(n))
      return combine([full, ...(constrained.length ? [combine(constrained.map(n => this.range(n)), 'OR', '0')] : []),
        ...node.all.filter(n => !this.hasSource(n)).map(n => this.range(n)), this.mandatoryAutomatic(node)])
    }
    if ('any' in node) return combine(node.any.map(n => this.range(n)), 'OR', '0')
    return this.sourceLeaf(node) ?? this.predicate(node)
  }
  private kind: 'recording' | 'release' = 'recording'
  private dimensions(node?: MusicFocusNode, facet?: ClassificationDimension): ClassificationDimension[] {
    const result = new Set<ClassificationDimension>(['releaseYear'])
    if (facet) result.add(facet)
    const visit = (value: MusicFocusNode) => {
      if ('all' in value) value.all.forEach(visit)
      else if ('any' in value) value.any.forEach(visit)
      else if ('not' in value) visit(value.not)
      else if ('classification' in value) result.add(value.classification.dimension)
      else if ('year' in value) result.add(value.year.target === 'project' ? 'projectYear' : 'releaseYear')
      else if ('source' in value) for (const dimension of ['format', 'bitDepth', 'sampleRate'] as const) {
        if (value.source[dimension] !== undefined) result.add(dimension)
      }
    }
    if (node) visit(node)
    return [...result]
  }
  private compile(query: MusicFocusQuery, token: MusicFocusToken, context: MusicFocusReadContext, anchorSourceId?: string, facet?: ClassificationDimension): Sql {
    this.kind = query.entity
    const dimensions = classificationDimensionsCtes(query.entity, token.asOf, context, this.clock, this.dimensions(query.where, facet))
    const base = genreBrowseCtes({ ctes: dimensions.sql, physical: true, scope: query.scope ?? 'library', kind: query.entity }).replaceAll('genre_browse_collection(', 'focus_collection(')
    const where = query.where ? this.predicate(query.where) : { sql: '1', params: [] }
    const range = query.where ? this.range(query.where) : { sql: '1', params: [] }
    const physical = query.entity === 'recording' ? 'recording_id' : 'release_id'
    // The membership test is independent of cached scope and is also the only playback input.
    const member = `EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)
      AND (s.provider<>'local' OR (EXISTS(SELECT 1 FROM tracks t WHERE t.id=s.track_id)
        AND NOT EXISTS(SELECT 1 FROM catalog_pending p WHERE p.track_id=s.track_id)))`
    const key = (entity: string, kind: string) => `coalesce((SELECT json_array('identity','${kind}',l.target_id) FROM metadata_identity_links l JOIN metadata_entities me ON me.id=l.target_id AND me.kind='${kind}' WHERE l.entity_id=${entity} AND l.kind='${kind}' AND l.state='confirmed'),json_array('entity','${kind}',${entity}))`
    const blocked = this.needsBlocked(query.where) ? `CASE WHEN
      EXISTS(SELECT 1 FROM personal_preference_values p WHERE p.profile_id='default' AND p.state='ban'
        AND p.target_key=${key('s.recording', 'recording')})
      OR (s.release IS NOT NULL AND EXISTS(SELECT 1 FROM personal_preference_values p
        WHERE p.profile_id='default' AND p.state='ban' AND p.target_key=${key('s.release', 'release')}))
      OR EXISTS(SELECT 1 FROM catalog_source_artists a JOIN metadata_identity_links l ON l.entity_id=a.artist_id
        AND l.kind='artist' AND l.state='confirmed' JOIN metadata_entities me ON me.id=l.target_id AND me.kind='artist'
        JOIN personal_preference_values p ON p.profile_id='default' AND p.state='ban'
          AND p.target_key=json_array('identity','artist',l.target_id) WHERE a.source_id=s.id)
      THEN 1 ELSE 0 END` : '0'
    return { params: [null, 0, null, '', query.entity, null, ...dimensions.params, ...where.params, ...range.params, ...(anchorSourceId ? [anchorSourceId] : [])], sql: `WITH RECURSIVE ${base},
      focus_genre_tree(ancestor,id) AS (SELECT id,id FROM music_genres UNION SELECT p.ancestor,g.id FROM focus_genre_tree p JOIN music_genres g ON g.parent_id=p.id),
      focus_physical AS MATERIALIZED (
        SELECT ce.id,${key('ce.id', query.entity)} group_key FROM catalog_entities ce
        WHERE ce.kind='${query.entity}' AND ce.identity='source'),
      focus_members AS MATERIALIZED (
        SELECT DISTINCT fp.* FROM scoped_sources s JOIN focus_physical fp ON fp.id=s.${query.entity}),
      focus_source_values AS (
        SELECT s.id,s.provider,s.recording recording_id,s.release release_id,s.preferred_recording,
          ${query.entity === 'release' ? "json_extract(c.payload,'$.discNumber')" : 'NULL'} disc_number,
          ${query.entity === 'release' ? "json_extract(c.payload,'$.trackNumber')" : 'NULL'} track_number,
          fp.group_key,${query.scope === 'catalog' ? `CASE WHEN ${member} THEN 1 ELSE 0 END` : '1'} in_library,
          CASE WHEN added.value<>'' AND added.value NOT GLOB '*[^0-9]*' AND CAST(added.value AS INTEGER) BETWEEN 0 AND 9007199254740991 THEN CAST(added.value AS INTEGER) END member_added,
          ${blocked} blocked
        FROM scoped_sources s JOIN focus_members fp ON fp.id=s.${query.entity}
        ${query.entity === 'release' ? 'JOIN catalog_sources c ON c.id=s.id' : ''}
        LEFT JOIN catalog_state added ON added.key='membership_added:'||s.id),
      focus_sources AS MATERIALIZED (SELECT * FROM focus_source_values),
      focus_genres AS MATERIALIZED (
        SELECT DISTINCT fm.group_key,eg.genre_id FROM focus_members fm JOIN entity_genres eg ON eg.entity_id=fm.id
        WHERE '${query.entity}'='recording' OR NOT EXISTS(SELECT 1 FROM focus_members dm JOIN entity_direct ed ON ed.entity_id=dm.id WHERE dm.group_key=fm.group_key)
          OR EXISTS(SELECT 1 FROM entity_direct ed WHERE ed.entity_id=fm.id)),
      focus_history AS (
        SELECT fp.group_key,max(h.last_played) last_played FROM focus_physical fp JOIN catalog_sources s ON s.${physical}=fp.id
        JOIN library_history h ON h.id=json_array('focus-source-v1',s.provider,
          CASE WHEN s.provider<>'local' AND substr(s.track_id,1,length(s.provider)+1)=s.provider||':' THEN substr(s.track_id,length(s.provider)+2) ELSE s.track_id END)
        WHERE h.last_played>0 GROUP BY fp.group_key),
      focus_values AS MATERIALIZED (
        SELECT fm.group_key,min(fm.id) id,rv.steps/2.0 personal_rating,coalesce(pv.state,'none') preference,h.last_played
        FROM focus_members fm LEFT JOIN personal_rating_values rv ON rv.profile_id='default' AND rv.target_key=fm.group_key
        LEFT JOIN personal_preference_values pv ON pv.profile_id='default' AND pv.target_key=fm.group_key
        LEFT JOIN focus_history h ON h.group_key=fm.group_key GROUP BY fm.group_key),
      focus_entities AS (SELECT v.*,ce.title,ce.artist FROM focus_values v CROSS JOIN catalog_entities ce ON ce.id=v.id),
      focus_matches AS MATERIALIZED (SELECT e.* FROM focus_entities e WHERE ${where.sql}),
      focus_matched_sources AS MATERIALIZED (SELECT s.* FROM focus_sources s JOIN focus_matches e ON e.group_key=s.group_key WHERE ${range.sql}),
      focus_result_years AS (
        SELECT fs.group_key,max(CAST(d.value AS INTEGER)) release_year FROM focus_matched_sources fs
        JOIN source_dimensions d ON d.source_id=fs.id
        WHERE d.dimension='releaseYear' AND d.value<>'unknown' GROUP BY fs.group_key),
      focus_source_counts AS (SELECT group_key,count(*) source_count FROM focus_matched_sources GROUP BY group_key),
      focus_source_ranked AS (SELECT group_key,id,provider,in_library,
        row_number() OVER(PARTITION BY group_key ORDER BY in_library DESC,preferred_recording DESC,member_added IS NULL,member_added,id) choice FROM focus_matched_sources),
      focus_results AS MATERIALIZED (SELECT e.group_key,e.id,e.personal_rating,e.preference,e.last_played,e.title,e.artist,
        y.release_year,r.id source_id,r.provider,r.in_library,c.source_count
        FROM focus_matches e JOIN focus_source_ranked r ON r.group_key=e.group_key AND r.choice=1
        JOIN focus_source_counts c ON c.group_key=e.group_key LEFT JOIN focus_result_years y ON y.group_key=e.group_key),
      focus_play_candidates AS (
        SELECT s.*,${key('s.recording_id', 'recording')} recording_key FROM focus_matched_sources s WHERE s.in_library=1),
      focus_play_ranked AS (SELECT s.*,row_number() OVER(PARTITION BY recording_key ORDER BY ${anchorSourceId ? 'CASE WHEN s.id=? THEN 0 ELSE 1 END,' : ''}preferred_recording DESC,member_added IS NULL,member_added,id) recording_choice FROM focus_play_candidates s),
      focus_play AS (SELECT s.*,e.title entity_title,e.artist entity_artist,e.personal_rating,e.last_played,e.release_year FROM focus_play_ranked s JOIN focus_results e ON e.group_key=s.group_key WHERE s.recording_choice=1)
    ` }
  }
  private order(query: MusicFocusQuery, playback = false) {
    const fields = { title: playback ? 'entity_title' : 'title', artist: playback ? 'entity_artist' : 'artist', personalRating: 'personal_rating', lastPlayed: 'last_played', releaseYear: 'release_year' }
    return [...(query.sort ?? [{ field: 'title' as const, direction: 'asc' as const }]).flatMap(s => [`${fields[s.field]} IS NULL`, `${fields[s.field]} ${s.direction.toUpperCase()}`]), playback
      ? `group_key,${query.entity === 'release' ? 'coalesce(disc_number,0),coalesce(track_number,0),' : ''}recording_key,id`
      : 'id'].join(',')
  }
  private item(row: Row, kind: 'recording' | 'release'): MusicFocusItem {
    return { id: String(row.id), kind, title: String(row.title), artist: String(row.artist), sourceCount: Number(row.source_count),
      inLibrary: !!row.in_library, playable: !!row.in_library, sourceId: row.in_library ? String(row.source_id) : null, provider: row.provider == null ? null : String(row.provider),
      personalRating: row.personal_rating == null ? null : Number(row.personal_rating), lastPlayed: row.last_played == null ? null : Number(row.last_played), releaseYear: row.release_year == null ? null : Number(row.release_year) }
  }
  query(input: MusicFocusPageQuery, context: MusicFocusReadContext = {}): MusicFocusPage {
    this.valid('focus.query', input)
    return this.read(() => {
      const token = this.token(input.query, input.token, context), cte = this.compile(input.query, token, context), offset = input.offset ?? 0
      const rows = this.sql.prepare(`${cte.sql}, focus_page AS (
        SELECT * FROM focus_results ORDER BY ${this.order(input.query)} LIMIT ? OFFSET ?)
        SELECT p.*,t.total FROM (SELECT count(*) total FROM focus_results) t LEFT JOIN focus_page p ON 1
        ORDER BY ${this.order(input.query)}`).all(...cte.params, input.limit ?? 50, offset)
      const total = Number(rows[0].total)
      const items = rows.filter(row => row.id !== null).map(r => this.item(r, input.query.entity))
      this.finish(token); return { token, offset, total, items }
    })
  }
  facets(input: MusicFocusFacetsQuery, context: MusicFocusReadContext = {}): MusicFocusFacetsPage {
    this.valid('focus.facets', input)
    return this.read(() => {
      const token = this.token(input.query, input.token, context),
        cte = this.compile(input.query, token, context, undefined, ['genre', 'provider', 'personalRating', 'preference'].includes(input.facet) ? undefined : input.facet as ClassificationDimension),
        offset = input.offset ?? 0, params = [...cte.params]
      let select: string
      if (input.facet === 'genre') select = `SELECT gt.ancestor value,g.name label,count(DISTINCT r.group_key) count FROM focus_results r JOIN focus_genres eg ON eg.group_key=r.group_key JOIN focus_genre_tree gt ON gt.id=eg.genre_id JOIN music_genres g ON g.id=gt.ancestor GROUP BY gt.ancestor`
      else if (input.facet === 'provider') select = `SELECT s.provider value,s.provider label,count(DISTINCT s.group_key) count FROM focus_matched_sources s GROUP BY s.provider`
      else if (input.facet === 'personalRating') select = `SELECT coalesce(CAST(personal_rating AS TEXT),'unknown') value,coalesce(CAST(personal_rating AS TEXT),'未评分') label,count(*) count FROM focus_results GROUP BY personal_rating`
      else if (input.facet === 'preference') select = `SELECT preference value,preference label,count(*) count FROM focus_results GROUP BY preference`
      else { select = `SELECT d.value,d.value label,count(DISTINCT s.group_key) count FROM focus_matched_sources s JOIN source_dimensions d ON d.source_id=s.id WHERE d.dimension=? GROUP BY d.value`; params.push(input.facet) }
      const rows = this.sql.prepare(`${cte.sql}, focus_facet_values AS MATERIALIZED (${select}), focus_facet_page AS (
        SELECT * FROM focus_facet_values ORDER BY count DESC,value LIMIT ? OFFSET ?)
        SELECT p.*,t.total FROM (SELECT count(*) total FROM focus_facet_values) t LEFT JOIN focus_facet_page p ON 1
        ORDER BY count DESC,value`).all(...params, input.limit ?? 50, offset)
      const total = Number(rows[0].total)
      const items = rows.filter(r => r.value !== null).map(r => ({ value: String(r.value), label: ['genre', 'provider', 'personalRating', 'preference'].includes(input.facet) ? String(r.label) : classificationFacetLabel(input.facet as ClassificationDimension, String(r.value)), count: Number(r.count) }))
      this.finish(token); return { token, facet: input.facet, offset, total, items }
    })
  }
  playbackPage(input: MusicFocusPlaybackPageQuery, context: MusicFocusReadContext = {}): MusicFocusPlaybackPage {
    if (!validMusicFocusPlaybackPageQuery(input)) throw invalid()
    return this.read(() => {
      const token = this.token(input.query, input.token, context), cte = this.compile(input.query, token, context, input.anchorSourceId), offset = input.offset ?? 0
      const total = Number(this.sql.prepare(`${cte.sql} SELECT count(*) n FROM focus_play`).get(...cte.params)!.n)
      const items = this.sql.prepare(`${cte.sql} SELECT * FROM focus_play ORDER BY ${this.order(input.query, true)} LIMIT ? OFFSET ?`).all(...cte.params, input.limit ?? 50, offset).map(row => {
        const sourceId = String(row.id), track = this.owner.resolve(sourceId, token.catalogRevision)
        if (!track) throw stale()
        return { recordingId: String(row.recording_id), sourceId, provider: String(row.provider), track }
      })
      this.finish(token); return { token, offset, total, items }
    })
  }
  private decodeSaved(row: Row): MusicFocusSaved { return { id: String(row.id), name: String(row.name), query: JSON.parse(String(row.query)) as MusicFocusQuery, nameRevision: Number(row.name_revision), queryRevision: Number(row.query_revision), updatedAt: Number(row.updated_at) } }
  private saved(id: string): MusicFocusSaved { const row = this.sql.prepare("SELECT * FROM personal_focus_queries WHERE profile_id='default' AND id=?").get(id); if (!row) throw new Error('此 Focus 已删除，请刷新后重试'); return this.decodeSaved(row) }
  private bump() { this.sql.prepare("UPDATE personal_focus_state SET revision=revision+1 WHERE profile_id='default'").run() }
  private unique(name: string, except = '') { if (this.sql.prepare("SELECT 1 FROM personal_focus_queries WHERE profile_id='default' AND normalized_name=? AND id<>?").get(normalizeMusicFocusName(name), except)) throw conflict() }
  private now(value: number) { if (!Number.isSafeInteger(value) || value < 0) throw invalid() }
  savedList(input: MusicFocusSavedListQuery = {}): MusicFocusSavedPage {
    this.valid('focus.saved.list', input)
    return this.read(() => {
      const savedRevision = this.savedRevision(), offset = input.offset ?? 0, search = normalizeMusicFocusName(input.search ?? '')
      if (input.savedRevision !== undefined && input.savedRevision !== savedRevision) throw stale()
      const from = "FROM personal_focus_queries WHERE profile_id='default' AND instr(normalized_name,?)>0"
      return { savedRevision, offset, total: Number(this.sql.prepare(`SELECT count(*) n ${from}`).get(search)!.n), items: this.sql.prepare(`SELECT * ${from} ORDER BY normalized_name,id LIMIT ? OFFSET ?`).all(search, input.limit ?? 50, offset).map(r => this.decodeSaved(r)) }
    })
  }
  savedCreate(input: MusicFocusCreate, now: number): MusicFocusWriteResult {
    this.valid('focus.saved.create', input); this.now(now)
    return this.transaction(() => {
      if (input.savedRevision !== this.savedRevision()) throw stale(); this.unique(input.name)
      const id = `focus:${randomUUID()}`
      this.sql.prepare("INSERT INTO personal_focus_queries VALUES('default',?,?,?,?,1,1,?)").run(id, displayName(input.name), normalizeMusicFocusName(input.name), JSON.stringify(input.query), now)
      this.bump(); return { savedRevision: this.savedRevision(), item: this.saved(id) }
    })
  }
  savedRename(input: MusicFocusRename, now: number): MusicFocusWriteResult {
    this.valid('focus.saved.rename', input); this.now(now)
    return this.transaction(() => {
      const item = this.saved(input.id); if (item.nameRevision !== input.nameRevision) throw stale(); this.unique(input.name, input.id)
      if (item.name !== displayName(input.name)) { this.sql.prepare("UPDATE personal_focus_queries SET name=?,normalized_name=?,name_revision=name_revision+1,updated_at=? WHERE profile_id='default' AND id=?").run(displayName(input.name), normalizeMusicFocusName(input.name), now, input.id); this.bump() }
      return { savedRevision: this.savedRevision(), item: this.saved(input.id) }
    })
  }
  savedUpdate(input: MusicFocusUpdate, now: number): MusicFocusWriteResult {
    this.valid('focus.saved.update', input); this.now(now)
    return this.transaction(() => {
      const item = this.saved(input.id); if (item.queryRevision !== input.queryRevision) throw stale()
      if (musicFocusQueryKey(item.query) !== musicFocusQueryKey(input.query)) { this.sql.prepare("UPDATE personal_focus_queries SET query=?,query_revision=query_revision+1,updated_at=? WHERE profile_id='default' AND id=?").run(JSON.stringify(input.query), now, input.id); this.bump() }
      return { savedRevision: this.savedRevision(), item: this.saved(input.id) }
    })
  }
  savedDelete(input: MusicFocusDelete): MusicFocusDeleteResult {
    this.valid('focus.saved.delete', input)
    return this.transaction(() => {
      const item = this.saved(input.id); if (item.nameRevision !== input.nameRevision || item.queryRevision !== input.queryRevision) throw stale()
      this.sql.prepare("DELETE FROM personal_focus_queries WHERE profile_id='default' AND id=?").run(input.id); this.bump()
      return { savedRevision: this.savedRevision(), deletedId: input.id }
    })
  }
}
