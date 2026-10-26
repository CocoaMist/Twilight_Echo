import type { DatabaseSync } from 'node:sqlite'
import type {
  CatalogPlaybackSourcesQuery,
  CatalogPlaybackSourcesPage
} from '../../shared/musicUnifiedPlayback.ts'
import type { TrackData } from '../../shared/track.ts'

/** Private playback projection. Source keys and local paths never leave Core's DB channel. */
export function readCatalogPlaybackSources(
  sql: DatabaseSync,
  resolve: (sourceId: string, revision: number) => TrackData | null,
  query: CatalogPlaybackSourcesQuery
): CatalogPlaybackSourcesPage {
  if (
    !Number.isSafeInteger(query.revision) ||
    query.revision < 0 ||
    (query.sourceId === undefined) === (query.sourceKeys === undefined) ||
    (query.sourceId !== undefined &&
      (typeof query.sourceId !== 'string' || !query.sourceId || query.sourceId.length > 128)) ||
    (query.sourceKeys !== undefined &&
      (!Array.isArray(query.sourceKeys) ||
        query.sourceKeys.length > 200 ||
        query.sourceKeys.some((key) => typeof key !== 'string' || !key || key.length > 8192))) ||
    (query.offset !== undefined && (!Number.isSafeInteger(query.offset) || query.offset < 0)) ||
    (query.limit !== undefined &&
      (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200))
  )
    throw new Error('Invalid private playback source query')
  const revision = Number(
    sql.prepare("SELECT value FROM catalog_state WHERE key='revision'").get()!.value
  )
  if (query.revision !== revision)
    throw Object.assign(new Error('音乐库已变化，请重新读取来源'), { code: 'STALE_REVISION' })
  const where =
    query.sourceId !== undefined ? 's.id=?' : 's.source_key IN (SELECT value FROM json_each(?))'
  const value = query.sourceId ?? JSON.stringify(query.sourceKeys)
  const total = Number(
    sql.prepare(`SELECT count(*) n FROM catalog_sources s WHERE ${where}`).get(value)!.n
  )
  const offset = query.offset ?? 0
  const rows = sql
    .prepare(
      `SELECT s.id,s.source_key,s.provider,added.value membership_added_at,
    EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id) member
    FROM catalog_sources s LEFT JOIN catalog_state added ON added.key='membership_added:'||s.id
    WHERE ${where} ORDER BY s.id LIMIT ? OFFSET ?`
    )
    .all(value, query.limit ?? 200, offset)
  return {
    revision,
    total,
    offset,
    items: rows.map((row) => {
      const sourceId = String(row.id),
        track = resolve(sourceId, revision)
      const raw = row.membership_added_at
      const date = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN
      return {
        sourceId,
        sourceKey: String(row.source_key),
        provider: String(row.provider),
        inLibrary: !!row.member,
        // First actual membership publication. Legacy history stays unknown, never inferred from Track.addedAt.
        addedAt: Number.isSafeInteger(date) && date >= 0 ? date : null,
        track
      }
    })
  }
}
