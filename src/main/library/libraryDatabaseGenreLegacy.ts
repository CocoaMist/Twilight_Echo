import type { DatabaseSync } from 'node:sqlite'
import type { LegacyMusicDocument } from '../../shared/legacyMusicMetadata.ts'
import type { GenreEvidencePage, GenreTarget } from '../../shared/musicGenres.ts'
import type { GenreRules } from '../../shared/rhineMusic.ts'
import { legacyExperienceAlbumId } from '../../core/plugins/legacyMusicAuthority.ts'

const RHINE = 'com.twilightecho.experience.rhine-lab'
type Row = Record<string, unknown>
type ImportedNode = {
  originalId: string
  id: string
  name: string
  nameEn: string
  aliases: string[]
}
interface Genres {
  importNodes(
    provider: string,
    nodes: Array<{ id: string; name: string; aliases?: string[] }>
  ): Record<string, string>
  projectImportedNodes(provider: string): ImportedNode[]
  bridgeImportedAliases(importProvider: string, sourceProvider: string): void
  setImportedOverride(target: GenreTarget, ids: string[] | null, key: string): void
  evidence(query: { target: GenreTarget; limit?: number }): GenreEvidencePage
}
interface Owner {
  sql: DatabaseSync
  transaction<T>(action: () => T): T
  contentRevision(): number
  albumCollections(): Array<{ id: string }>
  genres: Genres
}

/** Compatibility snapshots retain original IDs and uncertain raw evidence.
 * Active manual sets live in the common genre repository, not these snapshots. */
