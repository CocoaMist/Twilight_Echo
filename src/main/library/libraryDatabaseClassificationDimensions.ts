import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import {
  CLASSIFICATION_DIMENSIONS,
  validClassificationFilters,
  validClassificationFacetQuery,
  type ClassificationDimension,
  type ClassificationFilter,
  type ClassificationFacetQuery
} from '../../shared/musicClassificationDimensions.ts'

/** Private Core/database input. Never accepted from a public browse request. */
export interface ClassificationReadContext {
  platformContexts?: Record<string, string>
}
export interface ClassificationSql {
  sql: string
  params: SQLInputValue[]
}
const invalid = () => Object.assign(new Error('分类筛选参数无效'), { code: 'INVALID_PAYLOAD' })
const contexts = (context: ClassificationReadContext) =>
  Object.entries(context.platformContexts ?? {})
    .filter(([provider, value]) => !!provider && typeof value === 'string' && !!value)
    .sort(([a], [b]) => a.localeCompare(b))
const contextRows = (context: ClassificationReadContext): ClassificationSql => {
  const entries = contexts(context)
  return entries.length
    ? { sql: `VALUES ${entries.map(() => '(?,?)').join(',')}`, params: entries.flat() }
    : { sql: 'SELECT NULL,NULL WHERE 0', params: [] }
}
const usableFact = (fact: string, source: string, asOf: string) => `
  (json_type(${fact}.payload,'$.usage') IS NULL OR
    (json_extract(${fact}.payload,'$.usage.display')=1 AND json_extract(${fact}.payload,'$.usage.cache')=1))
  AND (json_extract(${fact}.payload,'$.usage.expiresAt') IS NULL OR
    json_extract(${fact}.payload,'$.usage.expiresAt')>${asOf})
  AND (json_extract(${fact}.payload,'$.sourceProvider') IS NULL OR
    (EXISTS(SELECT 1 FROM dimension_platform_contexts pc
      WHERE pc.provider=json_extract(${fact}.payload,'$.sourceProvider')
      AND pc.context=json_extract(${fact}.payload,'$.providerContext'))
    AND (json_extract(${fact}.payload,'$.usage.crossSource')=1 OR
      json_extract(${fact}.payload,'$.sourceProvider')=${source}.provider)))`

/** Only actual calendar dates produce a year; never extract four digits from an album title. */
const year = (value: string) => `CASE WHEN
  (length(${value})=4 AND ${value} GLOB '[0-9][0-9][0-9][0-9]' AND CAST(${value} AS INTEGER)>0)
  OR (length(${value})=7 AND ${value} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
    AND CAST(substr(${value},1,4) AS INTEGER)>0 AND CAST(substr(${value},6,2) AS INTEGER) BETWEEN 1 AND 12)
  OR (length(${value})>=10 AND substr(${value},1,10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND CAST(substr(${value},1,4) AS INTEGER)>0
    AND strftime('%Y-%m-%d',substr(${value},1,10),'+0 days')=substr(${value},1,10)
    AND (length(${value})=10 OR (substr(${value},11,1)='T' AND julianday(${value}) IS NOT NULL)))
  THEN substr(${value},1,4) END`

