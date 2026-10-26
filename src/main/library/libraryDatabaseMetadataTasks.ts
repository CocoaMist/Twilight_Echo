import type { DatabaseSync } from 'node:sqlite'
import type { EntityMetadataJob, EntityMetadataState } from '../../shared/entityMetadata.ts'
import type { CatalogEntityReference, CatalogKind } from '../../shared/musicCatalog.ts'
import {
  METADATA_ACTIVE_STATES,
  METADATA_ATTENTION_STATES,
  validMetadataTasksPayload,
  type MetadataTasksQuery,
  type MetadataTasksPage,
  type MetadataTaskDemandsQuery,
  type MetadataTaskDemandsPage
} from '../../shared/entityMetadataTasks.ts'

type Row = Record<string, unknown>
const liveSource = `s.availability<>'missing'
  AND EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)
  AND (s.provider<>'local' OR (EXISTS(SELECT 1 FROM tracks t WHERE t.id=s.track_id)
    AND NOT EXISTS(SELECT 1 FROM catalog_pending p WHERE p.track_id=s.track_id)))`

function hasLiveNativeEntity(
  sql: DatabaseSync,
  entityId: string,
  kind: Exclude<CatalogKind, 'album_project'>
): boolean {
  if (kind === 'artist')
    return !!sql.prepare(`SELECT 1 FROM catalog_source_artists a
      JOIN catalog_sources s ON s.id=a.source_id
      WHERE a.artist_id=? AND ${liveSource} LIMIT 1`).get(entityId)
  const scope = kind === 'recording' ? 'tracks' : 'albums'
  const field = kind === 'recording' ? 'recording_id' : 'release_id'
  const key = kind === 'recording' ? 'source_key' : 'album_key'
  // Seek native candidates by their existing index, then apply any manual binding.
  // A source reassigned to a version must not keep its old entity reviewable.
  return !!sql.prepare(`SELECT 1 FROM catalog_sources s
    LEFT JOIN catalog_version_sources b ON b.scope='${scope}' AND b.source_key=s.${key}
    LEFT JOIN catalog_versions v ON v.scope=b.scope AND v.id=b.version_id
    WHERE s.${field}=? AND coalesce(v.entity_id,s.${field})=? AND ${liveSource} LIMIT 1`)
    .get(entityId, entityId)
}

/** Resolve only reviewable entities on this page, never the global UNION of source bindings. */
function liveReviewEntities(sql: DatabaseSync, entities: Array<{ id: string; kind: CatalogKind }>) {
  const targets = new Map<string, { id: string; kind: Exclude<CatalogKind, 'album_project'> }>()
  for (const entity of entities) {
    if (targets.has(entity.id)) continue
    if (entity.kind !== 'album_project') targets.set(entity.id, { ...entity, kind: entity.kind })
    else {
      const project = sql.prepare('SELECT release_id FROM catalog_release_projects WHERE project_id=?')
        .get(entity.id)
      if (project) targets.set(entity.id, { id: String(project.release_id), kind: 'release' })
    }
  }
  const live = new Map<string, boolean>(), unbound = new Set<string>()
  for (const target of targets.values()) {
    if (live.has(target.id)) continue
    const available = hasLiveNativeEntity(sql, target.id, target.kind)
    live.set(target.id, available)
    if (!available && target.kind !== 'artist') unbound.add(target.id)
  }
  if (unbound.size) {
    // Manual bindings can point away from native IDs. Resolve all page misses
    // together: each scope's version links is visited once, not once per job.
    const rows = sql.prepare(`WITH review_versions AS MATERIALIZED (
      SELECT scope,id,entity_id FROM catalog_versions
      WHERE entity_id IN (SELECT value FROM json_each(?))
    )
    SELECT DISTINCT v.entity_id FROM catalog_version_sources b
      CROSS JOIN review_versions v ON v.scope=b.scope AND v.id=b.version_id
      CROSS JOIN catalog_sources s ON s.source_key=b.source_key
      WHERE b.scope='tracks' AND ${liveSource}
    UNION
    SELECT DISTINCT v.entity_id FROM catalog_version_sources b
      CROSS JOIN review_versions v ON v.scope=b.scope AND v.id=b.version_id
      CROSS JOIN catalog_sources s ON s.album_key=b.source_key
      WHERE b.scope='albums' AND ${liveSource}`).all(JSON.stringify([...unbound]))
    for (const row of rows) live.set(String(row.entity_id), true)
  }
  return new Map([...targets].map(([id, target]) => [id, live.get(target.id) ?? false]))
}

