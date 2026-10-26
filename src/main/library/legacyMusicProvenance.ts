import type { DatabaseSync } from 'node:sqlite'
import type { LegacyMusicProvenanceOptions, LegacyMusicProvenancePage, LegacyMusicProvenanceReview } from '../../shared/legacyMusicMetadata.ts'

export const LEGACY_MUSIC_PROVENANCE_SCHEMA_SQL = `
CREATE TABLE metadata_legacy_provenance(
  plugin_id TEXT NOT NULL,
  legacy_id TEXT NOT NULL,
  snapshot_revision INTEGER NOT NULL CHECK(snapshot_revision>=-1),
  field TEXT NOT NULL CHECK(field='description'),
  value TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('manual','provider','excluded','unverified')),
  origin TEXT NOT NULL CHECK(origin IN ('edit','lookup','review','restore')),
  PRIMARY KEY(plugin_id,legacy_id,snapshot_revision,field)
);
`
type Album = Record<string, unknown>
type Disposition = 'manual' | 'provider' | 'excluded' | 'unverified'
const album = (value: unknown): Album => value && typeof value === 'object' && !Array.isArray(value) ? value as Album : {}
const description = (value: unknown): string => JSON.stringify(album(value).description ?? null)
const stale = () => Object.assign(new Error('资料已发生变化，请重新读取复核清单'), { code: 'STALE_REVISION' })
const key = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 256 && !value.includes('\0')
const uint = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0

/** Provenance is bound to an exact field value and snapshot. Existing payloads
 * are never relabelled merely because they passed through a newer application. */
