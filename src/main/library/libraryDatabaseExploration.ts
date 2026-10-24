import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { MusicCredit } from '../../shared/musicCredits.ts'
import type {
  MusicExplorationState,
  MusicExplorationToken,
  MusicExplorationReadContext,
  MusicExplorationQuery,
  MusicExplorationPage,
  MusicExplorationDetailQuery,
  MusicExplorationLookupQuery,
  MusicExplorationDetail,
  MusicExplorationRelationsQuery,
  MusicExplorationParticipationQuery,
  MusicExplorationRelationsPage,
  MusicExplorationPerformanceSave,
  MusicExplorationPerformanceDelete,
  MusicExplorationIngest,
  MusicExplorationCreditSync,
  MusicExplorationReference,
  MusicExplorationEntity,
  MusicExplorationItem,
  MusicExplorationRelation,
  MusicExplorationRelationInput
} from '../../shared/musicExploration.ts'
import {
  validMusicExplorationPayload,
  validMusicExplorationReference
} from '../../shared/musicExploration.ts'

const mutation = `UPDATE music_exploration_state SET revision=revision+1 WHERE id=1;
  UPDATE catalog_state SET value=CAST(value AS INTEGER)+1 WHERE key='revision';`
const tables = ['music_exploration_refs', 'music_exploration_sets', 'music_exploration_relations']
export const EXPLORATION_SCHEMA_SQL = `
CREATE TABLE music_exploration_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,credit_cursor INTEGER NOT NULL DEFAULT 0);
INSERT INTO music_exploration_state(id,revision) VALUES(1,0);
CREATE TABLE music_exploration_refs(provider TEXT NOT NULL,kind TEXT NOT NULL,id_type TEXT NOT NULL,
  value TEXT NOT NULL,entity_id TEXT NOT NULL REFERENCES catalog_entities(id),
  PRIMARY KEY(provider,kind,id_type,value));
CREATE INDEX music_exploration_refs_entity ON music_exploration_refs(entity_id);
CREATE TABLE music_exploration_sets(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES catalog_entities(id),
  provider TEXT NOT NULL,set_key TEXT NOT NULL,revision INTEGER NOT NULL,truncated INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('provider','manual')),UNIQUE(owner_id,provider,set_key));
CREATE INDEX music_exploration_sets_owner ON music_exploration_sets(owner_id,id);
CREATE TABLE music_exploration_relations(id TEXT PRIMARY KEY,set_id TEXT NOT NULL REFERENCES music_exploration_sets(id) ON DELETE CASCADE,
  from_id TEXT NOT NULL REFERENCES catalog_entities(id),to_id TEXT NOT NULL REFERENCES catalog_entities(id),
  kind TEXT NOT NULL,position INTEGER NOT NULL,payload TEXT NOT NULL);
CREATE INDEX music_exploration_relations_from ON music_exploration_relations(from_id,kind,to_id);
CREATE INDEX music_exploration_relations_to ON music_exploration_relations(to_id,kind,from_id);
${tables
  .flatMap((t) =>
    ['INSERT', 'UPDATE', 'DELETE'].map(
      (op) => `CREATE TRIGGER ${t}_${op.toLowerCase()} AFTER ${op} ON ${t} BEGIN ${mutation}
  ${t === 'music_exploration_refs' ? "UPDATE personal_preferences_state SET revision=revision+1 WHERE profile_id='default';" : ''} END;`
    )
  )
  .join('\n')}
`
export const EXPLORATION_SCHEMA_OBJECTS = [
  'music_exploration_state',
  ...tables,
  'music_exploration_refs_entity',
  'music_exploration_sets_owner',
  'music_exploration_relations_from',
  'music_exploration_relations_to',
  ...tables.flatMap((t) => ['insert', 'update', 'delete'].map((op) => `${t}_${op}`))
]
export interface MusicExplorationOwner {
  sql: DatabaseSync
  transaction<T>(action: () => T): T
  contentRevision(): number
  metadataRevision(): number
  now?(): number
}
type Row = Record<string, unknown>
const invalid = () => Object.assign(new Error('人物作品参数无效'), { code: 'INVALID_PAYLOAD' })
const stale = () =>
  Object.assign(new Error('人物作品或音乐库已变化，请刷新后重试'), { code: 'STALE_REVISION' })
const decode = <T>(v: unknown): T => JSON.parse(String(v)) as T
const referenceKey = (r: MusicExplorationReference): string =>
  JSON.stringify([r.provider, r.kind, r.idType, r.value])
const contextKey = (context: MusicExplorationReadContext): string =>
  JSON.stringify(
    Object.entries(context.platformContexts ?? {})
      .filter(([, v]) => typeof v === 'string' && !!v)
      .sort(([a], [b]) => a.localeCompare(b))
  )
