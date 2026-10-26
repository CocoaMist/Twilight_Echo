import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type {
  GenreAdvanceResult,
  GenreCreate,
  GenreEdit,
  GenreEvidenceInput,
  GenreEvidenceItem,
  GenreEvidencePage,
  GenreEvidenceQuery,
  GenreMap,
  GenreMutationResult,
  GenreOverride,
  GenrePage,
  GenreQuery,
  GenreRawEvidence,
  GenreSelection,
  GenreTarget,
  GenreUnmappedPage,
  GenreUnmappedQuery,
  MusicGenreNode
} from '../../shared/musicGenres.ts'
import {
  MAX_GENRE_ID_LENGTH,
  normalizeGenreAlias,
  validGenresPayload
} from '../../shared/musicGenres.ts'
import {
  DEFAULT_GENRE_SEPARATORS,
  normalizeGenreSeparators,
  splitGenreValues
} from '../../shared/genreSeparators.ts'

const dictionary: Array<[string, string, string, string | null, string[]]> = [
  ['pop', '流行', 'Pop', null, ['流行音乐']],
  ['rock', '摇滚', 'Rock', null, ['摇滚乐']],
  ['jazz', '爵士', 'Jazz', null, ['爵士乐']],
  ['classical', '古典', 'Classical', null, ['古典音乐']],
  ['electronic', '电子', 'Electronic', null, ['电子音乐']],
  ['folk', '民谣', 'Folk', null, []],
  ['blues', '布鲁斯', 'Blues', null, ['蓝调']],
  ['hip-hop', '嘻哈', 'Hip-Hop', null, ['hip hop', 'hiphop']],
  ['rnb', '节奏布鲁斯', 'R&B', null, ['rhythm and blues', 'rnb']],
  ['country', '乡村', 'Country', null, ['乡村音乐']],
  ['metal', '金属', 'Metal', 'rock', ['重金属', 'heavy metal']],
  ['soul', '灵魂', 'Soul', 'rnb', ['灵魂乐']],
  ['punk', '朋克', 'Punk', 'rock', ['punk rock']],
  ['ambient', '氛围', 'Ambient', 'electronic', []],
  ['house', '浩室', 'House', 'electronic', []],
  ['bebop', '比波普', 'Bebop', 'jazz', []]
]
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`
const dictionarySql = dictionary
  .map(
    ([id, name, en, parent, aliases]) => `