export function metadataTasks(sql: DatabaseSync, query: MetadataTasksQuery): MetadataTasksPage {
  if (!validMetadataTasksPayload('metadata.entity.tasks', query))
    throw new Error('Invalid metadata tasks query')
  const counts: MetadataTasksPage['counts'] = {
    queued: 0,
    running: 0,
    retry_wait: 0,
    needs_review: 0,
    blocked: 0,
    failed: 0,
    completed: 0,
    cancelled: 0
  }
  for (const row of sql
    .prepare('SELECT state,count(*) AS n FROM metadata_jobs GROUP BY state')
    .all())
    if (Object.hasOwn(counts, String(row.state)))
      counts[String(row.state) as EntityMetadataState] = Number(row.n)
  const states =
    query.filter === 'active'
      ? METADATA_ACTIVE_STATES
      : query.filter === 'attention'
        ? METADATA_ATTENTION_STATES
        : null
  const conditions = [
    ...(states ? [`j.state IN (${states.map(() => '?').join(',')})`] : []),
    ...(query.batchId
      ? ['EXISTS(SELECT 1 FROM metadata_demands d WHERE d.job_id=j.id AND d.batch_id=?)']
      : [])
  ]
  const args = [...(states ?? []), ...(query.batchId ? [query.batchId] : [])]
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
  const total = Number(
    sql.prepare(`SELECT count(*) AS n FROM metadata_jobs j${where}`).get(...args)!.n
  )
  const rows = sql
    .prepare(
      `SELECT j.payload,e.id AS source_id,e.kind,e.title,e.artist,t.name AS target_name,t.kind AS target_kind,
    (SELECT count(*) FROM metadata_demands d WHERE d.job_id=j.id) AS demands
    FROM metadata_jobs j LEFT JOIN catalog_entities e ON e.id=j.entity_id
    LEFT JOIN metadata_entities t ON t.id=j.entity_id${where} ORDER BY j.rowid DESC LIMIT ? OFFSET ?`
    )
    .all(...args, query.limit ?? 20, query.offset ?? 0) as Row[]
  const jobs = rows.map(row => JSON.parse(String(row.payload)) as EntityMetadataJob)
  const liveEntities = liveReviewEntities(sql, rows.flatMap((row, i) =>
    row.source_id && jobs[i].type !== 'enrich' && jobs[i].type !== 'legacy'
      ? [{ id: String(row.source_id), kind: row.kind as CatalogKind }] : []))
  const items = rows.map((row, i) => {
    const job = jobs[i]
    const sourceId = row.source_id ? String(row.source_id) : null
    const entity: CatalogEntityReference | null =
      sourceId && liveEntities.get(sourceId) && job.type !== 'enrich' && job.type !== 'legacy'
        ? {
            id: sourceId,
            kind: row.kind as CatalogKind,
            title: String(row.title),
            artist: String(row.artist)
          }
        : null
    return {
      id: job.id,
      type: job.type,
      provider: job.provider,
      language: job.language,
      state: job.state,
      generation: job.generation,
      attempts: job.attempts,
      nextAttemptAt: job.nextAttemptAt,
      outcome: job.outcome,
      reason: job.reason,
      updatedAt: job.updatedAt,
      title: job.legacy?.title || String(row.title ?? row.target_name ?? '已移除的音乐条目'),
      kind: (row.kind ?? row.target_kind ?? job.entityKind ?? null) as CatalogKind | null,
      entity,
      demandCount: Number(row.demands)
    }
  })
  return { offset: query.offset ?? 0, total, counts, items }
}

export function metadataTaskDemands(
  sql: DatabaseSync,
  query: MetadataTaskDemandsQuery
): MetadataTaskDemandsPage {
  if (!validMetadataTasksPayload('metadata.entity.demands', query))
    throw new Error('Invalid metadata demands query')
  const row = sql.prepare('SELECT payload FROM metadata_jobs WHERE id=?').get(query.jobId)
  const job = row ? (JSON.parse(String(row.payload)) as EntityMetadataJob) : null
  const canCancel =
    !!job && job.type !== 'legacy' && METADATA_ACTIVE_STATES.some((state) => state === job.state)
  const total = Number(
    sql.prepare('SELECT count(*) AS n FROM metadata_demands WHERE job_id=?').get(query.jobId)!.n
  )
  const items = sql
    .prepare(
      `SELECT d.batch_id,s.origin FROM metadata_demands d
    LEFT JOIN metadata_identification_schedule s ON s.demand_id=d.batch_id
    WHERE d.job_id=? ORDER BY d.batch_id LIMIT ? OFFSET ?`
    )
    .all(query.jobId, query.limit ?? 20, query.offset ?? 0)
    .map((row) => ({
      batchId: String(row.batch_id),
      automatic: row.origin != null,
      origin: (row.origin ?? null) as 'new' | 'history' | null,
      canCancel
    }))
  return { jobId: query.jobId, offset: query.offset ?? 0, total, items }
}