const entity = (row: Row, prefix = ''): MusicExplorationEntity => ({
  id: String(row[`${prefix}id`]),
  kind: row[`${prefix}kind`] as MusicExplorationEntity['kind'],
  title: String(row[`${prefix}title`]),
  artist: String(row[`${prefix}artist`])
})
const item = (row: Row): MusicExplorationItem => ({
  ...entity(row),
  sourceCount: Number(row.source_count),
  inLibrary: Number(row.source_count) > 0
})

/** Relations only contribute in the authorized metadata context. Names never join identities. */
function usableRelation(now: string, contexts: string): string {
  return `(json_type(r.payload,'$.usage') IS NULL OR (json_extract(r.payload,'$.usage.display')=1 AND json_extract(r.payload,'$.usage.cache')=1))
    AND (json_extract(r.payload,'$.usage.expiresAt') IS NULL OR json_extract(r.payload,'$.usage.expiresAt')>${now})
    AND (json_extract(r.payload,'$.sourceProvider') IS NULL OR
      (EXISTS(SELECT 1 FROM json_each(${contexts}) c WHERE c.key=json_extract(r.payload,'$.sourceProvider')
        AND c.value=json_extract(r.payload,'$.providerContext')) AND json_extract(r.payload,'$.usage.crossSource')=1))`
}
function membershipCtes(now: string, contexts: string): string {
  return `exploration_usable_relations AS (SELECT r.* FROM music_exploration_relations r WHERE ${usableRelation(now, contexts)}),
  exploration_equivalents(anchor_id,entity_id) AS (
    SELECT DISTINCT entity_id,entity_id FROM music_exploration_refs
    UNION SELECT r.entity_id,l.entity_id FROM music_exploration_refs r
      JOIN metadata_identity_refs ir ON ir.provider=r.provider AND ir.kind=r.kind AND ir.id_type=r.id_type AND ir.value=r.value
      JOIN metadata_identity_links l ON l.target_id=ir.target_id AND l.kind=r.kind AND l.state='confirmed'),
  exploration_actual_sources AS (
    SELECT s.* FROM catalog_sources s LEFT JOIN tracks t ON s.provider='local' AND t.id=s.track_id
    WHERE EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)
      AND (s.provider<>'local' OR (t.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM catalog_pending p WHERE p.track_id=s.track_id)))),
  exploration_direct_memberships(entity_id,source_id) AS (
    SELECT recording_id,id FROM exploration_actual_sources
    UNION SELECT release_id,id FROM exploration_actual_sources WHERE release_id IS NOT NULL
    UNION SELECT a.artist_id,a.source_id FROM catalog_source_artists a JOIN exploration_actual_sources s ON s.id=a.source_id
    UNION SELECT p.project_id,s.id FROM exploration_actual_sources s JOIN catalog_release_projects p ON p.release_id=s.release_id),
  exploration_seeds(entity_id,source_id) AS (
    SELECT entity_id,source_id FROM exploration_direct_memberships
    UNION SELECT e.anchor_id,m.source_id FROM exploration_equivalents e JOIN exploration_direct_memberships m ON m.entity_id=e.entity_id),
  exploration_memberships(entity_id,source_id) AS (
    SELECT entity_id,source_id FROM exploration_seeds
    UNION SELECT r.from_id,m.source_id FROM exploration_memberships m JOIN exploration_usable_relations r ON r.to_id=m.entity_id
      WHERE r.kind<>'credit' OR json_extract(r.payload,'$.credit.direction') IS NOT 'forward')
  `
}
/** Standalone CTEs for personal-domain counts. Default local context excludes account-bound relations. */
export function explorationMembershipCtes(): string {
  return membershipCtes("CAST(strftime('%s','now') AS INTEGER)*1000", "'{}'")
}

