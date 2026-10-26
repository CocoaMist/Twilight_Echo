import type { DatabaseSync } from 'node:sqlite'
import type { CatalogKind } from '../../shared/musicCatalog.ts'
import {
  validMusicRatingsPayload, validMusicRatingResolution,
  type MusicRatingKind, type MusicRatingValue, type MusicRatingsDetail,
  type MusicRatingsSet, type MusicRatingsHistoryQuery, type MusicRatingsHistoryPage,
  type MusicRatingsTargetsQuery, type MusicRatingsTargetsPage,
  type MusicRatingChangeReason, type MusicRatingImpact, type MusicRatingResolution
} from '../../shared/musicRatings.ts'

export const RATING_SCHEMA_OBJECTS = [
  'personal_ratings_state', 'personal_rating_values', 'personal_rating_history',
  'personal_rating_history_target', 'personal_ratings_identity_insert',
  'personal_ratings_identity_update', 'personal_ratings_identity_delete'
]
export const RATING_SCHEMA_SQL = `
CREATE TABLE personal_ratings_state(profile_id TEXT PRIMARY KEY CHECK(profile_id='default'),revision INTEGER NOT NULL);
INSERT INTO personal_ratings_state VALUES('default',0);
CREATE TABLE personal_rating_values(profile_id TEXT NOT NULL CHECK(profile_id='default'),target_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('recording','release')),steps INTEGER CHECK(steps IS NULL OR (typeof(steps)='integer' AND steps BETWEEN 1 AND 10)),
  revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(profile_id,target_key));
CREATE TABLE personal_rating_history(seq INTEGER PRIMARY KEY AUTOINCREMENT,profile_id TEXT NOT NULL CHECK(profile_id='default'),
  target_key TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('recording','release')),steps INTEGER CHECK(steps IS NULL OR (typeof(steps)='integer' AND steps BETWEEN 1 AND 10)),
  revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,reason TEXT NOT NULL);
CREATE INDEX personal_rating_history_target ON personal_rating_history(profile_id,target_key,seq);
CREATE TRIGGER personal_ratings_identity_insert AFTER INSERT ON metadata_identity_links
WHEN new.kind IN ('recording','release') AND new.state='confirmed'
BEGIN UPDATE personal_ratings_state SET revision=revision+1 WHERE profile_id='default'; END;
CREATE TRIGGER personal_ratings_identity_update AFTER UPDATE ON metadata_identity_links
WHEN new.kind IN ('recording','release') AND (old.state='confirmed' OR new.state='confirmed')
  AND (old.revision IS NOT new.revision OR old.state IS NOT new.state OR old.target_id IS NOT new.target_id)
BEGIN UPDATE personal_ratings_state SET revision=revision+1 WHERE profile_id='default'; END;
CREATE TRIGGER personal_ratings_identity_delete AFTER DELETE ON metadata_identity_links
WHEN old.kind IN ('recording','release') AND old.state='confirmed'
BEGIN UPDATE personal_ratings_state SET revision=revision+1 WHERE profile_id='default'; END;
`
type Owner = { sql: DatabaseSync; transaction<T>(action: () => T): T }
type Target = { kind: MusicRatingKind; scope: 'entity' | 'identity'; key: string; linkRevision: number }
type Row = Record<string, unknown>
const isKind = (v: unknown): v is MusicRatingKind => v === 'recording' || v === 'release'
const targetKey = (scope: Target['scope'], kind: MusicRatingKind, id: string) => JSON.stringify([scope, kind, id])
const stale = () => Object.assign(new Error('评分或身份关联已变化，请重新读取评分后再操作'), { code: 'STALE_REVISION' })
const decode = (row: Row): MusicRatingValue => ({ steps: row.steps === null ? null : Number(row.steps), revision: Number(row.revision), updatedAt: Number(row.updated_at) })