/** CTE list (without WITH), using the browse repository's real-member scoped_sources. */
export function classificationDimensionsCtes(
  kind: 'recording' | 'release',
  asOf: number,
  context: ClassificationReadContext = {},
  now = asOf,
  requestedDimensions: readonly ClassificationDimension[] = CLASSIFICATION_DIMENSIONS
): ClassificationSql {
  if (
    !['recording', 'release'].includes(kind) ||
    !Number.isSafeInteger(asOf) ||
    asOf < 0 ||
    !Number.isSafeInteger(now) ||
    now < asOf
  )
    throw invalid()
  const platform = contextRows(context)
  const target = kind === 'recording' ? 's.recording' : 's.release'
  // Generate only dimensions consumed by this query. In particular a release-year
  // sort must not materialize every format/management/unknown row in a large library.
  const selected = new Set(requestedDimensions)
  const known: Array<[ClassificationDimension, string]> = [
    ['format', `SELECT s.id,'format',upper(trim(json_extract(c.payload,'$.format'))) FROM scoped_sources s
      JOIN catalog_sources c ON c.id=s.id WHERE json_type(c.payload,'$.format')='text'
      AND length(trim(json_extract(c.payload,'$.format'))) BETWEEN 1 AND 64`],
    ['bitDepth', `SELECT s.id,'bitDepth',CAST(CAST(json_extract(c.payload,'$.bitDepth') AS INTEGER) AS TEXT) FROM scoped_sources s
      JOIN catalog_sources c ON c.id=s.id WHERE json_type(c.payload,'$.bitDepth') IN ('integer','real')
      AND json_extract(c.payload,'$.bitDepth')>0
      AND json_extract(c.payload,'$.bitDepth')=CAST(json_extract(c.payload,'$.bitDepth') AS INTEGER)`],
    ['sampleRate', `SELECT s.id,'sampleRate',CAST(CAST(json_extract(c.payload,'$.sampleRate') AS INTEGER) AS TEXT) FROM scoped_sources s
      JOIN catalog_sources c ON c.id=s.id WHERE json_type(c.payload,'$.sampleRate') IN ('integer','real')
      AND json_extract(c.payload,'$.sampleRate')>0
      AND json_extract(c.payload,'$.sampleRate')=CAST(json_extract(c.payload,'$.sampleRate') AS INTEGER)`],
    ['region', `SELECT source_id,'region',upper(trim(value)) FROM dimension_facts
      WHERE kind='release' AND field='country' AND upper(trim(value)) GLOB '[A-Z][A-Z]'`],
    ['projectYear', `SELECT source_id,'projectYear',${year('value')} FROM dimension_facts WHERE kind='album_project' AND field='firstReleaseDate'`],
    ['releaseYear', `SELECT source_id,'releaseYear',value FROM dimension_release_years WHERE value IS NOT NULL`],
    ['releaseYear', `SELECT s.id,'releaseYear',${year("json_extract(c.payload,'$.releaseDate')")} FROM scoped_sources s
      JOIN catalog_sources c ON c.id=s.id
      WHERE NOT EXISTS(SELECT 1 FROM dimension_release_years r WHERE r.source_id=s.id AND r.value IS NOT NULL)`],
    ['albumType', `SELECT source_id,'albumType',lower(trim(value)) FROM dimension_facts
      WHERE kind='album_project' AND field='primaryType' AND lower(trim(value)) IN ('album','single','ep','compilation','broadcast','other')`],
    ['management', `SELECT s.id,'management',CASE WHEN EXISTS(SELECT 1 FROM metadata_identity_links l
      WHERE l.entity_id=${target} AND l.state='confirmed') THEN 'identified' ELSE 'unidentified' END FROM scoped_sources s`],
    ['management', `SELECT s.id,'management',CASE WHEN EXISTS(SELECT 1 FROM metadata_identity_links l
      WHERE l.entity_id=s.release AND l.state='confirmed') THEN 'release_confirmed' ELSE 'release_pending' END FROM scoped_sources s`],
    ['management', `SELECT s.id,'management',CASE WHEN s.availability='missing' THEN 'source_missing'
      WHEN s.availability='indexed' THEN 'source_indexed' ELSE 'source_unknown' END FROM scoped_sources s`],
    ['management', `SELECT s.id,'management',CASE WHEN
      (EXISTS(SELECT 1 FROM metadata_overrides o WHERE o.entity_id=${target}
        AND json_extract(o.payload,'$.mode')='value' AND length(trim(json_extract(o.payload,'$.value')))>0))
      OR (NOT EXISTS(SELECT 1 FROM metadata_overrides o WHERE o.entity_id=${target}) AND (
        EXISTS(SELECT 1 FROM dimension_facts f WHERE f.source_id=s.id AND f.entity_id=${target}
          AND f.field IN ('introduction','description') AND length(trim(f.value))>0)
        OR (s.provider='local' AND EXISTS(SELECT 1 FROM dimension_effective_imports i WHERE i.entity_id=${target}))))
      THEN 'has_introduction' ELSE 'missing_introduction' END FROM scoped_sources s`]
  ]
  return {
    params: [asOf, now, ...platform.params],
    sql: `dimension_clock(as_of,now) AS (VALUES (?,?)),
    dimension_platform_contexts(provider,context) AS (${platform.sql}),
    dimension_source_entities(source_id,entity_id,kind) AS (
      SELECT id,recording,'recording' FROM scoped_sources
      UNION ALL SELECT id,release,'release' FROM scoped_sources WHERE release IS NOT NULL
      UNION ALL SELECT s.id,p.project_id,'album_project' FROM scoped_sources s
        JOIN catalog_release_projects p ON p.release_id=s.release),
    dimension_facts AS (
      SELECT DISTINCT s.id source_id,m.entity_id,m.kind,f.field,json_extract(f.payload,'$.value') value
      FROM scoped_sources s JOIN dimension_source_entities m ON m.source_id=s.id
      JOIN metadata_identity_links l ON l.entity_id=m.entity_id AND l.state='confirmed'
      JOIN metadata_facts f ON f.target_id=l.target_id CROSS JOIN dimension_clock c
      WHERE f.field IN ('country','firstReleaseDate','releaseDate','primaryType','introduction','description')
        AND json_type(f.payload,'$.value')='text' AND ${usableFact('f', 's', 'c.as_of')}
        AND (json_extract(f.payload,'$.usage.expiresAt') IS NULL OR
          json_extract(f.payload,'$.usage.expiresAt')>c.now)),
    dimension_release_years AS (
      SELECT source_id,${year('value')} value FROM dimension_facts WHERE kind='release' AND field='releaseDate'),
    dimension_imports AS (
      SELECT b.entity_id,a.payload,a.disposition,row_number() OVER (
        PARTITION BY b.entity_id ORDER BY a.plugin_id,a.legacy_id) position
      FROM metadata_legacy_bindings b JOIN metadata_legacy_albums a USING(plugin_id,legacy_id)
      JOIN metadata_legacy_documents d USING(plugin_id)
      WHERE d.state='published'),
    dimension_import_descriptions AS (
      SELECT entity_id,substr(json_extract(payload,'$.description'),1,20000) description,
        coalesce(json_extract(payload,'$.descriptionSource.method'),'historical') method
      FROM dimension_imports WHERE position<=8 AND disposition='bound'
        AND json_type(payload,'$.description')='text' AND length(json_extract(payload,'$.description'))>0),
    dimension_effective_imports AS (
      SELECT i.entity_id FROM dimension_import_descriptions i WHERE i.method='external-ai'
        OR NOT EXISTS(SELECT 1 FROM dimension_import_descriptions ai
          WHERE ai.entity_id=i.entity_id AND ai.method='external-ai')
      GROUP BY i.entity_id HAVING count(DISTINCT i.description)=1),
    dimension_known_values(source_id,dimension,value) AS (
      ${known.filter(([dimension]) => selected.has(dimension)).map(([, query]) => query).join('\n UNION ALL ') || 'SELECT NULL,NULL,NULL WHERE 0'}),
    dimension_names(dimension) AS (${requestedDimensions.length ? `VALUES ${[...selected].map(d => `'${d}'`).map(d => `(${d})`).join(',')}` : 'SELECT NULL WHERE 0'}),
    source_dimensions AS (
      SELECT DISTINCT source_id,dimension,value FROM dimension_known_values WHERE value IS NOT NULL
      UNION ALL SELECT s.id,n.dimension,'unknown' FROM scoped_sources s CROSS JOIN dimension_names n
        WHERE NOT EXISTS(SELECT 1 FROM dimension_known_values v WHERE v.source_id=s.id
          AND v.dimension=n.dimension AND v.value IS NOT NULL))`
  }
}