INSERT OR IGNORE INTO music_genres VALUES(${quote(`genre:${id}`)},${quote(name)},${quote(en)},${parent ? quote(`genre:${parent}`) : 'NULL'},1,0);
${[name, en, ...aliases].map((value) => `INSERT OR IGNORE INTO music_genre_aliases VALUES('*',${quote(normalizeGenreAlias(value))},${quote(value)},${quote(`genre:${id}`)},0,1,0);`).join('\n')}`
  )
  .join('\n')

/** Same-database state and dirty queue. Indexing is advanced separately in bounded batches. */
export const GENRE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS music_genre_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT OR IGNORE INTO music_genre_state VALUES('revision','1'),('dictionary_version','1'),
 ('source_cursor','0'),('source_horizon',CAST((SELECT coalesce(max(rowid),0) FROM catalog_sources) AS TEXT)),
 ('separators','');
CREATE TABLE IF NOT EXISTS music_genres(id TEXT PRIMARY KEY,name TEXT NOT NULL,name_en TEXT NOT NULL,
 parent_id TEXT REFERENCES music_genres(id),dictionary_version INTEGER NOT NULL,user_modified INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS music_genres_parent ON music_genres(parent_id,id);
CREATE TABLE IF NOT EXISTS music_genre_aliases(provider TEXT NOT NULL,normalized TEXT NOT NULL,value TEXT NOT NULL,
 genre_id TEXT REFERENCES music_genres(id),ignored INTEGER NOT NULL,normalization_version INTEGER NOT NULL,user_modified INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(provider,normalized));
CREATE TABLE IF NOT EXISTS music_genre_evidence(target_kind TEXT NOT NULL,target_id TEXT NOT NULL,
 evidence_key TEXT NOT NULL,provider TEXT NOT NULL,origin TEXT NOT NULL,provenance TEXT NOT NULL,
 raw TEXT NOT NULL,values_json TEXT NOT NULL,PRIMARY KEY(target_kind,target_id,evidence_key));
CREATE INDEX IF NOT EXISTS music_genre_evidence_provider ON music_genre_evidence(provider,target_kind,target_id);
CREATE TABLE IF NOT EXISTS music_genre_overrides(target_kind TEXT NOT NULL,target_id TEXT NOT NULL,
 genre_ids TEXT NOT NULL,PRIMARY KEY(target_kind,target_id));
CREATE TABLE IF NOT EXISTS music_genre_import_overrides(target_kind TEXT NOT NULL,target_id TEXT NOT NULL,
 import_key TEXT NOT NULL,genre_ids TEXT NOT NULL,PRIMARY KEY(target_kind,target_id,import_key));
CREATE TABLE IF NOT EXISTS music_genre_import_nodes(provider TEXT NOT NULL,original_id TEXT NOT NULL,
 genre_id TEXT REFERENCES music_genres(id),PRIMARY KEY(provider,original_id));
CREATE TABLE IF NOT EXISTS music_genre_alias_bridges(import_provider TEXT NOT NULL,provider TEXT NOT NULL,
 normalized TEXT NOT NULL,value TEXT NOT NULL,genre_id TEXT REFERENCES music_genres(id),ignored INTEGER NOT NULL,
 PRIMARY KEY(import_provider,provider,normalized));
CREATE INDEX IF NOT EXISTS music_genre_alias_bridge_lookup ON music_genre_alias_bridges(provider,normalized);
CREATE TABLE IF NOT EXISTS music_genre_pending(source_id TEXT PRIMARY KEY);
CREATE TRIGGER IF NOT EXISTS music_genre_sources_ai AFTER INSERT ON catalog_sources BEGIN
 INSERT OR IGNORE INTO music_genre_pending VALUES(new.id); END;
CREATE TRIGGER IF NOT EXISTS music_genre_sources_au AFTER UPDATE ON catalog_sources BEGIN
 INSERT OR IGNORE INTO music_genre_pending VALUES(new.id); END;
CREATE TRIGGER IF NOT EXISTS music_genre_members_ai AFTER INSERT ON catalog_memberships BEGIN
 INSERT OR IGNORE INTO music_genre_pending VALUES(new.source_id);
 UPDATE music_genre_state SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='revision'; END;
CREATE TRIGGER IF NOT EXISTS music_genre_members_ad AFTER DELETE ON catalog_memberships BEGIN
 INSERT OR IGNORE INTO music_genre_pending VALUES(old.source_id);
 UPDATE music_genre_state SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='revision'; END;
${dictionarySql}
`

type Row = Record<string, unknown>
interface Owner {
  sql: DatabaseSync
  transaction<T>(action: () => T): T
  collectionExists?(id: string): boolean
}
const stale = () =>
  Object.assign(new Error('流派分类已变化，请刷新后重试'), { code: 'STALE_REVISION' })
const invalid = () => new Error('无效的流派分类参数')
const bounds = (q: { offset?: number; limit?: number }) => ({
  offset: q.offset ?? 0,
  limit: q.limit ?? 100
})
const parseIds = (row: Row | undefined): string[] | null =>
  row ? JSON.parse(String(row.genre_ids)) : null

