import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { LibraryCollectionPage, LibraryPage } from '../../shared/libraryDatabase.ts'
import type {
  CatalogEntityReference,
  CatalogReferences,
  CatalogTrackReferences
} from '../../shared/musicCatalog.ts'
import { getTrackSource } from '../../shared/trackSourceIdentity.ts'

type Row = Record<string, string | number | null>
type Selection = { sql: string; params: SQLInputValue[] }
const reference = (row: Row): CatalogEntityReference => ({
  id: String(row.id),
  kind: row.kind as CatalogEntityReference['kind'],
  title: String(row.title),
  artist: String(row.artist)
})
// Exclude unpublished/stale local projections, not the rest of an active scan.
const live = `s.availability<>'missing' AND EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)
  AND (s.provider<>'local' OR (EXISTS(SELECT 1 FROM tracks t WHERE t.id=s.track_id)
    AND NOT EXISTS(SELECT 1 FROM catalog_pending p WHERE p.track_id=s.track_id)))`
// Expand only the selected sources. Joining the global UNION view first can
// materialize every library binding even for getTracksByIds([one]).
const sourceReferences = `source_refs AS (
  SELECT position,source_id,recording entity_id FROM selected_sources
  UNION ALL SELECT position,source_id,release FROM selected_sources WHERE release IS NOT NULL
  UNION ALL SELECT s.position,s.source_id,a.artist_id FROM selected_sources s
    JOIN catalog_source_artists a ON a.source_id=s.source_id
  UNION ALL SELECT s.position,s.source_id,p.project_id FROM selected_sources s
    JOIN catalog_release_projects p ON p.release_id=s.release)`

/** Page-only companion data. It never becomes a file tag, playlist snapshot or playback identity. */
export class LibraryDatabaseCatalogReferences {
  private readonly sql: DatabaseSync
  constructor(sql: DatabaseSync) {
    this.sql = sql
  }
  private revision() {
    return Number(
      this.sql.prepare("SELECT value FROM catalog_state WHERE key='revision'").get()!.value
    )
  }
  tracks(page: LibraryPage): LibraryPage {
    if (!page.tracks.length) return page
    const rows = this.sql
      .prepare(
        `WITH selected_sources AS MATERIALIZED (
      SELECT CAST(r.key AS INTEGER) position,s.id source_id,s.recording,s.release
      FROM json_each(?) r CROSS JOIN catalog_bindings s
        ON s.provider=json_extract(r.value,'$.provider') AND s.track_id=json_extract(r.value,'$.id')
      WHERE ${live}
    ), ${sourceReferences}, refs AS (
      SELECT DISTINCT r.position,r.source_id,e.id,e.kind,e.title,e.artist
      FROM source_refs r JOIN catalog_entities e ON e.id=r.entity_id
    ), ranked AS (SELECT *,count(*) OVER(PARTITION BY position) total,
      row_number() OVER(PARTITION BY position ORDER BY kind,id) ordinal FROM refs)
    SELECT * FROM ranked WHERE ordinal<=16 ORDER BY position,ordinal`
      )
      .all(
        JSON.stringify(
          page.tracks.map((t) => ({
            provider:
              typeof t.source === 'string'
                ? getTrackSource({ id: t.id, source: t.source })
                : 'local',
            id: t.id
          }))
        )
      ) as Row[]
    if (!rows.length) return page
    const revision = this.revision()
    const tracks: Array<CatalogTrackReferences | null> = page.tracks.map(() => null)
    for (const row of rows) {
      const index = Number(row.position)
      tracks[index] ??= {
        revision,
        sourceId: String(row.source_id),
        total: Number(row.total),
        items: []
      }
      tracks[index]!.items.push(reference(row))
    }
    return { ...page, catalog: { revision, tracks } }
  }
  collections(
    page: LibraryCollectionPage,
    kind: 'albums' | 'artists',
    selection: Selection,
    aliases: Map<string, string[]>
  ): LibraryCollectionPage {
    if (!page.items.length) return page
    const selected = page.items.flatMap((item, index) =>
      (kind === 'albums' ? (aliases.get(item.id) ?? [item.id]) : [item.id]).map((key) => ({
        position: index,
        key
      }))
    )
    // Batch all displayed groups in one SQL read. In particular, do not scan the
    // full artist library separately for every card on the page.
    const memberLabels =
      kind === 'albums'
        ? `SELECT id,album_key AS label FROM tracks ${selection.sql}`
        : `SELECT tracks.id,credit.value AS label FROM (SELECT * FROM tracks ${selection.sql}) tracks,
          json_each(library_artist_names(json_extract(payload,'$.artist'),json_extract(payload,'$.artists'),json_extract(payload,'$.identityTags'))) credit`
    const rows = this.sql
      .prepare(
        `WITH selected AS (SELECT json_extract(value,'$.position') position,json_extract(value,'$.key') label FROM json_each(?)),
      members AS ${kind === 'artists' ? 'MATERIALIZED' : ''} (${memberLabels}), selected_sources AS MATERIALIZED (
        SELECT r.position,s.id source_id,s.recording,s.release FROM members t JOIN selected r ON r.label=t.label
        JOIN catalog_bindings s ON s.provider='local' AND s.track_id=t.id WHERE ${live}
      ), ${sourceReferences}, refs AS (
        SELECT DISTINCT r.position,e.id,e.kind,e.title,e.artist FROM source_refs r
        JOIN catalog_entities e ON e.id=r.entity_id
        WHERE e.kind ${kind === 'albums' ? "IN ('release','album_project')" : "='artist' AND trim(e.title)=trim((SELECT label FROM selected WHERE position=r.position))"}
      ), ranked AS (SELECT *,count(*) OVER(PARTITION BY position) total,
        row_number() OVER(PARTITION BY position ORDER BY kind,id) ordinal FROM refs)
      SELECT * FROM ranked WHERE ordinal<=8 ORDER BY position,ordinal`
      )
      .all(JSON.stringify(selected), ...selection.params) as Row[]
    if (!rows.length) return page
    const revision = this.revision(),
      references = new Map<number, CatalogReferences>()
    for (const row of rows) {
      const index = Number(row.position)
      if (!references.has(index))
        references.set(index, { revision, total: Number(row.total), items: [] })
      references.get(index)!.items.push(reference(row))
    }
    return {
      ...page,
      items: page.items.map((item, index) =>
        references.has(index) ? { ...item, catalog: references.get(index)! } : item
      )
    }
  }
}