export const GENRE_LEGACY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS music_genre_legacy_documents(plugin_id TEXT PRIMARY KEY,
 revision INTEGER NOT NULL,content_revision INTEGER NOT NULL,cursor TEXT NOT NULL,
 complete INTEGER NOT NULL,rules TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS music_genre_legacy_albums(plugin_id TEXT NOT NULL,
 legacy_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(plugin_id,legacy_id));
CREATE TABLE IF NOT EXISTS music_genre_legacy_targets(plugin_id TEXT NOT NULL,
 legacy_id TEXT NOT NULL,collection_id TEXT NOT NULL,PRIMARY KEY(plugin_id,legacy_id,collection_id));
`

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 32768): value is string =>
  typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0')
const encoded = (value: unknown): string => JSON.stringify(value ?? null)
const invalidRules = () => new Error('流派规则无效，请在音乐分类整理中检查原始规则')

/** Only the actual hosted Rhine `value.rules` contract is recognized. A
 * `genreId` displayed from the first track is never an album override. */
export function rhineGenreRules(value: unknown): GenreRules | null {
  if (value === undefined || value === null) return null
  if (
    !record(value) ||
    value.version !== 1 ||
    !Array.isArray(value.genres) ||
    value.genres.length > 1000 ||
    !record(value.albumOverrides)
  )
    throw invalidRules()
  const ids = new Set<string>()
  for (const node of value.genres) {
    if (
      !record(node) ||
      !text(node.id, 512) ||
      !text(node.name, 512) ||
      ids.has(node.id) ||
      (node.aliases !== undefined &&
        (!Array.isArray(node.aliases) ||
          node.aliases.length > 1000 ||
          node.aliases.some((alias) => !text(alias))))
    )
      throw invalidRules()
    ids.add(node.id)
  }
  for (const [id, genreId] of Object.entries(value.albumOverrides))
    if (!text(id, 256) || !text(genreId, 512) || !ids.has(genreId)) throw invalidRules()
  return value as unknown as GenreRules
}

/** Old installations can contain invalid or opaque plugin fields. Preserve
 * them as snapshots; only an explicit new rules edit must pass validation. */
function retainedRules(value: unknown): GenreRules | null {
  try {
    return rhineGenreRules(value)
  } catch {
    return null
  }
}

export interface LegacyMusicGenreAuthority {
  published(pluginId: string): void
  edited(pluginId: string, previous: LegacyMusicDocument, incoming: LegacyMusicDocument): void
  updated(pluginId: string, albumId: string): void
  project(pluginId: string, document: LegacyMusicDocument): LegacyMusicDocument
}

export class LibraryDatabaseGenreLegacy implements LegacyMusicGenreAuthority {
  private readonly owner: Owner
  private cachedRevision = -1
  private collections = new Map<string, string>()
  private collectionIds = new Set<string>()
  constructor(owner: Owner) {
    this.owner = owner
  }
  private get sql() {
    return this.owner.sql
  }
  private transaction<T>(action: () => T): T {
    return this.sql.isTransaction ? action() : this.owner.transaction(action)
  }
  private refreshCollections() {
    const revision = this.owner.contentRevision()
    if (revision === this.cachedRevision) return
    const collections = this.owner.albumCollections()
    this.collectionIds = new Set(collections.map((item) => item.id))
    this.collections = new Map(
      collections.map((item) => [legacyExperienceAlbumId(item.id), item.id])
    )
    this.cachedRevision = revision
  }
  private document(pluginId: string): Row | undefined {
    return this.sql
      .prepare("SELECT * FROM metadata_legacy_documents WHERE plugin_id=? AND state='published'")
      .get(pluginId)
  }
  private provider(pluginId: string) {
    return `legacy:${pluginId}`
  }
  private importKey(pluginId: string, id: string) {
    return `rhine:${pluginId}:${id}`
  }
  private importRules(pluginId: string, rules: GenreRules | null) {
    const provider = this.provider(pluginId)
    this.owner.genres.importNodes(provider, rules?.genres ?? [])
    this.owner.genres.bridgeImportedAliases(provider, 'local')
  }
  private schedule(pluginId: string, document: Row) {
    const base = JSON.parse(String(document.base)) as Record<string, unknown>
    const rules = retainedRules(base.rules)
    const previous = this.sql
      .prepare('SELECT * FROM music_genre_legacy_documents WHERE plugin_id=?')
      .get(pluginId)
    if (!previous || String(previous.rules) !== encoded(base.rules))
      this.importRules(pluginId, rules)
    this.sql
      .prepare(
        `INSERT INTO music_genre_legacy_documents VALUES(?,?,?,'',0,?)
      ON CONFLICT(plugin_id) DO UPDATE SET revision=excluded.revision,
      content_revision=excluded.content_revision,cursor='',complete=0,rules=excluded.rules`
      )
      .run(pluginId, Number(document.revision), this.owner.contentRevision(), encoded(base.rules))
  }
  published(pluginId: string): void {
    if (pluginId !== RHINE) return
    const document = this.document(pluginId)
    if (document) this.schedule(pluginId, document)
  }
  updated(pluginId: string, albumId: string): void {
    if (pluginId !== RHINE) return
    const document = this.document(pluginId)
    if (!document) return
    this.schedule(pluginId, document)
    const base = JSON.parse(String(document.base)) as Record<string, unknown>
    this.processAlbum(pluginId, albumId, retainedRules(base.rules))
  }
  private targets(pluginId: string, id: string): string[] {
    this.refreshCollections()
    const found = new Set<string>()
    const exact = this.collections.get(id)
    if (exact) found.add(exact)
    // Retain original exact membership evidence too; never find an album by title.
    for (const row of this.sql
      .prepare('SELECT evidence FROM metadata_legacy_bindings WHERE plugin_id=? AND legacy_id=?')
      .all(pluginId, id)) {
      const evidence = JSON.parse(String(row.evidence)) as Record<string, unknown>
      if (
        typeof evidence.collectionId === 'string' &&
        this.collectionIds.has(evidence.collectionId)
      )
        found.add(evidence.collectionId)
    }
    return [...found].sort()
  }
  private processAlbum(pluginId: string, id: string, rules: GenreRules | null) {
    const row = this.sql
      .prepare('SELECT payload FROM metadata_legacy_albums WHERE plugin_id=? AND legacy_id=?')
      .get(pluginId, id)
    const album: Record<string, unknown> =
      row && record(JSON.parse(String(row.payload)))
        ? (JSON.parse(String(row.payload)) as Record<string, unknown>)
        : {}
    // rawGenres may combine local tags and historical MB community genres.
    // Preserve exact arrays and derived IDs without granting them active-source rights.
    const payload = encoded({
      ...(Object.hasOwn(album, 'rawGenres') ? { rawGenres: album.rawGenres } : {}),
      ...(Object.hasOwn(album, 'genreId') ? { derivedGenreId: album.genreId } : {}),
      ...(rules && Object.hasOwn(rules.albumOverrides, id)
        ? { manualGenreId: rules.albumOverrides[id] }
        : {})
    })
    const previous = this.sql
      .prepare('SELECT payload FROM music_genre_legacy_albums WHERE plugin_id=? AND legacy_id=?')
      .get(pluginId, id)
    const oldTargets = this.sql
      .prepare(
        'SELECT collection_id FROM music_genre_legacy_targets WHERE plugin_id=? AND legacy_id=? ORDER BY collection_id'
      )
      .all(pluginId, id)
      .map((target) => String(target.collection_id))
    const targets = this.targets(pluginId, id)
    if (previous?.payload === payload && encoded(oldTargets) === encoded(targets)) return
    const imported = new Map(
      this.owner.genres
        .projectImportedNodes(this.provider(pluginId))
        .map((node) => [node.originalId, node.id])
    )
    const manual =
      rules && Object.hasOwn(rules.albumOverrides, id)
        ? imported.get(rules.albumOverrides[id])
        : undefined
    const key = this.importKey(pluginId, id)
    for (const collectionId of oldTargets.filter((target) => !targets.includes(target)))
      this.owner.genres.setImportedOverride({ kind: 'collection', id: collectionId }, null, key)
    for (const collectionId of targets)
      this.owner.genres.setImportedOverride(
        { kind: 'collection', id: collectionId },
        manual ? [manual] : null,
        key
      )
    this.sql
      .prepare(
        `INSERT INTO music_genre_legacy_albums VALUES(?,?,?)
      ON CONFLICT(plugin_id,legacy_id) DO UPDATE SET payload=excluded.payload`
      )
      .run(pluginId, id, payload)
    this.sql
      .prepare('DELETE FROM music_genre_legacy_targets WHERE plugin_id=? AND legacy_id=?')
      .run(pluginId, id)
    const put = this.sql.prepare('INSERT INTO music_genre_legacy_targets VALUES(?,?,?)')
    for (const collectionId of targets) put.run(pluginId, id, collectionId)
  }
  edited(pluginId: string, previous: LegacyMusicDocument, incoming: LegacyMusicDocument): void {
    if (pluginId !== RHINE) return
    const rulesChanged = encoded(previous.value.rules) !== encoded(incoming.value.rules)
    const before = retainedRules(previous.value.rules)
    const next = rulesChanged
      ? rhineGenreRules(incoming.value.rules)
      : retainedRules(incoming.value.rules)
    const changed = new Set<string>()
    if (rulesChanged) {
      for (const id of new Set([
        ...Object.keys(before?.albumOverrides ?? {}),
        ...Object.keys(next?.albumOverrides ?? {})
      ]))
        if (before?.albumOverrides[id] !== next?.albumOverrides[id]) changed.add(id)
      // A legacy scalar edit must not appear to succeed underneath a modern
      // multi-value or explicit-empty manual set.
      for (const id of changed)
        for (const collectionId of this.targets(pluginId, id))
          if (
            this.owner.genres.evidence({
              target: { kind: 'collection', id: collectionId },
              limit: 1
            }).selection.override !== null
          )
            throw new Error(
              '此专辑已有音乐分类整理中的人工流派，请在新整理入口修改或先恢复自动分类'
            )
    }
    const oldAlbums = record(previous.value.albums) ? previous.value.albums : {}
    const newAlbums = record(incoming.value.albums) ? incoming.value.albums : {}
    for (const id of new Set([...Object.keys(oldAlbums), ...Object.keys(newAlbums)])) {
      const a = record(oldAlbums[id]) ? oldAlbums[id] : {},
        b = record(newAlbums[id]) ? newAlbums[id] : {}
      if (encoded([a.rawGenres, a.genreId]) !== encoded([b.rawGenres, b.genreId])) changed.add(id)
    }
    const document = this.document(pluginId)
    if (document) this.schedule(pluginId, document)
    for (const id of changed) this.processAlbum(pluginId, id, next)
  }
  project(pluginId: string, document: LegacyMusicDocument): LegacyMusicDocument {
    if (pluginId !== RHINE) return document
    const rules = retainedRules(document.value.rules)
    if (!rules) return document
    const nodes = new Map(
      this.owner.genres
        .projectImportedNodes(this.provider(pluginId))
        .map((node) => [node.originalId, node])
    )
    if (!nodes.size) return document
    return {
      ...document,
      value: {
        ...document.value,
        rules: {
          ...rules,
          genres: rules.genres.map((node) => {
            const current = nodes.get(node.id)
            if (!current) return node
            const aliases = [
              ...(node.aliases ?? []).filter((value) => current.aliases.includes(value)),
              ...current.aliases.filter(
                (value) => value !== current.name && !(node.aliases ?? []).includes(value)
              )
            ]
            return {
              ...node,
              name: current.name,
              ...(node.aliases !== undefined || aliases.length ? { aliases } : {})
            }
          })
        }
      }
    }
  }
  /** At most `limit` source album identities are projected per call. Existing
   * metadata publication and content changes restart the cursor, not the source. */
  advance(limit = 200): { processed: number; pending: boolean } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new Error('Invalid legacy genre batch size')
    return this.transaction(() => {
      const source = this.document(RHINE)
      if (!source) return { processed: 0, pending: false }
      let state = this.sql
        .prepare('SELECT * FROM music_genre_legacy_documents WHERE plugin_id=?')
        .get(RHINE)
      if (
        !state ||
        state.revision !== source.revision ||
        state.content_revision !== this.owner.contentRevision()
      ) {
        this.schedule(RHINE, source)
        state = this.sql
          .prepare('SELECT * FROM music_genre_legacy_documents WHERE plugin_id=?')
          .get(RHINE)!
      }
      if (state.complete) return { processed: 0, pending: false }
      const rules = retainedRules(JSON.parse(String(state.rules)))
      const ids = this.sql
        .prepare(
          `SELECT legacy_id FROM (
        SELECT legacy_id FROM metadata_legacy_albums WHERE plugin_id=?
        UNION SELECT key FROM json_each(?, '$.albumOverrides')
        UNION SELECT legacy_id FROM music_genre_legacy_albums WHERE plugin_id=?
      ) WHERE legacy_id>? ORDER BY legacy_id LIMIT ?`
        )
        .all(RHINE, encoded(rules), RHINE, String(state.cursor), limit)
        .map((row) => String(row.legacy_id))
      for (const id of ids) this.processAlbum(RHINE, id, rules)
      this.sql
        .prepare('UPDATE music_genre_legacy_documents SET cursor=?,complete=? WHERE plugin_id=?')
        .run(ids.at(-1) ?? String(state.cursor), ids.length < limit ? 1 : 0, RHINE)
      return { processed: ids.length, pending: ids.length === limit }
    })
  }
}