export class LegacyMusicProvenance {
  private readonly sql: DatabaseSync
  constructor(sql: DatabaseSync) { this.sql = sql }
  disposition(plugin: string, id: string, snapshot: number, value: unknown): Disposition | null {
    const row = this.sql.prepare(`SELECT disposition FROM metadata_legacy_provenance
      WHERE plugin_id=? AND legacy_id=? AND snapshot_revision=? AND field='description' AND value=?`)
      .get(plugin, id, snapshot, description(value))
    return row ? row.disposition as Disposition : null
  }
  private put(plugin: string, id: string, snapshot: number, value: unknown, disposition: Disposition, origin: 'edit' | 'lookup' | 'review' | 'restore') {
    this.sql.prepare(`INSERT INTO metadata_legacy_provenance VALUES(?,?,?,'description',?,?,?)
      ON CONFLICT(plugin_id,legacy_id,snapshot_revision,field) DO UPDATE SET value=excluded.value,disposition=excluded.disposition,origin=excluded.origin`)
      .run(plugin, id, snapshot, description(value), disposition, origin)
  }
  checkpoint(plugin: string, revision: number) {
    this.sql.prepare(`INSERT OR IGNORE INTO metadata_legacy_provenance
      SELECT plugin_id,legacy_id,?,field,value,disposition,origin FROM metadata_legacy_provenance
      WHERE plugin_id=? AND snapshot_revision=-1`).run(revision, plugin)
  }
  edited(plugin: string, before: Record<string, unknown>, after: Record<string, unknown>) {
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!(id in after)) {
        this.sql.prepare('DELETE FROM metadata_legacy_provenance WHERE plugin_id=? AND legacy_id=? AND snapshot_revision=-1').run(plugin, id)
      } else if (description(before[id]) !== description(after[id]) ||
        Object.hasOwn(album(before[id]), 'description') !== Object.hasOwn(album(after[id]), 'description')) {
        const source = album(after[id]).descriptionSource
        if (typeof album(after[id]).description === 'string' && album(after[id]).description &&
          album(source).method === 'external-ai' && JSON.stringify(source) !== JSON.stringify(album(before[id]).descriptionSource)) {
          // The established introduction import carries its own new source
          // receipt. Editing only the body while retaining that receipt is a
          // manual replacement instead.
          this.sql.prepare('DELETE FROM metadata_legacy_provenance WHERE plugin_id=? AND legacy_id=? AND snapshot_revision=-1').run(plugin, id)
        } else this.put(plugin, id, -1, after[id], 'manual', 'edit')
      }
    }
  }
  lookup(plugin: string, id: string, after: unknown) {
    this.put(plugin, id, -1, after, 'provider', 'lookup')
  }
  providerEdited(plugin: string, before: Record<string, unknown>, after: Record<string, unknown>) {
    for (const [id, value] of Object.entries(after)) {
      if (description(before[id]) !== description(value) ||
        JSON.stringify(album(before[id]).descriptionSource) !== JSON.stringify(album(value).descriptionSource)) this.lookup(plugin, id, value)
    }
  }
  restored(plugin: string, snapshot: number, after: Record<string, unknown>) {
    this.sql.prepare('DELETE FROM metadata_legacy_provenance WHERE plugin_id=? AND snapshot_revision=-1').run(plugin)
    for (const [id, value] of Object.entries(after)) {
      const row = this.sql.prepare(`SELECT disposition FROM metadata_legacy_provenance
        WHERE plugin_id=? AND legacy_id=? AND snapshot_revision=? AND field='description' AND value=?`)
        .get(plugin, id, snapshot, description(value))
      if (row) this.put(plugin, id, -1, value, row.disposition as Disposition, 'restore')
      else if (album(value).descriptionSource && album(album(value).descriptionSource).method !== 'external-ai') {
        // Restoring an uncertain old snapshot is not a new handwritten edit.
        // Persist that distinction so the old input-pair heuristic cannot turn
        // a history restore into proof of ownership on the next export.
        this.put(plugin, id, -1, value, 'unverified', 'restore')
      }
    }
  }
  /** Portable payloads contain only fields already approved for migration.
   * The restore owner calls this after selecting the effective current value,
   * or after assigning a history's final local revision. */
  portable(plugin: string, id: string, snapshot: number, value: unknown) {
    if (!Object.hasOwn(album(value), 'description')) return
    if (album(album(value).descriptionSource).method === 'external-ai') {
      this.sql.prepare('DELETE FROM metadata_legacy_provenance WHERE plugin_id=? AND legacy_id=? AND snapshot_revision=?').run(plugin, id, snapshot)
    } else this.put(plugin, id, snapshot, value, 'manual', 'restore')
  }
  private revision(plugin: string): number {
    if (!key(plugin)) throw new Error('Invalid experience ID')
    const row = this.sql.prepare("SELECT revision FROM metadata_legacy_documents WHERE plugin_id=? AND state='published'").get(plugin)
    if (!row) throw new Error('主库资料尚未迁移完成')
    return Number(row.revision)
  }
  list(plugin: string, options: LegacyMusicProvenanceOptions = {}): LegacyMusicProvenancePage {
    const revision = this.revision(plugin), { offset = 0, limit = 20, includeReviewed = false } = options
    if (!uint(offset) || !uint(limit) || limit < 1 || limit > 100 || typeof includeReviewed !== 'boolean' || Object.keys(options).some(k => !['offset', 'limit', 'includeReviewed'].includes(k))) throw new Error('Invalid provenance review page')
    // Each payload is inspected in SQLite; only the requested page crosses the
    // worker boundary. Known provider writes are never review candidates.
    const cte = `WITH snapshots AS (
      SELECT legacy_id,-1 AS snapshot_revision,payload FROM metadata_legacy_albums WHERE plugin_id=?
      UNION ALL SELECT a.key,h.revision,a.value FROM metadata_legacy_history h,json_each(h.payload,'$.albums') a WHERE h.plugin_id=? AND a.type='object'
    ), candidates AS (
      SELECT s.*,p.disposition FROM snapshots s LEFT JOIN metadata_legacy_provenance p
        ON p.plugin_id=? AND p.legacy_id=s.legacy_id AND p.snapshot_revision=s.snapshot_revision
        AND p.field='description' AND p.value=json_quote(json_extract(s.payload,'$.description'))
      WHERE json_type(s.payload,'$.description')='text'
        AND length(json_extract(s.payload,'$.description'))>0
        AND (p.disposition IN ('manual','excluded','unverified') OR (p.disposition IS NULL
          AND json_type(s.payload,'$.descriptionSource') IS NOT NULL
          AND coalesce(json_extract(s.payload,'$.descriptionSource.method'),'')<>'external-ai'))
    )`
    const where = includeReviewed ? '' : " WHERE disposition IS NULL OR disposition='unverified'"
    const args = [plugin, plugin, plugin]
    const total = Number(this.sql.prepare(`${cte} SELECT count(*) n FROM candidates${where}`).get(...args)!.n)
    const items = this.sql.prepare(`${cte} SELECT legacy_id,snapshot_revision,
      json_extract(payload,'$.title') title,substr(json_extract(payload,'$.description'),1,20000) description,
      length(json_extract(payload,'$.description'))>20000 truncated,
      json_extract(payload,'$.descriptionSource.name') source_name,disposition FROM candidates${where}
      ORDER BY snapshot_revision DESC,legacy_id LIMIT ? OFFSET ?`).all(...args, limit, offset)
    return { revision, total, offset, items: items.map(row => ({
      albumId: String(row.legacy_id), snapshotRevision: Number(row.snapshot_revision),
      title: typeof row.title === 'string' ? row.title.slice(0, 300) : String(row.legacy_id),
      description: String(row.description), truncated: Boolean(row.truncated), sourceName: typeof row.source_name === 'string' ? row.source_name.slice(0, 300) : null,
      disposition: row.disposition === 'manual' || row.disposition === 'excluded' ? row.disposition : 'pending'
    })) }
  }
  private readAlbum(plugin: string, id: string, snapshot: number): Album | null {
    const row = snapshot === -1
      ? this.sql.prepare('SELECT payload FROM metadata_legacy_albums WHERE plugin_id=? AND legacy_id=?').get(plugin, id)
      : this.sql.prepare(`SELECT a.value payload FROM metadata_legacy_history h,json_each(h.payload,'$.albums') a
          WHERE h.plugin_id=? AND h.revision=? AND a.key=? AND a.type='object'`).get(plugin, snapshot, id)
    return row ? album(JSON.parse(String(row.payload))) : null
  }
  read(plugin: string, id: string, snapshot: number) {
    const revision = this.revision(plugin)
    if (!key(id) || !Number.isSafeInteger(snapshot) || snapshot < -1) throw new Error('Invalid provenance review target')
    const value = this.readAlbum(plugin, id, snapshot), disposition = this.disposition(plugin, id, snapshot, value)
    if (!value || typeof value.description !== 'string' || !value.description || disposition === 'provider' ||
      (!disposition && (!value.descriptionSource || album(value.descriptionSource).method === 'external-ai'))) throw new Error('旧出处复核项目不存在')
    return { revision, item: {
      albumId: id, snapshotRevision: snapshot, title: typeof value.title === 'string' ? value.title.slice(0, 300) : id,
      description: value.description, truncated: false,
      sourceName: typeof album(value.descriptionSource).name === 'string' ? String(album(value.descriptionSource).name).slice(0, 300) : null,
      disposition: disposition === 'manual' || disposition === 'excluded' ? disposition : 'pending' as const
    } }
  }
  review(plugin: string, request: LegacyMusicProvenanceReview): LegacyMusicProvenancePage {
    if (!request || Object.keys(request).some(k => !['expectedRevision', 'albumId', 'snapshotRevision', 'description', 'disposition'].includes(k)) ||
      !uint(request.expectedRevision) || !key(request.albumId) || !Number.isSafeInteger(request.snapshotRevision) || request.snapshotRevision < -1 ||
      typeof request.description !== 'string' || Buffer.byteLength(request.description) > 16 * 1024 * 1024 ||
      !['manual', 'excluded'].includes(request.disposition)) throw new Error('Invalid provenance review')
    if (request.expectedRevision !== this.revision(plugin)) throw stale()
    const value = this.readAlbum(plugin, request.albumId, request.snapshotRevision)
    if (!value || value.description !== request.description || !request.description ||
      this.disposition(plugin, request.albumId, request.snapshotRevision, value) === 'provider') throw stale()
    // Unmarked, already-portable imports need no rights confirmation.
    if (!this.disposition(plugin, request.albumId, request.snapshotRevision, value) &&
      (!value.descriptionSource || album(value.descriptionSource).method === 'external-ai')) throw new Error('该正文无需旧出处复核')
    this.put(plugin, request.albumId, request.snapshotRevision, value, request.disposition, 'review')
    // Review is user state: bump the existing durable metadata/backup fence.
    this.sql.prepare('UPDATE metadata_legacy_documents SET revision=revision+1 WHERE plugin_id=?').run(plugin)
    return this.list(plugin)
  }
}