/** Exact-reference graph over durable catalog anchors. Reads never ingest or fetch metadata. */
export class LibraryDatabaseExploration {
  private readClock = 0
  private readonly owner: MusicExplorationOwner
  constructor(owner: MusicExplorationOwner) {
    this.owner = owner
  }
  private get sql(): DatabaseSync {
    return this.owner.sql
  }
  state(): MusicExplorationState {
    return {
      revision: Number(
        this.sql.prepare('SELECT revision FROM music_exploration_state WHERE id=1').get()!.revision
      ),
      catalogRevision: Number(
        this.sql.prepare("SELECT value FROM catalog_state WHERE key='revision'").get()!.value
      ),
      contentRevision: this.owner.contentRevision(),
      metadataRevision: this.owner.metadataRevision()
    }
  }
  private read<T extends { token: MusicExplorationToken }>(action: () => T): T {
    const previous = this.readClock,
      own = !this.sql.isTransaction
    this.readClock = this.owner.now?.() ?? Date.now()
    try {
      if (own) this.sql.exec('BEGIN')
      const result = action()
      if (
        result.token.expiresAt !== null &&
        (this.owner.now?.() ?? Date.now()) >= result.token.expiresAt
      )
        throw stale()
      if (own) this.sql.exec('COMMIT')
      return result
    } catch (error) {
      if (own && this.sql.isTransaction) this.sql.exec('ROLLBACK')
      throw error
    } finally {
      this.readClock = previous
    }
  }
  private token(
    expected: MusicExplorationToken | undefined,
    context: MusicExplorationReadContext
  ): MusicExplorationToken {
    const row = this.sql
      .prepare(
        `SELECT min(json_extract(payload,'$.usage.expiresAt')) expiry FROM music_exploration_relations
      WHERE json_extract(payload,'$.usage.expiresAt')>?`
      )
      .get(this.readClock)
    const token: MusicExplorationToken = {
      ...this.state(),
      contextKey: contextKey(context),
      asOf: expected?.asOf ?? this.readClock,
      expiresAt: row?.expiry === null ? null : Number(row?.expiry)
    }
    if (
      expected &&
      (expected.asOf > this.readClock ||
        (expected.expiresAt !== null && expected.expiresAt <= this.readClock) ||
        Object.keys(token).some(
          (k) =>
            token[k as keyof MusicExplorationToken] !== expected[k as keyof MusicExplorationToken]
        ))
    )
      throw stale()
    return token
  }
  private plan(context: MusicExplorationReadContext): { sql: string; params: SQLInputValue[] } {
    return {
      sql: `exploration_clock(now,contexts) AS (VALUES (?,?)),${membershipCtes('(SELECT now FROM exploration_clock)', '(SELECT contexts FROM exploration_clock)')},
      exploration_counts AS (SELECT entity_id,count(DISTINCT source_id) source_count FROM exploration_memberships GROUP BY entity_id)`,
      params: [this.readClock, JSON.stringify(context.platformContexts ?? {})]
    }
  }
  query(
    query: MusicExplorationQuery,
    context: MusicExplorationReadContext = {}
  ): MusicExplorationPage {
    if (!validMusicExplorationPayload('exploration.query', query)) throw invalid()
    return this.read(() => {
      const token = this.token(query.token, context),
        plan = this.plan(context),
        scope = query.scope ?? 'library',
        search = query.search?.trim().toLowerCase() ?? ''
      const params = [
        ...plan.params,
        JSON.stringify(query.kinds ?? ['artist', 'work', 'performance']),
        search,
        search
      ]
      const selected = `${plan.sql},selected AS (SELECT e.*,coalesce(c.source_count,0) source_count FROM catalog_entities e
        LEFT JOIN exploration_counts c ON c.entity_id=e.id WHERE e.kind IN (SELECT value FROM json_each(?))
        AND (?='' OR instr(lower(e.title),?)>0)
        AND (EXISTS(SELECT 1 FROM music_exploration_refs r WHERE r.entity_id=e.id)
          OR (e.kind IN ('recording','release','album_project') AND c.source_count>0))
        ${scope === 'library' ? 'AND c.source_count>0' : ''})`
      return {
        token,
        offset: query.offset ?? 0,
        total: Number(
          this.sql
            .prepare(`WITH RECURSIVE ${selected} SELECT count(*) n FROM selected`)
            .get(...params)!.n
        ),
        items: (
          this.sql
            .prepare(
              `WITH RECURSIVE ${selected} SELECT * FROM selected ORDER BY title COLLATE NOCASE,id LIMIT ? OFFSET ?`
            )
            .all(...params, query.limit ?? 50, query.offset ?? 0) as Row[]
        ).map(item)
      }
    })
  }
  detail(
    query: MusicExplorationDetailQuery,
    context: MusicExplorationReadContext = {}
  ): MusicExplorationDetail {
    if (!validMusicExplorationPayload('exploration.detail', query)) throw invalid()
    return this.read(() => this.detailAt(query, context))
  }
  lookupReference(
    query: MusicExplorationLookupQuery,
    context: MusicExplorationReadContext = {}
  ): MusicExplorationDetail {
    if (!validMusicExplorationPayload('exploration.lookup', query)) throw invalid()
    return this.read(() => {
      const r = query.reference
      const direct = this.lookup(r)
      const rows = direct
        ? []
        : this.sql
            .prepare(
              `SELECT er.entity_id FROM metadata_identity_refs ir
        JOIN metadata_identity_refs aliases ON aliases.target_id=ir.target_id AND aliases.kind=ir.kind
        JOIN music_exploration_refs er ON er.provider=aliases.provider AND er.kind=aliases.kind AND er.id_type=aliases.id_type AND er.value=aliases.value
        WHERE ir.provider=? AND ir.kind=? AND ir.id_type=? AND ir.value=? GROUP BY er.entity_id ORDER BY er.entity_id LIMIT 2`
            )
            .all(r.provider, r.kind, r.idType, r.value)
      if (rows.length > 1)
        throw Object.assign(new Error('外部引用对应多个人物或作品，请先复核关联'), {
          code: 'IDENTITY_CONFLICT'
        })
      return this.detailAt(
        { entityId: direct ?? (rows.length ? String(rows[0].entity_id) : ''), token: query.token },
        context
      )
    })
  }
  private detailAt(
    query: MusicExplorationDetailQuery,
    context: MusicExplorationReadContext
  ): MusicExplorationDetail {
    const token = this.token(query.token, context),
      plan = this.plan(context)
    const row = this.sql
      .prepare(
        `WITH RECURSIVE ${plan.sql} SELECT e.*,coalesce(c.source_count,0) source_count FROM catalog_entities e
      LEFT JOIN exploration_counts c ON c.entity_id=e.id WHERE e.id=?`
      )
      .get(...plan.params, query.entityId) as Row | undefined
    const references = this.sql
      .prepare(
        'SELECT provider,kind,id_type,value FROM music_exploration_refs WHERE entity_id=? ORDER BY provider,kind,id_type,value LIMIT 101'
      )
      .all(query.entityId) as Row[]
    return {
      token,
      entity: row ? item(row) : null,
      references: references.slice(0, 100).map((r) => ({
        provider: String(r.provider),
        kind: r.kind as MusicExplorationReference['kind'],
        idType: String(r.id_type),
        value: String(r.value)
      })),
      referencesTruncated: references.length > 100,
      providerTruncated: this.providerTruncated(query.entityId, plan)
    }
  }
  private providerTruncated(id: string, plan: { sql: string; params: SQLInputValue[] }): boolean {
    return !!this.sql
      .prepare(
        `WITH RECURSIVE ${plan.sql} SELECT 1 FROM music_exploration_sets s WHERE s.truncated=1 AND
      (s.owner_id=? OR s.owner_id IN(SELECT anchor_id FROM exploration_equivalents WHERE entity_id=?) OR
      EXISTS(SELECT 1 FROM exploration_usable_relations r WHERE r.set_id=s.id AND (r.from_id=? OR r.to_id=?))) LIMIT 1`
      )
      .get(...plan.params, id, id, id, id)
  }
  relations(
    query: MusicExplorationRelationsQuery,
    context: MusicExplorationReadContext = {}
  ): MusicExplorationRelationsPage {
    if (!validMusicExplorationPayload('exploration.relations', query)) throw invalid()
    return this.read(() => this.relationsAt(query, context))
  }
  participation(
    query: MusicExplorationParticipationQuery,
    context: MusicExplorationReadContext = {}
  ): MusicExplorationRelationsPage {
    if (!validMusicExplorationPayload('exploration.participation', query)) throw invalid()
    return this.read(() => {
      const kind = this.sql
        .prepare('SELECT kind FROM catalog_entities WHERE id=?')
        .get(query.entityId)?.kind
      if (kind !== undefined && kind !== 'artist') throw invalid()
      return this.relationsAt(
        { ...query, direction: 'outgoing', relations: ['credit'] },
        context,
        true
      )
    })
  }
  private relationsAt(
    query: MusicExplorationRelationsQuery,
    context: MusicExplorationReadContext,
    participation = false
  ): MusicExplorationRelationsPage {
    const token = this.token(query.token, context),
      plan = this.plan(context),
      direction = query.direction ?? 'both'
    const endpoint =
      direction === 'outgoing'
        ? 'r.from_id IN (SELECT id FROM subject_ids)'
        : direction === 'incoming'
          ? 'r.to_id IN (SELECT id FROM subject_ids)'
          : '(r.from_id IN (SELECT id FROM subject_ids) OR r.to_id IN (SELECT id FROM subject_ids))'
    const other =
      direction === 'outgoing'
        ? 'r.to_id'
        : direction === 'incoming'
          ? 'r.from_id'
          : 'CASE WHEN r.from_id IN (SELECT id FROM subject_ids) THEN r.to_id ELSE r.from_id END'
    const params = [
      ...plan.params,
      query.entityId,
      query.entityId,
      JSON.stringify(
        query.relations ?? [
          'credit',
          'work_recording',
          'work_performance',
          'performance_recording',
          'part'
        ]
      ),
      JSON.stringify(query.roles ?? []),
      JSON.stringify(query.roles ?? []),
      JSON.stringify(
        query.kinds ?? ['artist', 'work', 'performance', 'recording', 'release', 'album_project']
      )
    ]
    const selected = `${plan.sql},subject_ids(id) AS (SELECT ? UNION SELECT anchor_id FROM exploration_equivalents WHERE entity_id=?),
      edges AS (SELECT r.*,${other} other_id FROM exploration_usable_relations r WHERE ${endpoint}
        AND r.kind IN(SELECT value FROM json_each(?))
        ${participation ? "AND json_extract(r.payload,'$.credit.direction') IS NOT 'forward'" : ''}
        AND (json_array_length(?)=0 OR json_extract(r.payload,'$.credit.role') IN(SELECT value FROM json_each(?)))),
      displayed AS (SELECT edge.*,coalesce(actual.entity_id,edge.other_id) display_id FROM edges edge
        JOIN catalog_entities original ON original.id=edge.other_id
        LEFT JOIN exploration_equivalents actual ON actual.anchor_id=edge.other_id AND actual.entity_id<>edge.other_id
          AND original.kind IN('recording','release','album_project')),
      selected AS (SELECT d.*,e.kind entity_kind,e.title entity_title,e.artist entity_artist,coalesce(c.source_count,0) source_count
        FROM displayed d JOIN catalog_entities e ON e.id=d.display_id LEFT JOIN exploration_counts c ON c.entity_id=e.id
        WHERE e.kind IN(SELECT value FROM json_each(?)) ${query.scope === 'catalog' ? '' : 'AND c.source_count>0'})`
    const rows = this.sql
      .prepare(
        `WITH RECURSIVE ${selected} SELECT s.*,f.kind from_kind,f.title from_title,f.artist from_artist,
      t.kind to_kind,t.title to_title,t.artist to_artist,sets.origin FROM selected s
      JOIN catalog_entities f ON f.id=s.from_id JOIN catalog_entities t ON t.id=s.to_id JOIN music_exploration_sets sets ON sets.id=s.set_id
      ORDER BY position,entity_title COLLATE NOCASE,display_id,id LIMIT ? OFFSET ?`
      )
      .all(...params, query.limit ?? 50, query.offset ?? 0) as Row[]
    return {
      token,
      offset: query.offset ?? 0,
      total: Number(
        this.sql
          .prepare(`WITH RECURSIVE ${selected} SELECT count(*) n FROM selected`)
          .get(...params)!.n
      ),
      providerTruncated: this.providerTruncated(query.entityId, plan),
      items: rows.map((r) => {
        const payload = decode<MusicExplorationRelationInput>(r.payload),
          relation: MusicExplorationRelation = {
            id: String(r.id),
            kind: r.kind as MusicExplorationRelation['kind'],
            from: {
              id: String(r.from_id),
              kind: r.from_kind as MusicExplorationEntity['kind'],
              title: String(r.from_title),
              artist: String(r.from_artist)
            },
            to: {
              id: String(r.to_id),
              kind: r.to_kind as MusicExplorationEntity['kind'],
              title: String(r.to_title),
              artist: String(r.to_artist)
            },
            order: Number(r.position),
            origin: r.origin as 'provider' | 'manual',
            attribution: payload.attribution,
            ...(payload.credit ? { credit: payload.credit } : {})
          }
        return {
          entity: item({
            id: r.display_id,
            kind: r.entity_kind,
            title: r.entity_title,
            artist: r.entity_artist,
            source_count: r.source_count
          }),
          relation
        }
      })
    }
  }
  private validateIngest(request: MusicExplorationIngest): void {
    if (
      !request ||
      !validMusicExplorationReference(request.owner) ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(request.provider) ||
      typeof request.setKey !== 'string' ||
      !request.setKey ||
      request.setKey.length > 256 ||
      request.setKey.includes('\0') ||
      !Array.isArray(request.nodes) ||
      request.nodes.length > 500 ||
      !Array.isArray(request.relations) ||
      request.relations.length > 1000 ||
      typeof request.truncated !== 'boolean' ||
      JSON.stringify(request).length > 1024 * 1024
    )
      throw invalid()
    for (const node of request.nodes) {
      if (
        !validMusicExplorationReference(node.reference) ||
        typeof node.title !== 'string' ||
        !node.title.trim() ||
        node.title.length > 1024 ||
        node.title.includes('\0') ||
        (node.artist !== undefined &&
          (typeof node.artist !== 'string' ||
            node.artist.length > 1024 ||
            node.artist.includes('\0'))) ||
        (node.aliases !== undefined &&
          (!Array.isArray(node.aliases) ||
            node.aliases.length > 32 ||
            node.aliases.some(
              (r) => !validMusicExplorationReference(r) || r.kind !== node.reference.kind
            )))
      )
        throw invalid()
    }
    const relationKinds = new Set([
      'credit',
      'work_recording',
      'work_performance',
      'performance_recording',
      'part'
    ])
    for (const r of request.relations) {
      if (
        !validMusicExplorationReference(r.from) ||
        !validMusicExplorationReference(r.to) ||
        !relationKinds.has(r.kind) ||
        !Number.isSafeInteger(r.order) ||
        r.order < 0 ||
        r.order > 1000000
      )
        throw invalid()
      const shape =
        r.kind === 'credit'
          ? r.from.kind === 'artist' &&
            !!r.credit &&
            r.credit.personRef.kind === 'artist' &&
            referenceKey(r.credit.personRef) === referenceKey(r.from) &&
            referenceKey(r.credit.targetRef) === referenceKey(r.to)
          : r.kind === 'work_recording'
            ? r.from.kind === 'work' && r.to.kind === 'recording'
            : r.kind === 'work_performance'
              ? r.from.kind === 'work' && r.to.kind === 'performance'
              : r.kind === 'performance_recording'
                ? r.from.kind === 'performance' && r.to.kind === 'recording'
                : r.from.kind === r.to.kind && ['work', 'performance'].includes(r.from.kind)
      if (!shape) throw invalid()
      if (
        r.usage &&
        (['display', 'cache', 'crossSource', 'export'].some(
          (k) => typeof r.usage?.[k as keyof typeof r.usage] !== 'boolean'
        ) ||
          (r.usage.expiresAt !== undefined &&
            (!Number.isSafeInteger(r.usage.expiresAt) || r.usage.expiresAt < 0)))
      )
        throw invalid()
      if (
        r.sourceProvider !== undefined &&
        (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(r.sourceProvider) ||
          typeof r.providerContext !== 'string' ||
          !r.providerContext ||
          r.providerContext.length > 8192)
      )
        throw invalid()
      if (r.providerContext !== undefined && !r.sourceProvider) throw invalid()
      if (
        r.attribution !== null &&
        (!r.attribution ||
          typeof r.attribution.provider !== 'string' ||
          typeof r.attribution.url !== 'string' ||
          !Number.isFinite(r.attribution.retrievedAt))
      )
        throw invalid()
    }
  }
  private lookup(ref: MusicExplorationReference): string | null {
    const r = this.sql
      .prepare(
        'SELECT entity_id FROM music_exploration_refs WHERE provider=? AND kind=? AND id_type=? AND value=?'
      )
      .get(ref.provider, ref.kind, ref.idType, ref.value)
    return r ? String(r.entity_id) : null
  }
  private anchor(node: MusicExplorationIngest['nodes'][number]): string {
    const refs = [node.reference, ...(node.aliases ?? [])],
      found = new Set(
        refs.flatMap((r) => {
          const id = this.lookup(r)
          return id ? [id] : []
        })
      )
    // Typed aliases already proved by metadata identity share the same exact target; title never participates.
    for (const r of refs)
      for (const row of this.sql
        .prepare(
          `SELECT DISTINCT er.entity_id FROM metadata_identity_refs ir
      JOIN metadata_identity_refs aliases ON aliases.target_id=ir.target_id AND aliases.kind=ir.kind
      JOIN music_exploration_refs er ON er.provider=aliases.provider AND er.kind=aliases.kind AND er.id_type=aliases.id_type AND er.value=aliases.value
      WHERE ir.provider=? AND ir.kind=? AND ir.id_type=? AND ir.value=?`
        )
        .all(r.provider, r.kind, r.idType, r.value))
        found.add(String(row.entity_id))
    if (found.size > 1)
      throw Object.assign(new Error('外部引用已指向不同人物或作品，请先复核关联'), {
        code: 'IDENTITY_CONFLICT'
      })
    const id = [...found][0] ?? randomUUID()
    if (found.size === 0)
      this.sql
        .prepare(
          "INSERT INTO catalog_entities(id,kind,title,artist,identity) VALUES(?,?,?,?,'source')"
        )
        .run(id, node.reference.kind, node.title, node.artist ?? '')
    else {
      const old = this.sql
        .prepare('SELECT title,artist,kind FROM catalog_entities WHERE id=?')
        .get(id)!
      if (old.kind !== node.reference.kind) throw invalid()
      if (old.title !== node.title || (node.artist !== undefined && old.artist !== node.artist)) {
        this.sql
          .prepare('UPDATE catalog_entities SET title=?,artist=? WHERE id=?')
          .run(node.title, node.artist ?? String(old.artist), id)
        this.sql.exec(mutation)
      }
    }
    for (const r of refs)
      this.sql
        .prepare(
          'INSERT INTO music_exploration_refs(provider,kind,id_type,value,entity_id) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING'
        )
        .run(r.provider, r.kind, r.idType, r.value, id)
    return id
  }
  ingest(request: MusicExplorationIngest): MusicExplorationState {
    this.validateIngest(request)
    return this.owner.transaction(() => {
      for (const node of request.nodes) this.anchor(node)
      const ownerId = this.lookup(request.owner)
      if (!ownerId) throw invalid()
      const edges = request.relations.map((r) => {
        const from = this.lookup(r.from),
          to = this.lookup(r.to)
        if (!from || !to) throw invalid()
        return { from, to, kind: r.kind, order: r.order, payload: JSON.stringify(r) }
      })
      const previous = this.sql
        .prepare(
          'SELECT * FROM music_exploration_sets WHERE owner_id=? AND provider=? AND set_key=?'
        )
        .get(ownerId, request.provider, request.setKey)
      if (previous && previous.origin !== 'provider') throw invalid()
      const setId = previous ? String(previous.id) : randomUUID()
      const old = previous
        ? this.sql
            .prepare(
              'SELECT from_id,to_id,kind,position,payload FROM music_exploration_relations WHERE set_id=? ORDER BY rowid'
            )
            .all(setId)
        : []
      const same =
        previous &&
        Number(previous.truncated) === (request.truncated ? 1 : 0) &&
        old.length === edges.length &&
        edges.every(
          (e, i) =>
            e.from === old[i].from_id &&
            e.to === old[i].to_id &&
            e.kind === old[i].kind &&
            e.order === old[i].position &&
            e.payload === old[i].payload
        )
      if (!same) {
        this.sql
          .prepare(
            `INSERT INTO music_exploration_sets VALUES(?,?,?,?,1,?,'provider') ON CONFLICT(owner_id,provider,set_key)
          DO UPDATE SET revision=revision+1,truncated=excluded.truncated`
          )
          .run(setId, ownerId, request.provider, request.setKey, request.truncated ? 1 : 0)
        this.sql.prepare('DELETE FROM music_exploration_relations WHERE set_id=?').run(setId)
        const put = this.sql.prepare(
          'INSERT INTO music_exploration_relations VALUES(?,?,?,?,?,?,?)'
        )
        for (const e of edges)
          put.run(randomUUID(), setId, e.from, e.to, e.kind, e.order, e.payload)
      }
      return this.state()
    })
  }
  syncCredits(request: MusicExplorationCreditSync): MusicExplorationState {
    if (
      !request ||
      typeof request.targetId !== 'string' ||
      !request.targetId ||
      request.targetId.length > 128 ||
      typeof request.provider !== 'string' ||
      !request.provider
    )
      throw invalid()
    // The old credit schema has no rights/account context. Only the deployed
    // public MusicBrainz structure adapter is approved for this global graph.
    if (request.provider !== 'musicbrainz-details') return this.state()
    const cached = this.sql
      .prepare('SELECT * FROM metadata_credit_sets WHERE target_id=? AND provider=?')
      .get(request.targetId, request.provider)
    if (!cached) return this.state()
    const refs = (
      this.sql
        .prepare(
          'SELECT provider,kind,id_type,value FROM metadata_identity_refs WHERE target_id=? ORDER BY provider,kind,id_type,value'
        )
        .all(request.targetId) as Row[]
    ).map((r) => ({
      provider: String(r.provider),
      kind: r.kind as MusicExplorationReference['kind'],
      idType: String(r.id_type),
      value: String(r.value)
    }))
    const target = this.sql
      .prepare('SELECT * FROM metadata_entities WHERE id=?')
      .get(request.targetId)
    if (!target || !refs.length) return this.state()
    const owner = refs[0],
      nodes: MusicExplorationIngest['nodes'] = [
        {
          reference: owner,
          aliases: refs.slice(1, 33),
          title:
            (String(target.name) || owner.value).replaceAll('\0', '').slice(0, 1024) || owner.value
        }
      ]
    const credits = (
      this.sql
        .prepare(
          'SELECT payload FROM metadata_credits WHERE target_id=? AND provider=? ORDER BY position LIMIT 1001'
        )
        .all(request.targetId, request.provider) as Row[]
    ).map((r) => decode<MusicCredit>(r.payload))
    const seen = new Set(
      nodes.flatMap((n) => [n.reference, ...(n.aliases ?? [])].map(referenceKey))
    )
    const relations: MusicExplorationRelationInput[] = []
    let truncated = !!cached.truncated || credits.length > 1000 || refs.length > 33
    let projectedBytes = JSON.stringify(nodes).length + 1024
    for (const credit of credits.slice(0, 1000)) {
      if (
        !validMusicExplorationReference(credit.personRef) ||
        credit.personRef.kind !== 'artist' ||
        !validMusicExplorationReference(credit.targetRef)
      )
        continue
      const newNodes = [
        {
          reference: credit.personRef,
          title:
            (credit.name || credit.personRef.value).replaceAll('\0', '').slice(0, 1024) ||
            credit.personRef.value
        },
        {
          reference: credit.targetRef,
          title:
            credit.targetRef.kind === owner.kind &&
            refs.some((r) => referenceKey(r) === referenceKey(credit.targetRef))
              ? String(target.name) || owner.value
              : ((this.sql
                  .prepare('SELECT title FROM catalog_entities WHERE id=?')
                  .get(this.lookup(credit.targetRef))?.title as string | undefined) ??
                credit.targetRef.value)
        }
      ].filter((n) => !seen.has(referenceKey(n.reference)))
      const relation: MusicExplorationRelationInput = {
        from: credit.personRef,
        to: credit.targetRef,
        kind: 'credit',
        order: credit.order,
        credit,
        attribution: credit.attribution
      }
      const addedBytes = JSON.stringify(newNodes).length + JSON.stringify(relation).length + 2
      if (nodes.length + newNodes.length > 500 || projectedBytes + addedBytes > 900000) {
        truncated = true
        continue
      }
      projectedBytes += addedBytes
      for (const n of newNodes) {
        if (!seen.has(referenceKey(n.reference))) {
          nodes.push(n)
          seen.add(referenceKey(n.reference))
        }
      }
      relations.push(relation)
    }
    return this.ingest({
      owner,
      provider: request.provider,
      setKey: `credits:${request.targetId}`,
      nodes,
      relations,
      truncated
    })
  }
  /** One-time old-cache projection, resumable after process interruption. Each source set is atomic. */
  backfillCredits(limit = 100): { processed: number; pending: boolean } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid()
    const cursor = Number(
      this.sql.prepare('SELECT credit_cursor FROM music_exploration_state WHERE id=1').get()!
        .credit_cursor
    )
    const rows = this.sql
      .prepare(
        'SELECT rowid cursor,target_id,provider FROM metadata_credit_sets WHERE rowid>? ORDER BY rowid LIMIT ?'
      )
      .all(cursor, limit)
    for (const row of rows)
      this.owner.transaction(() => {
        this.syncCredits({ targetId: String(row.target_id), provider: String(row.provider) })
        this.sql
          .prepare('UPDATE music_exploration_state SET credit_cursor=? WHERE id=1')
          .run(Number(row.cursor))
      })
    const next = rows.length ? Number(rows[rows.length - 1].cursor) : cursor
    return {
      processed: rows.length,
      pending: !!this.sql
        .prepare('SELECT 1 FROM metadata_credit_sets WHERE rowid>? LIMIT 1')
        .get(next)
    }
  }
  performanceSave(request: MusicExplorationPerformanceSave): MusicExplorationDetail {
    if (!validMusicExplorationPayload('exploration.performance.save', request)) throw invalid()
    const id = this.owner.transaction(() => {
      if (this.state().revision !== request.revision) throw stale()
      const work = this.sql
        .prepare(
          "SELECT 1 FROM catalog_entities e WHERE e.id=? AND e.kind='work' AND EXISTS(SELECT 1 FROM music_exploration_refs r WHERE r.entity_id=e.id)"
        )
        .get(request.workId)
      if (!work) throw invalid()
      for (const recording of request.recordingIds)
        if (
          !this.sql
            .prepare("SELECT 1 FROM catalog_entities WHERE id=? AND kind='recording'")
            .get(recording)
        )
          throw invalid()
      const id = request.id ?? randomUUID(),
        previous = this.sql
          .prepare(
            "SELECT * FROM music_exploration_sets WHERE owner_id=? AND provider='twilight' AND set_key='manual-performance' AND origin='manual'"
          )
          .get(id)
      if (request.id && !previous)
        throw Object.assign(new Error('只能编辑人工建立的演绎'), { code: 'FORBIDDEN' })
      if (!request.id) {
        this.sql
          .prepare("INSERT INTO catalog_entities VALUES(?,'performance',?,'','manual')")
          .run(id, request.title.trim())
        this.sql
          .prepare(
            "INSERT INTO music_exploration_refs VALUES('twilight','performance','manual',?,?)"
          )
          .run(id, id)
      } else
        this.sql
          .prepare('UPDATE catalog_entities SET title=? WHERE id=?')
          .run(request.title.trim(), id)
      const setId = previous ? String(previous.id) : randomUUID()
      this.sql
        .prepare(
          `INSERT INTO music_exploration_sets VALUES(?,?,'twilight','manual-performance',1,0,'manual')
        ON CONFLICT(owner_id,provider,set_key) DO UPDATE SET revision=revision+1`
        )
        .run(setId, id)
      this.sql.prepare('DELETE FROM music_exploration_relations WHERE set_id=?').run(setId)
      const put = this.sql.prepare('INSERT INTO music_exploration_relations VALUES(?,?,?,?,?,?,?)')
      put.run(
        randomUUID(),
        setId,
        request.workId,
        id,
        'work_performance',
        0,
        JSON.stringify({ attribution: null })
      )
      request.recordingIds.forEach((recording, order) =>
        put.run(
          randomUUID(),
          setId,
          id,
          recording,
          'performance_recording',
          order,
          JSON.stringify({ attribution: null })
        )
      )
      return id
    })
    return this.detail({ entityId: id })
  }
  performanceDelete(request: MusicExplorationPerformanceDelete): boolean {
    if (!validMusicExplorationPayload('exploration.performance.delete', request)) throw invalid()
    return this.owner.transaction(() => {
      if (this.state().revision !== request.revision) throw stale()
      const result = this.sql
        .prepare(
          "DELETE FROM music_exploration_sets WHERE owner_id=? AND provider='twilight' AND set_key='manual-performance' AND origin='manual'"
        )
        .run(request.id)
      // Keep stable anchor and personal references after the relations are removed.
      return Number(result.changes) > 0
    })
  }
}
