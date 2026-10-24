import type { DatabaseSync } from 'node:sqlite'
import type {
  LegacyMusicDocument,
  LegacyMusicEditContext,
  LegacyMusicMigration,
  LegacyMusicStage,
  LegacyMusicProvenanceOptions,
  LegacyMusicProvenanceReview
} from '../../shared/legacyMusicMetadata.ts'
import { legacyMusicDocumentValue } from '../../shared/legacyMusicMetadata.ts'
import type { LegacyMusicTaskWork, LegacyMusicLookupResult } from '../../shared/legacyMusicTasks.ts'
import { introductionPatch, creditsPatch } from '../../shared/rhineMetadata.ts'
import type { MusicAlbum } from '../../shared/rhineMusic.ts'
import type { LegacyMusicGenreAuthority } from './libraryDatabaseGenreLegacy.ts'
import { LegacyMusicProvenance } from './legacyMusicProvenance.ts'

export const LEGACY_MUSIC_METADATA_SCHEMA_SQL = `
CREATE TABLE metadata_legacy_documents(plugin_id TEXT PRIMARY KEY,state TEXT NOT NULL,
  source_revision INTEGER NOT NULL,revision INTEGER NOT NULL,expected INTEGER NOT NULL,
  content_revision INTEGER NOT NULL,base TEXT NOT NULL);
CREATE TABLE metadata_legacy_albums(plugin_id TEXT NOT NULL REFERENCES metadata_legacy_documents(plugin_id),
  legacy_id TEXT NOT NULL,payload TEXT NOT NULL,disposition TEXT NOT NULL,
  PRIMARY KEY(plugin_id,legacy_id));
CREATE TABLE metadata_legacy_bindings(plugin_id TEXT NOT NULL,legacy_id TEXT NOT NULL,
  entity_id TEXT NOT NULL REFERENCES catalog_entities(id),evidence TEXT NOT NULL,
  PRIMARY KEY(plugin_id,legacy_id,entity_id),
  FOREIGN KEY(plugin_id,legacy_id) REFERENCES metadata_legacy_albums(plugin_id,legacy_id) ON DELETE CASCADE);
CREATE INDEX metadata_legacy_entity ON metadata_legacy_bindings(entity_id,plugin_id,legacy_id);
CREATE TABLE metadata_legacy_history(plugin_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,bindings TEXT NOT NULL,
  PRIMARY KEY(plugin_id,revision));
`
interface Owner {
  sql: DatabaseSync
  transaction<T>(action: () => T): T
  contentRevision(): number
  albumAliases(id: string): string[]
  genres?: LegacyMusicGenreAuthority
}
const stale = () =>
  Object.assign(new Error('资料或曲库已发生变化，请重新读取并预览后再保存'), {
    code: 'STALE_REVISION'
  })
const encode = (value: unknown) => {
  const payload = JSON.stringify(value)
  if (Buffer.byteLength(payload) > 16 * 1024 * 1024)
    throw new Error('Metadata document exceeds 16 MiB')
  return payload
}
const uint = (value: number) => Number.isSafeInteger(value) && value >= 0
const key = (value: string) =>
  typeof value === 'string' && !!value && value.length <= 256 && !value.includes('\0')

/** Reconcile retained source IDs after edits or a complete portable restore.
 * Call inside the owner's existing publication transaction. */