/** Explicit mappings and manual values survive source rescans; raw source facts are never rewritten. */
export class LibraryDatabaseGenres {
  private readonly owner: Owner
  constructor(owner: Owner) {
    this.owner = owner
  }
  private get sql() {
    return this.owner.sql
  }
  private transaction<T>(action: () => T): T {
    return this.sql.isTransaction ? action() : this.owner.transaction(action)
  }
  private state(key: string): string {
    return String(
      (this.sql.prepare('SELECT value FROM music_genre_state WHERE key=?').get(key) as Row).value
    )
  }
  private set(key: string, value: string | number): void {
    this.sql.prepare('UPDATE music_genre_state SET value=? WHERE key=?').run(String(value), key)
  }
  revision(): number {
    return Number(this.state('revision'))
  }
  private bump(): void {
    this.set('revision', this.revision() + 1)
  }
  private fence(revision?: number): void {
    if (revision !== undefined && revision !== this.revision()) throw stale()
  }
  private valid(name: string, value: unknown): void {
    if (!validGenresPayload(name, value)) throw invalid()
  }
  private node(id: string): Row {
    const row = this.sql.prepare('SELECT * FROM music_genres WHERE id=?').get(id) as Row | undefined
    if (!row) throw new Error('流派不存在')
    return row
  }
  private target(target: GenreTarget): void {
    if (target.kind === 'source') {
      if (
        !this.sql
          .prepare(
            'SELECT 1 FROM catalog_sources s WHERE id=? AND EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)'
          )
          .get(target.id)
      )
        throw new Error('来源不属于当前音乐库')
    } else if (!this.owner.collectionExists?.(target.id)) throw new Error('专辑集合不存在')
  }
  private nodeView(row: Row): MusicGenreNode {
    const ancestors = this.sql
      .prepare(
        `WITH RECURSIVE parents(id,parent_id) AS (
      SELECT id,parent_id FROM music_genres WHERE id=? UNION SELECT g.id,g.parent_id FROM music_genres g JOIN parents p ON g.id=p.parent_id)
      SELECT id FROM parents WHERE id<>?`
      )
      .all(String(row.id), String(row.id))
    return {
      id: String(row.id),
      name: String(row.name),
      nameEn: String(row.name_en),
      parentId: row.parent_id === null ? null : String(row.parent_id),
      dictionaryVersion: Number(row.dictionary_version),
      userModified: !!row.user_modified,
      ancestorIds: ancestors.map((p) => String(p.id)),
      childCount: Number(
        (
          this.sql
            .prepare('SELECT count(*) n FROM music_genres WHERE parent_id=?')
            .get(String(row.id)) as Row
        ).n
      )
    }
  }
  tree(query: GenreQuery = {}): GenrePage {
    this.valid('genres.tree', query)
    this.fence(query.revision)
    const { offset, limit } = bounds(query),
      clauses: string[] = [],
      args: SQLInputValue[] = []
    if (query.parentId !== undefined) {
      clauses.push('parent_id IS ?')
      args.push(query.parentId)
    }
    if (query.search) {
      clauses.push('(instr(lower(name),?)>0 OR instr(lower(name_en),?)>0)')
      args.push(query.search.trim().toLowerCase(), query.search.trim().toLowerCase())
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return {
      revision: this.revision(),
      dictionaryVersion: Number(this.state('dictionary_version')),
      offset,
      total: Number(
        (this.sql.prepare(`SELECT count(*) n FROM music_genres ${where}`).get(...args) as Row).n
      ),
      items: (
        this.sql
          .prepare(`SELECT * FROM music_genres ${where} ORDER BY name_en,id LIMIT ? OFFSET ?`)
          .all(...args, limit, offset) as Row[]
      ).map((row) => this.nodeView(row))
    }
  }
  private parent(id: string, parentId: string | null): void {
    if (parentId === null) return
    this.node(parentId)
    const cycle = this.sql
      .prepare(
        `WITH RECURSIVE ancestors(id,parent_id) AS (
      SELECT id,parent_id FROM music_genres WHERE id=? UNION SELECT g.id,g.parent_id FROM music_genres g JOIN ancestors a ON g.id=a.parent_id)
      SELECT 1 FROM ancestors WHERE id=?`
      )
      .get(parentId, id)
    if (cycle) throw new Error('流派父级不能形成循环')
  }
  private create(input: GenreCreate): string {
    const id = `genre:user:${randomUUID()}`
    this.parent(id, input.parentId ?? null)
    this.sql
      .prepare('INSERT INTO music_genres VALUES(?,?,?,?,0,1)')
      .run(id, input.name.trim(), input.nameEn.trim(), input.parentId ?? null)
    return id
  }
  edit(input: GenreEdit): GenreMutationResult {
    this.valid('genres.edit', input)
    return this.transaction(() => {
      this.fence(input.revision)
      let id: string
      if (input.action === 'create') id = this.create(input)
      else {
        id = input.genreId
        const current = this.node(id)
        if (input.action === 'update') {
          const parent =
            input.parentId === undefined ? (current.parent_id as string | null) : input.parentId
          this.parent(id, parent)
          this.sql
            .prepare(
              'UPDATE music_genres SET name=?,name_en=?,parent_id=?,user_modified=1 WHERE id=?'
            )
            .run(
              input.name?.trim() ?? String(current.name),
              input.nameEn?.trim() ?? String(current.name_en),
              parent,
              id
            )
        } else {
          if (input.replacement === id) throw new Error('迁移目标不能是待删除流派')
          this.parent(id, input.replacement)
          this.sql
            .prepare('UPDATE music_genres SET parent_id=?,user_modified=1 WHERE parent_id=?')
            .run(input.replacement, id)
          this.sql
            .prepare(
              'UPDATE music_genre_aliases SET genre_id=?,ignored=0,user_modified=1 WHERE genre_id=?'
            )
            .run(input.replacement, id)
          for (const table of ['music_genre_overrides', 'music_genre_import_overrides']) {
            const rows = this.sql
              .prepare(
                `SELECT rowid,genre_ids FROM ${table} WHERE EXISTS(SELECT 1 FROM json_each(genre_ids) WHERE value=?)`
              )
              .all(id) as Row[]
            for (const row of rows) {
              const ids = [
                ...new Set(
                  (JSON.parse(String(row.genre_ids)) as string[]).flatMap((value) =>
                    value !== id ? [value] : input.replacement ? [input.replacement] : []
                  )
                )
              ]
              this.sql
                .prepare(`UPDATE ${table} SET genre_ids=? WHERE rowid=?`)
                .run(JSON.stringify(ids), Number(row.rowid))
            }
          }
          this.sql
            .prepare('UPDATE music_genre_alias_bridges SET genre_id=?,ignored=0 WHERE genre_id=?')
            .run(input.replacement, id)
          this.sql
            .prepare('UPDATE music_genre_import_nodes SET genre_id=? WHERE genre_id=?')
            .run(input.replacement, id)
          this.sql.prepare('DELETE FROM music_genres WHERE id=?').run(id)
        }
      }
      this.bump()
      return { revision: this.revision(), genreId: id }
    })
  }
  map(input: GenreMap): GenreMutationResult {
    this.valid('genres.map', input)
    return this.transaction(() => {
      this.fence(input.revision)
      const id = input.create ? this.create(input.create) : (input.genreId ?? null)
      if (id) this.node(id)
      const normalized = normalizeGenreAlias(input.value)
      if (!id && !input.ignored)
        this.sql
          .prepare('DELETE FROM music_genre_aliases WHERE provider=? AND normalized=?')
          .run(input.provider, normalized)
      else
        this.sql
          .prepare(
            `INSERT INTO music_genre_aliases VALUES(?,?,?,?,?,1,1) ON CONFLICT(provider,normalized)
        DO UPDATE SET value=excluded.value,genre_id=excluded.genre_id,ignored=excluded.ignored,user_modified=1`
          )
          .run(input.provider, normalized, input.value, id, input.ignored ? 1 : 0)
      this.bump()
      return { revision: this.revision(), ...(id ? { genreId: id } : {}) }
    })
  }
  private mapped(
    provider: string,
    normalized: string
  ): { genreId: string | null; ignored: boolean } {
    let row = this.sql
      .prepare('SELECT genre_id,ignored FROM music_genre_aliases WHERE normalized=? AND provider=?')
      .get(normalized, provider) as Row | undefined
    if (!row) {
      const bridges = this.sql
        .prepare(
          'SELECT DISTINCT genre_id,ignored FROM music_genre_alias_bridges WHERE normalized=? AND provider=? LIMIT 2'
        )
        .all(normalized, provider) as Row[]
      if (bridges.length > 1) return { genreId: null, ignored: false }
      row =
        bridges[0] ??
        (this.sql
          .prepare(
            "SELECT genre_id,ignored FROM music_genre_aliases WHERE normalized=? AND provider='*'"
          )
          .get(normalized) as Row | undefined)
    }
    return { genreId: row?.genre_id ? String(row.genre_id) : null, ignored: !!row?.ignored }
  }
  private evidenceItem(row: Row): GenreEvidenceItem {
    return {
      target: { kind: row.target_kind as GenreTarget['kind'], id: String(row.target_id) },
      key: String(row.evidence_key),
      provider: String(row.provider),
      origin: row.origin as GenreEvidenceInput['origin'],
      provenance: String(row.provenance),
      raw: JSON.parse(String(row.raw)),
      values: (
        JSON.parse(String(row.values_json)) as Array<{ value: string; normalized: string }>
      ).map((value) => ({ ...value, ...this.mapped(String(row.provider), value.normalized) }))
    }
  }
  private selection(target: GenreTarget): GenreSelection {
    const override = parseIds(
      this.sql
        .prepare('SELECT genre_ids FROM music_genre_overrides WHERE target_kind=? AND target_id=?')
        .get(target.kind, target.id) as Row | undefined
    )
    const imported = this.sql
      .prepare(
        'SELECT genre_ids FROM music_genre_import_overrides WHERE target_kind=? AND target_id=? ORDER BY import_key'
      )
      .all(target.kind, target.id) as Row[]
    if (override !== null || imported.length)
      return {
        target,
        revision: this.revision(),
        genreIds: override ?? [...new Set(imported.flatMap((row) => parseIds(row)!))],
        override,
        origin: 'manual'
      }
    const rows = this.sql
      .prepare(
        'SELECT * FROM music_genre_evidence WHERE target_kind=? AND target_id=? ORDER BY evidence_key'
      )
      .all(target.kind, target.id) as Row[]
    const source = rows.filter((row) => row.origin === 'source')
    const ids = (facts: Row[]) =>
      [
        ...new Set(
          facts.flatMap((row) =>
            this.evidenceItem(row).values.flatMap((value) => (value.genreId ? [value.genreId] : []))
          )
        )
      ].sort()
    const sourceIds = ids(source),
      externalIds = sourceIds.length ? [] : ids(rows.filter((row) => row.origin === 'external'))
    return {
      target,
      revision: this.revision(),
      genreIds: sourceIds.length ? sourceIds : externalIds,
      override: null,
      origin: sourceIds.length ? 'source' : externalIds.length ? 'external' : 'none'
    }
  }
  evidence(query: GenreEvidenceQuery): GenreEvidencePage {
    this.valid('genres.evidence', query)
    this.fence(query.revision)
    this.target(query.target)
    const { offset, limit } = bounds(query)
    const args = [query.target.kind, query.target.id]
    return {
      revision: this.revision(),
      offset,
      total: Number(
        (
          this.sql
            .prepare(
              'SELECT count(*) n FROM music_genre_evidence WHERE target_kind=? AND target_id=?'
            )
            .get(...args) as Row
        ).n
      ),
      selection: this.selection(query.target),
      items: (
        this.sql
          .prepare(
            'SELECT * FROM music_genre_evidence WHERE target_kind=? AND target_id=? ORDER BY provider,evidence_key LIMIT ? OFFSET ?'
          )
          .all(...args, limit, offset) as Row[]
      ).map((row) => this.evidenceItem(row))
    }
  }
  override(input: GenreOverride): GenreSelection {
    this.valid('genres.override', input)
    return this.transaction(() => {
      this.fence(input.revision)
      this.target(input.target)
      if (input.genreIds === null)
        this.sql
          .prepare('DELETE FROM music_genre_overrides WHERE target_kind=? AND target_id=?')
          .run(input.target.kind, input.target.id)
      else {
        input.genreIds.forEach((id) => this.node(id))
        this.sql
          .prepare(
            `INSERT INTO music_genre_overrides VALUES(?,?,?) ON CONFLICT(target_kind,target_id)
          DO UPDATE SET genre_ids=excluded.genre_ids`
          )
          .run(
            input.target.kind,
            input.target.id,
            JSON.stringify([...new Set(input.genreIds)].sort())
          )
      }
      this.bump()
      return this.selection(input.target)
    })
  }
  unmapped(query: GenreUnmappedQuery = {}): GenreUnmappedPage {
    this.valid('genres.unmapped', query)
    this.fence(query.revision)
    const { offset, limit } = bounds(query),
      clauses = ['genre_id IS NULL'],
      args: SQLInputValue[] = []
    if (!query.includeIgnored) clauses.push('ignored=0')
    if (query.provider) {
      clauses.push('provider=?')
      args.push(query.provider)
    }
    if (query.search) {
      clauses.push('instr(normalized,?)>0')
      args.push(normalizeGenreAlias(query.search))
    }
    const cte = `WITH bridge_groups AS (
      SELECT provider,normalized,count(DISTINCT json_array(genre_id,ignored)) variants,min(genre_id) genre_id,min(ignored) ignored
      FROM music_genre_alias_bridges GROUP BY provider,normalized),
      values_flat AS (SELECT e.provider,e.target_kind,e.target_id,
      json_extract(v.value,'$.value') value,json_extract(v.value,'$.normalized') normalized
      FROM music_genre_evidence e,json_each(e.values_json) v
      WHERE e.target_kind='collection' OR EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=e.target_id)),
      resolved AS (SELECT v.*,CASE WHEN a.provider IS NOT NULL THEN a.genre_id
        WHEN b.provider IS NOT NULL THEN CASE WHEN b.variants=1 THEN b.genre_id ELSE NULL END ELSE g.genre_id END genre_id,
        CASE WHEN a.provider IS NOT NULL THEN a.ignored
          WHEN b.provider IS NOT NULL THEN CASE WHEN b.variants=1 THEN b.ignored ELSE 0 END ELSE coalesce(g.ignored,0) END ignored
      FROM values_flat v LEFT JOIN music_genre_aliases a ON a.provider=v.provider AND a.normalized=v.normalized
      LEFT JOIN bridge_groups b ON b.provider=v.provider AND b.normalized=v.normalized
      LEFT JOIN music_genre_aliases g ON g.provider='*' AND g.normalized=v.normalized),
      grouped AS (SELECT provider,normalized,min(value) value,ignored,count(DISTINCT json_array(target_kind,target_id)) target_count
      FROM resolved WHERE ${clauses.join(' AND ')} GROUP BY provider,normalized,ignored)`
    return {
      revision: this.revision(),
      offset,
      total: Number(
        (this.sql.prepare(`${cte} SELECT count(*) n FROM grouped`).get(...args) as Row).n
      ),
      items: (
        this.sql
          .prepare(`${cte} SELECT * FROM grouped ORDER BY provider,normalized LIMIT ? OFFSET ?`)
          .all(...args, limit, offset) as Row[]
      ).map((row) => ({
        provider: String(row.provider),
        value: String(row.value),
        normalized: String(row.normalized),
        ignored: !!row.ignored,
        targetCount: Number(row.target_count)
      }))
    }
  }
  /** Internal raw fact ingestion. Calling code owns provenance and external usage authorization. */
  ingest(input: GenreEvidenceInput): void {
    this.target(input.target)
    if (
      !input.key ||
      input.key.length > 16384 ||
      !input.provider ||
      input.provider.length > 128 ||
      !['source', 'external'].includes(input.origin)
    )
      throw invalid()
    const raw = input.raw
    if (!raw || (raw.format !== 'text' && raw.format !== 'array')) throw invalid()
    const values =
      raw.format === 'text'
        ? typeof raw.value === 'string'
          ? raw.separators === undefined
            ? [raw.value]
            : splitGenreValues(raw.value, raw.separators)
          : null
        : Array.isArray(raw.values) && raw.values.every((v) => typeof v === 'string')
          ? raw.values
          : null
    if (!values || values.length > 512 || JSON.stringify(raw).length > 262144) throw invalid()
    const unique = new Map<string, { value: string; normalized: string }>()
    for (const value of values) {
      const normalized = normalizeGenreAlias(value)
      if (normalized && !unique.has(normalized))
        unique.set(normalized, { value: value.trim(), normalized })
    }
    const encoded = JSON.stringify(raw),
      normalized = JSON.stringify([...unique.values()])
    const previous = this.sql
      .prepare(
        'SELECT * FROM music_genre_evidence WHERE target_kind=? AND target_id=? AND evidence_key=?'
      )
      .get(input.target.kind, input.target.id, input.key) as Row | undefined
    if (
      previous &&
      previous.provider === input.provider &&
      previous.origin === input.origin &&
      previous.provenance === input.provenance &&
      previous.raw === encoded &&
      previous.values_json === normalized
    )
      return
    this.transaction(() => {
      this.sql
        .prepare(
          `INSERT INTO music_genre_evidence VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(target_kind,target_id,evidence_key)
        DO UPDATE SET provider=excluded.provider,origin=excluded.origin,provenance=excluded.provenance,raw=excluded.raw,values_json=excluded.values_json`
        )
        .run(
          input.target.kind,
          input.target.id,
          input.key,
          input.provider,
          input.origin,
          input.provenance,
          encoded,
          normalized
        )
      this.bump()
    })
  }
  advance(limit = 200, separators = DEFAULT_GENRE_SEPARATORS): GenreAdvanceResult {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw invalid()
    return this.transaction(() => {
      separators = normalizeGenreSeparators(separators)
      if (this.state('separators') !== separators) {
        this.set('separators', separators)
        this.set('source_cursor', 0)
        this.set(
          'source_horizon',
          Number(
            (this.sql.prepare('SELECT coalesce(max(rowid),0) n FROM catalog_sources').get() as Row)
              .n
          )
        )
      }
      const cursor = Number(this.state('source_cursor')),
        horizon = Number(this.state('source_horizon'))
      const rows = this.sql
        .prepare(
          'SELECT rowid,id,provider,payload FROM catalog_sources WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?'
        )
        .all(cursor, horizon, limit) as Row[]
      const sources = [...rows]
      this.set('source_cursor', rows.length === limit ? Number(rows.at(-1)!.rowid) : horizon)
      const dirty = this.sql
        .prepare(
          `SELECT p.source_id,s.id,s.provider,s.payload FROM music_genre_pending p LEFT JOIN catalog_sources s ON s.id=p.source_id ORDER BY p.source_id LIMIT ?`
        )
        .all(limit - rows.length) as Row[]
      sources.push(...dirty)
      for (const row of sources) {
        const id = String(row.id ?? row.source_id)
        if (
          row.payload &&
          this.sql.prepare('SELECT 1 FROM catalog_memberships WHERE source_id=? LIMIT 1').get(id)
        ) {
          const payload = JSON.parse(String(row.payload)) as Record<string, unknown>
          const raw: GenreRawEvidence = {
            format: 'text',
            value: typeof payload.genre === 'string' ? payload.genre : '',
            ...(row.provider === 'local' ? { separators } : {})
          }
          this.ingest({
            target: { kind: 'source', id },
            key: 'catalog:genre',
            provider: String(row.provider),
            origin: 'source',
            provenance: 'catalog_sources.payload.genre',
            raw
          })
        }
        this.sql.prepare('DELETE FROM music_genre_pending WHERE source_id=?').run(id)
      }
      return {
        revision: this.revision(),
        processed: sources.length,
        pending:
          Number(this.state('source_cursor')) < horizon ||
          !!this.sql.prepare('SELECT 1 FROM music_genre_pending LIMIT 1').get()
      }
    })
  }
  /** A full trusted provider dictionary snapshot. Explicit modern edits survive reimport. */
  importNodes(
    provider: string,
    nodes: Array<{ id: string; name: string; nameEn?: string; aliases?: string[] }>
  ): Record<string, string> {
    return this.transaction(() => {
      const result: Record<string, string> = {}
      if (!provider || provider.length > 128 || nodes.some((node) => !node.id || !node.name))
        throw invalid()
      const originals = new Set(nodes.map((node) => node.id))
      this.sql
        .prepare('DELETE FROM music_genre_aliases WHERE provider=? AND user_modified=0')
        .run(provider)
      for (const row of this.sql
        .prepare('SELECT original_id FROM music_genre_import_nodes WHERE provider=?')
        .all(provider)) {
        if (!originals.has(String(row.original_id)))
          this.sql
            .prepare('DELETE FROM music_genre_import_nodes WHERE provider=? AND original_id=?')
            .run(provider, String(row.original_id))
      }
      for (const node of nodes) {
        const found = this.sql
          .prepare(
            'SELECT genre_id FROM music_genre_import_nodes WHERE provider=? AND original_id=?'
          )
          .get(provider, node.id) as Row | undefined
        // A modern delete/unmap is a tombstone, not permission for the next scan to recreate it.
        if (found && found.genre_id === null) continue
        const ownedId = `genre:import:${encodeURIComponent(provider)}:${encodeURIComponent(node.id)}`
        const id = found ? String(found.genre_id) : ownedId
        if (id.length > MAX_GENRE_ID_LENGTH) throw invalid()
        const existing = this.sql.prepare('SELECT * FROM music_genres WHERE id=?').get(id) as
          | Row
          | undefined
        if (!existing)
          this.sql
            .prepare('INSERT INTO music_genres VALUES(?,?,?,NULL,0,0)')
            .run(id, node.name, node.nameEn || node.name)
        else if (id === ownedId && !existing.user_modified)
          this.sql
            .prepare('UPDATE music_genres SET name=?,name_en=? WHERE id=?')
            .run(node.name, node.nameEn || node.name, id)
        this.sql
          .prepare('INSERT OR IGNORE INTO music_genre_import_nodes VALUES(?,?,?)')
          .run(provider, node.id, id)
        for (const value of [node.name, ...(node.aliases ?? [])])
          this.sql
            .prepare('INSERT OR IGNORE INTO music_genre_aliases VALUES(?,?,?,?,0,1,0)')
            .run(provider, normalizeGenreAlias(value), value, id)
        result[node.id] = id
      }
      this.bump()
      return result
    })
  }
  projectImportedNodes(
    provider: string
  ): Array<{ originalId: string; id: string; name: string; nameEn: string; aliases: string[] }> {
    return (
      this.sql
        .prepare(
          'SELECT n.original_id,g.* FROM music_genre_import_nodes n JOIN music_genres g ON g.id=n.genre_id WHERE provider=? ORDER BY n.original_id'
        )
        .all(provider) as Row[]
    ).map((row) => ({
      originalId: String(row.original_id),
      id: String(row.id),
      name: String(row.name),
      nameEn: String(row.name_en),
      aliases: this.sql
        .prepare(
          'SELECT value FROM music_genre_aliases WHERE provider=? AND genre_id=? ORDER BY normalized'
        )
        .all(provider, String(row.id))
        .map((a) => String(a.value))
    }))
  }
  /** Reversible compatibility bridge: only this import's automatic alias snapshot is replaced. */
  bridgeImportedAliases(importProvider: string, sourceProvider: string): void {
    if (
      !importProvider ||
      !sourceProvider ||
      importProvider.length > 128 ||
      sourceProvider.length > 128
    )
      throw invalid()
    this.transaction(() => {
      this.sql
        .prepare('DELETE FROM music_genre_alias_bridges WHERE import_provider=? AND provider=?')
        .run(importProvider, sourceProvider)
      this.sql
        .prepare(
          `INSERT INTO music_genre_alias_bridges(import_provider,provider,normalized,value,genre_id,ignored)
        SELECT ?,?,normalized,value,genre_id,ignored FROM music_genre_aliases WHERE provider=? AND user_modified=0`
        )
        .run(importProvider, sourceProvider, importProvider)
      this.bump()
    })
  }
  setImportedOverride(target: GenreTarget, genreIds: string[] | null, key: string): void {
    this.transaction(() => {
      if (genreIds === null)
        this.sql
          .prepare(
            'DELETE FROM music_genre_import_overrides WHERE target_kind=? AND target_id=? AND import_key=?'
          )
          .run(target.kind, target.id, key)
      else {
        this.target(target)
        genreIds.forEach((id) => this.node(id))
        this.sql
          .prepare(
            `INSERT INTO music_genre_import_overrides VALUES(?,?,?,?) ON CONFLICT(target_kind,target_id,import_key)
          DO UPDATE SET genre_ids=excluded.genre_ids`
          )
          .run(target.kind, target.id, key, JSON.stringify([...new Set(genreIds)].sort()))
      }
      this.bump()
    })
  }
  removeImportedEvidence(target: GenreTarget, key: string): void {
    this.transaction(() => {
      const result = this.sql
        .prepare(
          'DELETE FROM music_genre_evidence WHERE target_kind=? AND target_id=? AND evidence_key=?'
        )
        .run(target.kind, target.id, key)
      if (result.changes) this.bump()
    })
  }
}