/** Persistent personal data does not depend on a source still being online or a library member. */
export class LibraryDatabaseRatings {
  private readonly owner: Owner
  constructor(owner: Owner) { this.owner = owner }
  private get sql() { return this.owner.sql }
  private transaction<T>(action: () => T): T { return this.sql.isTransaction ? action() : this.owner.transaction(action) }
  /** Values, links and their public fence must come from the same SQLite snapshot. */
  private read<T>(action: () => T): T {
    if (this.sql.isTransaction) return action()
    this.sql.exec('BEGIN')
    try { const result = action(); this.sql.exec('COMMIT'); return result }
    catch (error) { this.sql.exec('ROLLBACK'); throw error }
  }
  revision(): number { return Number(this.sql.prepare("SELECT revision FROM personal_ratings_state WHERE profile_id='default'").get()!.revision) }
  private target(entityId: string): Target {
    const entity = this.sql.prepare('SELECT kind,identity FROM catalog_entities WHERE id=?').get(entityId)
    if (!entity || !isKind(entity.kind)) throw new Error('只能为歌曲或具体专辑发行版设置个人评分')
    if (entity.identity !== 'source') throw new Error('播放版本仅用于导航，请选择具体歌曲或专辑发行版后评分')
    const link = this.sql.prepare('SELECT revision,state,target_id FROM metadata_identity_links WHERE entity_id=? AND kind=?').get(entityId, entity.kind)
    if (link?.state === 'confirmed' && link.target_id) {
      const identity = this.sql.prepare('SELECT kind FROM metadata_entities WHERE id=?').get(String(link.target_id))
      if (!identity || identity.kind !== entity.kind) throw new Error('评分身份类型不匹配，请重新核对关联')
      return { kind: entity.kind, scope: 'identity', key: targetKey('identity', entity.kind, String(link.target_id)), linkRevision: Number(link.revision) }
    }
    return { kind: entity.kind, scope: 'entity', key: targetKey('entity', entity.kind, entityId), linkRevision: Number(link?.revision ?? 0) }
  }
  private value(key: string): MusicRatingValue | null {
    const row = this.sql.prepare("SELECT * FROM personal_rating_values WHERE profile_id='default' AND target_key=?").get(key)
    return row ? decode(row) : null
  }
  detail(entityId: string): MusicRatingsDetail {
    if (!validMusicRatingsPayload('ratings.detail', { entityId })) throw new Error('无效的评分查询')
    return this.read(() => {
      const target = this.target(entityId)
      return { entityId, kind: target.kind, scope: target.scope, value: this.value(target.key),
        token: { ratingsRevision: this.revision(), linkRevision: target.linkRevision, targetKey: target.key } }
    })
  }
  targets(query: MusicRatingsTargetsQuery): MusicRatingsTargetsPage {
    if (!validMusicRatingsPayload('ratings.targets', query)) throw new Error('无效的评分对象查询')
    return this.read(() => {
    const entity = this.sql.prepare('SELECT * FROM catalog_entities WHERE id=?').get(query.entityId)
    if (!entity || !isKind(entity.kind)) throw new Error('只能查询歌曲或具体专辑发行版的评分对象')
    const offset = query.offset ?? 0, limit = query.limit ?? 20
    const physical = entity.kind === 'recording' ? 'recording_id' : 'release_id'
    const context = query.trackContext
    const select = entity.identity === 'source'
      ? context
        ? `SELECT DISTINCT s.${physical} AS id FROM catalog_sources s WHERE s.${physical}=? AND s.provider=? AND s.track_id=?`
        : 'SELECT id FROM catalog_entities WHERE id=?'
      : `SELECT DISTINCT s.${physical} AS id
         FROM catalog_entity_sources b JOIN catalog_sources s ON s.id=b.source_id WHERE b.entity_id=?
         ${context ? 'AND s.provider=? AND s.track_id=?' : ''}`
    const from = `FROM catalog_entities e WHERE e.identity='source' AND e.kind=? AND e.id IN (${select})`
    const args = [entity.kind, query.entityId, ...(context ? [context.provider, context.id] : [])]
    return { entityId: query.entityId, offset,
      total: Number(this.sql.prepare(`SELECT count(*) n ${from}`).get(...args)!.n),
      items: this.sql.prepare(`SELECT e.id,e.kind,e.title,e.artist ${from} ORDER BY e.id LIMIT ? OFFSET ?`)
        .all(...args, limit, offset).map(row => ({ id: String(row.id), kind: row.kind as MusicRatingKind, title: String(row.title), artist: String(row.artist) })) }
    })
  }
  private write(target: Pick<Target, 'kind' | 'key'>, steps: number | null, now: number, reason: MusicRatingChangeReason) {
    const previous = this.value(target.key), revision = (previous?.revision ?? 0) + 1
    this.sql.prepare(`INSERT INTO personal_rating_values VALUES('default',?,?,?,?,?)
      ON CONFLICT(profile_id,target_key) DO UPDATE SET steps=excluded.steps,revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(target.key, target.kind, steps, revision, now)
    this.sql.prepare(`INSERT INTO personal_rating_history(profile_id,target_key,kind,steps,revision,updated_at,reason)
      VALUES('default',?,?,?,?,?,?)`).run(target.key, target.kind, steps, revision, now, reason)
    this.sql.prepare("UPDATE personal_ratings_state SET revision=revision+1 WHERE profile_id='default'").run()
  }
  set(request: MusicRatingsSet, now: number): MusicRatingsDetail {
    if (!validMusicRatingsPayload('ratings.set', request) || !Number.isSafeInteger(now) || now < 0) throw new Error('无效的个人评分')
    return this.transaction(() => {
      const target = this.target(request.entityId), token = request.token
      if (token.ratingsRevision !== this.revision() || token.linkRevision !== target.linkRevision || token.targetKey !== target.key) throw stale()
      this.write(target, request.steps, now, request.steps === null ? 'clear' : 'set')
      return this.detail(request.entityId)
    })
  }
  history(query: MusicRatingsHistoryQuery): MusicRatingsHistoryPage {
    if (!validMusicRatingsPayload('ratings.history', query)) throw new Error('无效的评分历史查询')
    return this.read(() => {
    const target = this.target(query.entityId), offset = query.offset ?? 0
    return { entityId: query.entityId, kind: target.kind, scope: target.scope, offset,
      total: Number(this.sql.prepare("SELECT count(*) n FROM personal_rating_history WHERE profile_id='default' AND target_key=?").get(target.key)!.n),
      items: this.sql.prepare("SELECT * FROM personal_rating_history WHERE profile_id='default' AND target_key=? ORDER BY seq DESC LIMIT ? OFFSET ?")
        .all(target.key, query.limit ?? 20, offset).map(row => ({ ...decode(row), seq: Number(row.seq), reason: row.reason as MusicRatingChangeReason })) }
    })
  }
  /** Preview is read-only. A not-yet-created metadata identity has no target rating. */
  identityImpact(entityId: string, kind: CatalogKind, proposedTargetId: string | null): MusicRatingImpact | undefined {
    if (!isKind(kind)) return undefined
    return this.read(() => {
    if (this.sql.prepare('SELECT identity FROM catalog_entities WHERE id=?').get(entityId)?.identity !== 'source') return undefined
    const currentTarget = this.target(entityId), current = this.value(currentTarget.key)
    const nextKey = proposedTargetId ? targetKey('identity', kind, proposedTargetId) : null
    const target = nextKey ? this.value(nextKey) : null
    const conflict = !!current && !!target && current.steps !== target.steps
    return { revision: this.revision(), current, target, conflict,
      action: nextKey === currentTarget.key ? 'keep' : conflict ? 'choose' : target ? 'share' : current ? 'carry' : 'keep' }
    })
  }
  /** Called before publishing the link, within the caller's identity transaction. */
  applyIdentity(entityId: string, kind: CatalogKind, proposedTargetId: string, resolution: MusicRatingResolution | undefined, now: number): void {
    if (!isKind(kind) || this.sql.prepare('SELECT identity FROM catalog_entities WHERE id=?').get(entityId)?.identity !== 'source') {
      if (resolution) throw new Error('此身份不支持个人评分选择')
      return
    }
    const impact = this.identityImpact(entityId, kind, proposedTargetId)!
    if (resolution && (!validMusicRatingResolution(resolution) || resolution.revision !== impact.revision)) throw stale()
    if (impact.conflict && !resolution) throw Object.assign(new Error('当前条目与目标身份的个人评分不同，请选择保留哪一个评分'), { code: 'RATING_CONFLICT' })
    const target = { kind, key: targetKey('identity', kind, proposedTargetId) }
    if (resolution?.choice === 'clear') this.write(target, null, now, 'identity_clear')
    else if (resolution?.choice === 'current') {
      if (!impact.current) throw new Error('当前条目没有可保留的评分')
      if (!impact.target || impact.current.steps !== impact.target.steps) this.write(target, impact.current.steps, now, 'identity_current')
    } else if (resolution?.choice !== 'target' && !impact.target && impact.current) this.write(target, impact.current.steps, now, 'identity_carry')
  }
}