export function refreshLegacyMusicDispositions(sql: DatabaseSync, entityIds?: string[]) {
  const affected = entityIds ? ` AND EXISTS(SELECT 1 FROM metadata_legacy_bindings affected
    WHERE affected.plugin_id=a.plugin_id AND affected.legacy_id=a.legacy_id
    AND affected.entity_id IN (SELECT value FROM json_each(?)))` : ''
  const args = entityIds ? [JSON.stringify(entityIds)] : []
  sql.prepare(`UPDATE metadata_legacy_albums AS a SET disposition=CASE WHEN EXISTS(
    SELECT 1 FROM metadata_legacy_bindings b WHERE b.plugin_id=a.plugin_id AND b.legacy_id=a.legacy_id
  ) THEN 'bound' ELSE 'unassigned' END
  WHERE a.plugin_id IN (SELECT plugin_id FROM metadata_legacy_documents WHERE state='published')${affected}`).run(...args)
  const fields = ['description', 'localNote', 'producers', 'online.releaseId', 'online.releaseGroupId']
  const incompatible = fields.map(field => `(json_extract(a.payload,'$.${field}') IS NOT NULL
    AND json_extract(other.payload,'$.${field}') IS NOT NULL
    AND json_extract(a.payload,'$.${field}') NOT IN ('','[]')
    AND json_extract(other.payload,'$.${field}') NOT IN ('','[]')
    AND json_extract(a.payload,'$.${field}')<>json_extract(other.payload,'$.${field}'))`).join(' OR ')
  const manualClear = (alias: string) => `(coalesce(json_extract(${alias}.payload,'$.description'),'')='' AND EXISTS(
    SELECT 1 FROM metadata_legacy_provenance p WHERE p.plugin_id=${alias}.plugin_id AND p.legacy_id=${alias}.legacy_id
      AND p.snapshot_revision=-1 AND p.field='description' AND p.disposition='manual'
      AND p.value=json_quote(json_extract(${alias}.payload,'$.description'))))`
  const nonemptyBody = (alias: string) => `(json_type(${alias}.payload,'$.description')='text' AND json_extract(${alias}.payload,'$.description')<>'')`
  const clearConflict = `((${manualClear('a')} AND ${nonemptyBody('other')}) OR (${manualClear('other')} AND ${nonemptyBody('a')}))`
  sql.prepare(`UPDATE metadata_legacy_albums AS a SET disposition='conflict'
    WHERE a.plugin_id IN (SELECT plugin_id FROM metadata_legacy_documents WHERE state='published')${affected} AND EXISTS(
      SELECT 1 FROM metadata_legacy_bindings b
      JOIN metadata_legacy_bindings peer ON peer.entity_id=b.entity_id
      JOIN metadata_legacy_albums other ON other.plugin_id=peer.plugin_id AND other.legacy_id=peer.legacy_id
      JOIN metadata_legacy_documents d ON d.plugin_id=other.plugin_id AND d.state='published'
      WHERE b.plugin_id=a.plugin_id AND b.legacy_id=a.legacy_id AND (${incompatible} OR ${clearConflict}))`).run(...args)
}

/** One authority for imported source-scoped material. A historical matched flag
 * does not create confirmed shared identities or grant cross-source rights. */