/** The outer source alias is deliberately fixed; arbitrary SQL identifiers are not inputs. */
export function compileClassificationFilters(
  filters: ClassificationFilter[] = []
): ClassificationSql {
  if (!validClassificationFilters(filters)) throw invalid()
  return {
    sql: filters.length
      ? filters
          .map(
            (filter) => `EXISTS(SELECT 1 FROM source_dimensions d
      WHERE d.source_id=s.id AND d.dimension=? AND d.value IN (${filter.values.map(() => '?').join(',')}))`
          )
          .join(' AND ')
      : '1',
    params: filters.flatMap((filter) => [filter.dimension, ...filter.values])
  }
}

/** Aggregate only final matched members, retaining every active filter and distinct entities. */
export function classificationFacetSql(query: ClassificationFacetQuery): ClassificationSql {
  if (!validClassificationFacetQuery(query)) throw invalid()
  return {
    sql: `SELECT d.value,count(DISTINCT m.entity_id) count FROM matched_members m
      JOIN source_dimensions d ON d.source_id=m.source_id WHERE d.dimension=?
      ${query.facetSearch ? 'AND instr(lower(d.value),lower(?))>0' : ''} GROUP BY d.value`,
    params: [query.dimension, ...(query.facetSearch ? [query.facetSearch] : [])]
  }
}

const activeContexts = new WeakMap<DatabaseSync, { canonical: string; key: string }>()
/** Opaque keys invalidate on authorization changes and worker restart without exposing account context. */
export function classificationDimensionsContext(
  sql: DatabaseSync,
  context: ClassificationReadContext,
  now: number
): { contextKey: string; expiresAt: number | null } {
  const canonical = JSON.stringify(contexts(context))
  let current = activeContexts.get(sql)
  if (!current || current.canonical !== canonical) {
    current = { canonical, key: randomUUID() }
    activeContexts.set(sql, current)
  }
  const platform = contextRows(context)
  const row = sql
    .prepare(
      `WITH dimension_platform_contexts(provider,context) AS (${platform.sql})
    SELECT min(json_extract(f.payload,'$.usage.expiresAt')) expires_at FROM metadata_facts f
    WHERE json_extract(f.payload,'$.usage.expiresAt')>?
    AND EXISTS(SELECT 1 FROM catalog_sources s WHERE ${usableFact('f', 's', '?')})`
    )
    .get(...platform.params, now, now)
  return {
    contextKey: current.key,
    expiresAt: row?.expires_at == null ? null : Number(row.expires_at)
  }
}
