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
    EXISTS(SELECT 1 FROM catalog_entity_sources b JOIN catalog_sources s ON s.id=b.source_id
      WHERE b.entity_id=e.id AND s.availability<>'missing'
      AND EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)
      AND (s.provider<>'local' OR (EXISTS(SELECT 1 FROM tracks tr WHERE tr.id=s.track_id)
        AND NOT EXISTS(SELECT 1 FROM catalog_pending p WHERE p.track_id=s.track_id)))) AS live,
    (SELECT count(*) FROM metadata_demands d WHERE d.job_id=j.id) AS demands
    FROM metadata_jobs j LEFT JOIN catalog_entities e ON e.id=j.entity_id
    LEFT JOIN metadata_entities t ON t.id=j.entity_id${where} ORDER BY j.rowid DESC LIMIT ? OFFSET ?`
    )
    .all(...args, query.limit ?? 20, query.offset ?? 0) as Row[]
  const items = rows.map((row) => {
    const job = JSON.parse(String(row.payload)) as EntityMetadataJob
    const entity: CatalogEntityReference | null =
      row.source_id && row.live && job.type !== 'enrich' && job.type !== 'legacy'
        ? {
            id: String(row.source_id),
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