export class LibraryDatabaseLegacyMusic {
  private readonly owner: Owner
  private readonly sql: DatabaseSync
  constructor(owner: Owner) {
    this.owner = owner
    this.sql = owner.sql
  }
  private row(pluginId: string) {
    if (!key(pluginId)) throw new Error('Invalid experience ID')
    return this.sql
      .prepare('SELECT * FROM metadata_legacy_documents WHERE plugin_id=?')
      .get(pluginId)
  }
  status(pluginId: string): LegacyMusicMigration | null {
    const row = this.row(pluginId)
    if (!row) return null
    const counts = this.sql
      .prepare(
        `SELECT disposition,count(*) n FROM metadata_legacy_albums WHERE plugin_id=? GROUP BY disposition`
      )
      .all(pluginId)
    const count = (name: string) => Number(counts.find((row) => row.disposition === name)?.n ?? 0)
    return {
      pluginId,
      state: row.state as 'staging' | 'published',
      sourceRevision: Number(row.source_revision),
      revision: Number(row.revision),
      expected: Number(row.expected),
      staged: counts.reduce((sum, row) => sum + Number(row.n), 0),
      counts: {
        bound: count('bound'),
        unassigned: count('unassigned'),
        conflicts: count('conflict')
      }
    }
  }
  begin(
    pluginId: string,
    sourceRevision: number,
    base: Record<string, unknown>,
    expected: number,
    contentRevision: number
  ) {
    this.row(pluginId)
    if (
      !uint(sourceRevision) ||
      !uint(expected) ||
      expected > 100000 ||
      !base ||
      typeof base !== 'object' ||
      Array.isArray(base) ||
      (base.albums !== undefined &&
        (!base.albums ||
          typeof base.albums !== 'object' ||
          Array.isArray(base.albums) ||
          Object.keys(base.albums).length))
    )
      throw new Error('Invalid legacy music migration')
    const payload = encode(base)
    return this.owner.transaction(() => {
      const previous = this.status(pluginId)
      if (previous?.state === 'published') return previous
      if (contentRevision !== this.owner.contentRevision()) throw stale()
      const row = this.row(pluginId)
      if (
        previous &&
        previous.sourceRevision === sourceRevision &&
        row?.content_revision === contentRevision &&
        row.base === payload &&
        previous.expected === expected
      )
        return previous
      // Re-stage after a source edit or library change. No visible authority has
      // been published yet; old JSON remains usable until the final transaction.
      this.sql.prepare('DELETE FROM metadata_legacy_albums WHERE plugin_id=?').run(pluginId)
      this.sql
        .prepare(
          `INSERT INTO metadata_legacy_documents(plugin_id,state,source_revision,revision,expected,content_revision,base) VALUES(?,'staging',?,?,?,?,?)
        ON CONFLICT(plugin_id) DO UPDATE SET state='staging',source_revision=excluded.source_revision,
        revision=excluded.revision,expected=excluded.expected,content_revision=excluded.content_revision,base=excluded.base`
        )
        .run(pluginId, sourceRevision, sourceRevision, expected, contentRevision, payload)
      return this.status(pluginId)!
    })
  }
  stage(request: LegacyMusicStage) {
    if (!Array.isArray(request.entries) || request.entries.length > 100)
      throw new Error('Invalid migration batch')
    return this.owner.transaction(() => {
      const row = this.row(request.pluginId)
      if (
        !row ||
        row.state !== 'staging' ||
        row.source_revision !== request.sourceRevision ||
        row.content_revision !== request.contentRevision ||
        request.contentRevision !== this.owner.contentRevision()
      )
        throw stale()
      for (const entry of request.entries) {
        if (!key(entry.id)) throw new Error('Invalid legacy album ID')
        this.sql
          .prepare(
            'INSERT INTO metadata_legacy_albums VALUES(?,?,?,?) ON CONFLICT(plugin_id,legacy_id) DO UPDATE SET payload=excluded.payload,disposition=excluded.disposition'
          )
          .run(request.pluginId, entry.id, encode(entry.value), 'unassigned')
        this.sql
          .prepare('DELETE FROM metadata_legacy_bindings WHERE plugin_id=? AND legacy_id=?')
          .run(request.pluginId, entry.id)
        if (!entry.collectionId) continue
        this.bind(request.pluginId, entry.id, entry.collectionId)
      }
      const status = this.status(request.pluginId)!
      if (status.staged > status.expected) throw new Error('Legacy album inventory exceeds source')
      const bytes = this.sql
        .prepare(
          `SELECT length(CAST(d.base AS BLOB))+
        coalesce((SELECT sum(length(CAST(a.payload AS BLOB))+length(CAST(json_quote(a.legacy_id) AS BLOB)))
        FROM metadata_legacy_albums a WHERE a.plugin_id=d.plugin_id),0) n
        FROM metadata_legacy_documents d WHERE d.plugin_id=?`
        )
        .get(request.pluginId)!
      if (Number(bytes.n) > 16 * 1024 * 1024) throw new Error('Metadata document exceeds 16 MiB')
      return status
    })
  }
  publish(pluginId: string, sourceRevision: number, contentRevision: number) {
    return this.owner.transaction(() => {
      const status = this.status(pluginId)
      if (status?.state === 'published') return status
      const row = this.row(pluginId)
      if (
        !row ||
        row.source_revision !== sourceRevision ||
        row.content_revision !== contentRevision ||
        contentRevision !== this.owner.contentRevision()
      )
        throw stale()
      if (status!.staged !== status!.expected)
        throw new Error('Legacy album inventory is incomplete')
      // Per-record limits alone do not bound the reconstructed legacy document.
      // Check the original whole-value contract before switching authority.
      legacyMusicDocumentValue(this.assemble(row))
      this.sql
        .prepare("UPDATE metadata_legacy_documents SET state='published',input_revision=revision WHERE plugin_id=?")
        .run(pluginId)
      this.refreshDispositions()
      this.owner.genres?.published(pluginId)
      return this.status(pluginId)!
    })
  }
  read(pluginId: string): LegacyMusicDocument | null {
    const row = this.row(pluginId)
    if (row?.state !== 'published') return null
    const document = this.assemble(row)
    return this.owner.genres?.project(pluginId, document) ?? document
  }
  private assemble(row: Record<string, unknown>): LegacyMusicDocument {
    const albums = this.sql
      .prepare(
        'SELECT legacy_id,payload FROM metadata_legacy_albums WHERE plugin_id=? ORDER BY legacy_id'
      )
      .all(String(row.plugin_id))
    const value = JSON.parse(String(row.base)) as Record<string, unknown>
    if (albums.length || Number(row.expected) > 0)
      value.albums = Object.fromEntries(
        albums.map((album) => [String(album.legacy_id), JSON.parse(String(album.payload))])
      )
    return { revision: Number(row.revision), value }
  }
  edit(
    pluginId: string,
    document: LegacyMusicDocument,
    context?: LegacyMusicEditContext
  ): LegacyMusicDocument {
    legacyMusicDocumentValue(document)
    const { albums } = document.value
    if (albums !== undefined && (!albums || typeof albums !== 'object' || Array.isArray(albums)))
      throw new Error('Invalid legacy albums')
    return this.owner.transaction(() => {
      if (context && context.contentRevision !== this.owner.contentRevision()) throw stale()
      const previous = this.read(pluginId)
      if (context?.descriptionOrigin === 'provider') {
        const provenance = new LegacyMusicProvenance(this.sql)
        const oldAlbums = previous?.value.albums as Record<string, unknown> | undefined
        const incoming = document.value.albums as Record<string, unknown> | undefined
        for (const [id, value] of Object.entries(incoming ?? {})) {
          const old = oldAlbums?.[id]
          if (old && value && typeof old === 'object' && typeof value === 'object' &&
            provenance.disposition(pluginId, id, -1, old) === 'manual') {
            const replacement = { ...value } as Record<string, unknown>
            for (const field of ['description', 'descriptionSource']) {
              if (Object.hasOwn(old, field)) replacement[field] = (old as Record<string, unknown>)[field]
              else delete replacement[field]
            }
            incoming![id] = replacement
          }
        }
      }
      this.replace(pluginId, document, undefined, undefined, context?.descriptionOrigin)
      for (const entry of context?.collections ?? []) {
        if (!key(entry.id) || !key(entry.collectionId)) throw new Error('Invalid legacy album ID')
        // Only brand-new IDs may acquire new source evidence. Existing bindings
        // (including deliberately unassigned history) survive ordinary edits.
        if (
          Object.hasOwn((previous?.value.albums ?? {}) as object, entry.id) ||
          !Object.hasOwn((document.value.albums ?? {}) as object, entry.id)
        )
          continue
        this.bind(pluginId, entry.id, entry.collectionId)
      }
      if (context?.collections.length) this.refreshDispositions()
      this.owner.genres?.edited(pluginId, previous!, document)
      return this.read(pluginId)!
    })
  }
  private bind(pluginId: string, id: string, collectionId: string) {
    const entities = this.sql
      .prepare(
        `SELECT s.release AS entity_id,json_group_array(t.id) AS track_ids FROM tracks t
      JOIN catalog_bindings s ON s.provider='local' AND s.track_id=t.id
      WHERE t.album_key IN (SELECT value FROM json_each(?)) AND s.release IS NOT NULL GROUP BY s.release`
      )
      .all(JSON.stringify(this.owner.albumAliases(collectionId)))
    const insert = this.sql.prepare('INSERT INTO metadata_legacy_bindings VALUES(?,?,?,?)')
    for (const entity of entities)
      insert.run(
        pluginId,
        id,
        entity.entity_id,
        JSON.stringify({ collectionId, trackIds: JSON.parse(String(entity.track_ids)) })
      )
    this.sql
      .prepare('UPDATE metadata_legacy_albums SET disposition=? WHERE plugin_id=? AND legacy_id=?')
      .run(entities.length ? 'bound' : 'unassigned', pluginId, id)
  }
  private replace(
    pluginId: string,
    document: LegacyMusicDocument,
    bindings?: string,
    restoredSnapshot?: number,
    descriptionOrigin?: 'provider'
  ): LegacyMusicDocument {
    const { albums, ...base } = document.value
    const previous = this.read(pluginId)
    if (!previous || previous.revision !== document.revision) throw stale()
    // Manual edits, deletions and restores leave a monotonic per-album input
    // version, including a tombstone for removed IDs. Automatic results do not
    // invalidate a different lookup on the same source album.
    const oldAlbums = (previous.value.albums ?? {}) as Record<string, unknown>
    const newAlbums = (albums ?? {}) as Record<string, unknown>
    const touch = this.sql.prepare(`INSERT INTO metadata_legacy_inputs VALUES(?,?,?)
      ON CONFLICT(plugin_id,legacy_id) DO UPDATE SET revision=excluded.revision`)
    for (const id of new Set([...Object.keys(oldAlbums), ...Object.keys(newAlbums)]))
      if (JSON.stringify(oldAlbums[id]) !== JSON.stringify(newAlbums[id]))
        touch.run(pluginId, id, previous.revision + 1)
    this.checkpoint(pluginId)
    const provenance = new LegacyMusicProvenance(this.sql)
    if (descriptionOrigin === 'provider') provenance.providerEdited(pluginId, oldAlbums, newAlbums)
    else if (restoredSnapshot === undefined) provenance.edited(pluginId, oldAlbums, newAlbums)
    else provenance.restored(pluginId, restoredSnapshot, newAlbums)
    const incoming = Object.entries((albums ?? {}) as Record<string, unknown>)
    // Bindings for existing original IDs survive metadata edits. New unknown
    // IDs remain unassigned rather than being guessed from their titles.
    this.sql
      .prepare(
        'DELETE FROM metadata_legacy_albums WHERE plugin_id=? AND legacy_id NOT IN (SELECT key FROM json_each(?))'
      )
      .run(pluginId, JSON.stringify(albums ?? {}))
    const put = this.sql.prepare(`INSERT INTO metadata_legacy_albums VALUES(?,?,?,'unassigned')
        ON CONFLICT(plugin_id,legacy_id) DO UPDATE SET payload=excluded.payload`)
    for (const [id, album] of incoming) {
      if (!key(id)) throw new Error('Invalid legacy album ID')
      put.run(pluginId, id, encode(album))
    }
    if (bindings !== undefined) {
      this.sql.prepare('DELETE FROM metadata_legacy_bindings WHERE plugin_id=?').run(pluginId)
      // Restore recorded source evidence, not a new name-based lookup. If an
      // original entity was removed, retain the payload as unassigned.
      this.sql
        .prepare(
          `INSERT INTO metadata_legacy_bindings(plugin_id,legacy_id,entity_id,evidence)
          SELECT ?,json_extract(j.value,'$.legacy_id'),json_extract(j.value,'$.entity_id'),json_extract(j.value,'$.evidence')
          FROM json_each(?) j JOIN catalog_entities e ON e.id=json_extract(j.value,'$.entity_id')
          JOIN metadata_legacy_albums a ON a.plugin_id=? AND a.legacy_id=json_extract(j.value,'$.legacy_id')`
        )
        .run(pluginId, bindings, pluginId)
    }
    this.sql
      .prepare(
          'UPDATE metadata_legacy_documents SET revision=revision+1,input_revision=revision+1,expected=?,base=? WHERE plugin_id=?'
      )
      .run(incoming.length, encode(albums === undefined ? base : { ...base, albums: {} }), pluginId)
    this.refreshDispositions()
    return this.read(pluginId)!
  }
  /** Conflicting values stay attached to their original IDs and are never
   * selected by row order. Status is about retained source material, not shared
   * identity confirmation. Staging from another migration is not visible. */
  private refreshDispositions(entityIds?: string[]) {
    refreshLegacyMusicDispositions(this.sql, entityIds)
  }
  /** Called inside the queue's publication transaction, once per explicit batch. */
  checkpoint(pluginId: string) {
    const previous = this.read(pluginId)
    if (!previous) throw stale()
    const bindings = this.sql.prepare('SELECT legacy_id,entity_id,evidence FROM metadata_legacy_bindings WHERE plugin_id=? ORDER BY legacy_id,entity_id').all(pluginId)
    this.sql.prepare('INSERT OR IGNORE INTO metadata_legacy_history VALUES(?,?,?,?)')
      .run(pluginId, previous.revision, encode(previous.value), JSON.stringify(bindings))
    new LegacyMusicProvenance(this.sql).checkpoint(pluginId, previous.revision)
  }
  /** The common metadata queue owns the surrounding transaction and generation
   * fence. Preserve other providers and user imports using the latest row. */
  applyLookup(work: LegacyMusicTaskWork, result: LegacyMusicLookupResult) {
    if (work.operation !== result.operation) throw new Error('Invalid legacy lookup result')
    const row = this.sql.prepare('SELECT payload FROM metadata_legacy_albums WHERE plugin_id=? AND legacy_id=?').get(work.pluginId, work.albumId)
    const retained = row ? JSON.parse(String(row.payload)) as Partial<MusicAlbum> : {}
    const current = { ...work.album, ...retained, id: work.albumId, title: work.album.title, artist: work.album.artist, tracks: work.album.tracks }
    let patch: Partial<MusicAlbum>
    if (result.operation === 'introductions') patch = introductionPatch(current, result.value)
    else if (result.operation === 'credits') patch = creditsPatch(current, result.value)
    else {
      patch = { ...result.value }
        // The upstream MB adapter also returns unchanged input text. A lookup
        // without a new introduction must not undo a concurrent wiki result.
        if (patch.description === work.album.description &&
          JSON.stringify(patch.descriptionSource) === JSON.stringify(work.album.descriptionSource)) {
          delete patch.description
          delete patch.descriptionSource
        }
      if (patch.producers) patch.producers = [
        ...current.producers.filter(person => person.source !== 'MusicBrainz'),
        ...patch.producers.filter(person => person.source === 'MusicBrainz')
      ]
      if (patch.rawGenres) patch.rawGenres = [...new Set([...current.rawGenres, ...patch.rawGenres])]
    }
    const provenance = new LegacyMusicProvenance(this.sql)
    if (current.descriptionSource?.method === 'external-ai' ||
      provenance.disposition(work.pluginId, work.albumId, -1, retained) === 'manual') {
      delete patch.description
      delete patch.descriptionSource
    }
    const payload = encode({ ...retained, ...patch })
    if (Object.hasOwn(patch, 'description')) provenance.lookup(work.pluginId, work.albumId, JSON.parse(payload))
    this.sql.prepare(`INSERT INTO metadata_legacy_albums VALUES(?,?,?,'unassigned')
      ON CONFLICT(plugin_id,legacy_id) DO UPDATE SET payload=excluded.payload`).run(work.pluginId, work.albumId, payload)
    if (!row) this.bind(work.pluginId, work.albumId, work.collectionId)
    const entities = this.sql.prepare('SELECT entity_id FROM metadata_legacy_bindings WHERE plugin_id=? AND legacy_id=?').all(work.pluginId, work.albumId).map(row => String(row.entity_id))
    this.refreshDispositions(entities)
    this.sql.prepare(`UPDATE metadata_legacy_documents SET revision=revision+1,
      expected=(SELECT count(*) FROM metadata_legacy_albums WHERE plugin_id=?) WHERE plugin_id=?`).run(work.pluginId, work.pluginId)
    // Keep the existing whole-document read contract after an automatic patch.
    legacyMusicDocumentValue(this.read(work.pluginId)!)
    this.owner.genres?.updated(work.pluginId, work.albumId)
  }
  history(pluginId: string, offset = 0, limit = 100) {
    this.row(pluginId)
    this.page(offset, limit)
    return {
      total: Number(
        this.sql
          .prepare('SELECT count(*) n FROM metadata_legacy_history WHERE plugin_id=?')
          .get(pluginId)!.n
      ),
      revisions: this.sql
        .prepare(
          'SELECT revision FROM metadata_legacy_history WHERE plugin_id=? ORDER BY revision DESC LIMIT ? OFFSET ?'
        )
        .all(pluginId, limit, offset)
        .map((row) => Number(row.revision))
    }
  }
  historyRead(pluginId: string, revision: number): LegacyMusicDocument | null {
    this.row(pluginId)
    if (!uint(revision)) throw new Error('Invalid history revision')
    const row = this.sql
      .prepare('SELECT payload FROM metadata_legacy_history WHERE plugin_id=? AND revision=?')
      .get(pluginId, revision)
    return row ? { revision, value: JSON.parse(String(row.payload)) } : null
  }
  restore(pluginId: string, revision: number, expectedRevision: number): LegacyMusicDocument {
    if (!uint(revision) || !uint(expectedRevision)) throw new Error('Invalid history revision')
    return this.owner.transaction(() => {
      this.row(pluginId)
      const row = this.sql
        .prepare(
          'SELECT payload,bindings FROM metadata_legacy_history WHERE plugin_id=? AND revision=?'
        )
        .get(pluginId, revision)
      if (!row) throw new Error('历史资料不存在')
      const previous = this.read(pluginId)
      const document = { revision: expectedRevision, value: JSON.parse(String(row.payload)) }
      this.replace(
        pluginId,
        document,
        String(row.bindings),
        revision
      )
      this.owner.genres?.edited(pluginId, previous!, document)
      return this.read(pluginId)!
    })
  }
  private page(offset: number, limit: number) {
    if (!uint(offset) || !uint(limit) || limit < 1 || limit > 200)
      throw new Error('Invalid legacy inventory page')
  }
  inventory(pluginId: string, offset = 0, limit = 100) {
    this.row(pluginId)
    this.page(offset, limit)
    const rows = this.sql
      .prepare(
        'SELECT legacy_id,payload,disposition FROM metadata_legacy_albums WHERE plugin_id=? ORDER BY legacy_id LIMIT ? OFFSET ?'
      )
      .all(pluginId, limit, offset)
    const entities = this.sql.prepare(
      'SELECT entity_id,evidence FROM metadata_legacy_bindings WHERE plugin_id=? AND legacy_id=? ORDER BY entity_id'
    )
    return {
      total: Number(
        this.sql
          .prepare('SELECT count(*) n FROM metadata_legacy_albums WHERE plugin_id=?')
          .get(pluginId)!.n
      ),
      items: rows.map((row) => ({
        id: String(row.legacy_id),
        value: JSON.parse(String(row.payload)) as unknown,
        disposition: row.disposition as 'bound' | 'unassigned' | 'conflict',
        bindings: entities
          .all(pluginId, row.legacy_id)
          .map((e) => ({
            entityId: String(e.entity_id),
            ...(JSON.parse(String(e.evidence)) as { collectionId: string; trackIds: string[] })
          }))
      }))
    }
  }
  provenanceList(pluginId: string, options?: LegacyMusicProvenanceOptions) {
    return new LegacyMusicProvenance(this.sql).list(pluginId, options)
  }
  provenanceRead(pluginId: string, albumId: string, snapshotRevision: number) {
    return new LegacyMusicProvenance(this.sql).read(pluginId, albumId, snapshotRevision)
  }
  provenanceReview(pluginId: string, request: LegacyMusicProvenanceReview) {
    return this.owner.transaction(() => new LegacyMusicProvenance(this.sql).review(pluginId, request))
  }
}
