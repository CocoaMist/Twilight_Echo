import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { TrackData } from '../../shared/track.ts'
import { explorationMembershipCtes } from './libraryDatabaseExploration.ts'
import {
  normalizeMusicTagName, validMusicTagsPayload,
  type MusicTag, type MusicTagsToken, type MusicTagsListQuery, type MusicTagsListPage,
  type MusicTagsEntityQuery, type MusicTagsEntityPage, type MusicTagsMembersQuery,
  type MusicTagsMembersPage, type MusicTagsRecordingsPage, type MusicTagsCreate,
  type MusicTagsRename, type MusicTagsDelete, type MusicTagsDeleteResult,
  type MusicTagsMemberSet, type MusicTagsWriteResult, type MusicTagsPlaybackPage,
  type MusicTagRecording, type MusicTagMemberKind
} from '../../shared/musicTags.ts'

export const TAG_SCHEMA_OBJECTS = [
  'personal_tags_state', 'personal_tags', 'personal_tag_members', 'personal_tag_members_entity',
  'personal_tags_identity_insert', 'personal_tags_identity_update', 'personal_tags_identity_delete'
]
export const TAG_SCHEMA_SQL = `
CREATE TABLE personal_tags_state(profile_id TEXT PRIMARY KEY CHECK(profile_id='default'),revision INTEGER NOT NULL,link_revision INTEGER NOT NULL);
INSERT INTO personal_tags_state VALUES('default',0,0);
CREATE TABLE personal_tags(profile_id TEXT NOT NULL CHECK(profile_id='default'),id TEXT NOT NULL,name TEXT NOT NULL,normalized_name TEXT NOT NULL,
  name_revision INTEGER NOT NULL,members_revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,
  PRIMARY KEY(profile_id,id),UNIQUE(profile_id,normalized_name));
CREATE TABLE personal_tag_members(profile_id TEXT NOT NULL CHECK(profile_id='default'),tag_id TEXT NOT NULL,
  entity_id TEXT NOT NULL REFERENCES catalog_entities(id),PRIMARY KEY(profile_id,tag_id,entity_id),
  FOREIGN KEY(profile_id,tag_id) REFERENCES personal_tags(profile_id,id) ON DELETE CASCADE);
CREATE INDEX personal_tag_members_entity ON personal_tag_members(profile_id,entity_id,tag_id);
CREATE TRIGGER personal_tags_identity_insert AFTER INSERT ON metadata_identity_links
WHEN new.kind='recording' AND new.state='confirmed'
BEGIN UPDATE personal_tags_state SET link_revision=link_revision+1 WHERE profile_id='default'; END;
CREATE TRIGGER personal_tags_identity_update AFTER UPDATE ON metadata_identity_links
WHEN new.kind='recording' AND (old.state='confirmed' OR new.state='confirmed')
  AND (old.revision IS NOT new.revision OR old.state IS NOT new.state OR old.target_id IS NOT new.target_id)
BEGIN UPDATE personal_tags_state SET link_revision=link_revision+1 WHERE profile_id='default'; END;
CREATE TRIGGER personal_tags_identity_delete AFTER DELETE ON metadata_identity_links
WHEN old.kind='recording' AND old.state='confirmed'
BEGIN UPDATE personal_tags_state SET link_revision=link_revision+1 WHERE profile_id='default'; END;
`
export interface MusicTagsOwner {
  sql: DatabaseSync; transaction<T>(action: () => T): T; contentRevision(): number
  resolve(sourceId: string, catalogRevision: number): TrackData | null
}
type Row = Record<string, unknown>
const stale = () => Object.assign(new Error('标签或音乐库已变化，请刷新后重试'), { code: 'STALE_REVISION' })
const conflict = () => Object.assign(new Error('已有同名标签，请换一个名称'), { code: 'TAG_NAME_CONFLICT' })
const sameToken = (a: MusicTagsToken, b: MusicTagsToken) => Object.keys(a).every(k => a[k as keyof MusicTagsToken] === b[k as keyof MusicTagsToken])
const displayName = (name: string) => name.normalize('NFKC').trim().replace(/\s+/gu, ' ')

/** Tags are stable physical references; identity is only a current expansion deduplication key. */
export class LibraryDatabaseTags {
  private readonly owner: MusicTagsOwner
  constructor(owner: MusicTagsOwner) { this.owner = owner }
  private get sql() { return this.owner.sql }
  private read<T>(action: () => T): T {
    if (this.sql.isTransaction) return action()
    this.sql.exec('BEGIN')
    try { const result = action(); this.sql.exec('COMMIT'); return result }
    catch (error) { this.sql.exec('ROLLBACK'); throw error }
  }
  private transaction<T>(action: () => T): T { return this.sql.isTransaction ? action() : this.owner.transaction(action) }
  private valid(name: string, value: unknown) { if (!validMusicTagsPayload(name, value)) throw new Error('无效的标签操作') }
  state(): MusicTagsToken {
    return this.read(() => {
      const row = this.sql.prepare("SELECT revision,link_revision FROM personal_tags_state WHERE profile_id='default'").get()!
      return { tagsRevision: Number(row.revision), linkRevision: Number(row.link_revision),
        catalogRevision: Number(this.sql.prepare("SELECT value FROM catalog_state WHERE key='revision'").get()!.value), contentRevision: this.owner.contentRevision() }
    })
  }
  revision() { return this.state().tagsRevision }
  private fence(expected?: MusicTagsToken): MusicTagsToken { const token = this.state(); if (expected && !sameToken(token, expected)) throw stale(); return token }
  private target(entityId: string) {
    const row = this.sql.prepare('SELECT id,kind,identity FROM catalog_entities WHERE id=?').get(entityId)
    if (!row || !['recording', 'release', 'artist', 'work'].includes(String(row.kind))) throw new Error('标签只支持歌曲、具体专辑发行版、人物或作品')
    if (row.identity !== 'source') throw new Error('请选择具体歌曲、专辑发行版、人物或作品后添加标签')
    return row
  }
  private tag(id: string): MusicTag {
    const row = this.sql.prepare(`SELECT t.*,(SELECT count(*) FROM personal_tag_members m WHERE m.profile_id=t.profile_id AND m.tag_id=t.id) member_count
      FROM personal_tags t WHERE t.profile_id='default' AND t.id=?`).get(id)
    if (!row) throw new Error('标签已不存在，请刷新后重试')
    return this.decodeTag(row)
  }
  private decodeTag(row: Row): MusicTag { return { id: String(row.id), name: String(row.name), nameRevision: Number(row.name_revision),
    membersRevision: Number(row.members_revision), memberCount: Number(row.member_count), updatedAt: Number(row.updated_at) } }
  private bump() { this.sql.prepare("UPDATE personal_tags_state SET revision=revision+1 WHERE profile_id='default'").run() }
  private now(now: number) { if (!Number.isSafeInteger(now) || now < 0) throw new Error('无效的标签修改时间') }
  private unique(name: string, except = '') {
    if (this.sql.prepare("SELECT 1 FROM personal_tags WHERE profile_id='default' AND normalized_name=? AND id<>?").get(normalizeMusicTagName(name), except)) throw conflict()
  }
  list(query: MusicTagsListQuery = {}): MusicTagsListPage {
    this.valid('tags.list', query)
    return this.read(() => {
      const token = this.fence(query.token), search = normalizeMusicTagName(query.search ?? ''), offset = query.offset ?? 0
      const from = `FROM personal_tags t WHERE t.profile_id='default' AND instr(t.normalized_name,?)>0`
      return { token, offset, total: Number(this.sql.prepare(`SELECT count(*) n ${from}`).get(search)!.n),
        items: this.sql.prepare(`SELECT t.*,(SELECT count(*) FROM personal_tag_members m WHERE m.profile_id=t.profile_id AND m.tag_id=t.id) member_count
          ${from} ORDER BY t.normalized_name,t.id LIMIT ? OFFSET ?`).all(search, query.limit ?? 50, offset).map(row => this.decodeTag(row)) }
    })
  }
  entity(query: MusicTagsEntityQuery): MusicTagsEntityPage {
    this.valid('tags.entity', query)
    return this.read(() => {
      const token = this.fence(query.token), offset = query.offset ?? 0
      this.target(query.entityId)
      const from = `FROM personal_tags t JOIN personal_tag_members m ON m.profile_id=t.profile_id AND m.tag_id=t.id WHERE t.profile_id='default' AND m.entity_id=?`
      return { entityId: query.entityId, token, offset, total: Number(this.sql.prepare(`SELECT count(*) n ${from}`).get(query.entityId)!.n),
        items: this.sql.prepare(`SELECT t.*,(SELECT count(*) FROM personal_tag_members x WHERE x.profile_id=t.profile_id AND x.tag_id=t.id) member_count
          ${from} ORDER BY t.normalized_name,t.id LIMIT ? OFFSET ?`).all(query.entityId, query.limit ?? 50, offset).map(row => this.decodeTag(row)) }
    })
  }
  members(query: MusicTagsMembersQuery): MusicTagsMembersPage {
    this.valid('tags.members', query)
    return this.read(() => {
      const token = this.fence(query.token), tag = this.tag(query.tagId), offset = query.offset ?? 0
      const physical = `(s.recording_id=e.id OR s.release_id=e.id)`
      const from = `FROM personal_tag_members m JOIN catalog_entities e ON e.id=m.entity_id WHERE m.profile_id='default' AND m.tag_id=?`
      return { token, tag, offset, total: tag.memberCount,
        items: this.sql.prepare(`WITH ${explorationMembershipCtes()} SELECT e.id,e.kind,e.title,e.artist,
          CASE WHEN e.kind IN ('artist','work') THEN (SELECT count(DISTINCT source_id) FROM exploration_memberships em WHERE em.entity_id=e.id)
          ELSE (SELECT count(DISTINCT s.id) FROM catalog_sources s JOIN catalog_memberships cm ON cm.source_id=s.id WHERE ${physical}) END source_count ${from}
          ORDER BY e.kind,e.title,e.id LIMIT ? OFFSET ?`).all(query.tagId, query.limit ?? 50, offset).map(row => ({ id: String(row.id),
          kind: row.kind as MusicTagMemberKind, title: String(row.title), artist: String(row.artist), sourceCount: Number(row.source_count), inLibrary: Number(row.source_count) > 0 })) }
    })
  }
  /** One SQL relation powers total, public pages and private queue pages. Cached directory rows never qualify. */
  private expansion() { return `WITH candidates AS (
    SELECT DISTINCT s.id,s.recording_id,s.provider,s.track_id,s.preferred_recording,
      CASE WHEN added.value<>'' AND added.value NOT GLOB '*[^0-9]*' AND CAST(added.value AS INTEGER) BETWEEN 0 AND 9007199254740991
        THEN CAST(added.value AS INTEGER) ELSE NULL END member_added,
      CASE WHEN l.state='confirmed' AND me.kind='recording' THEN json_array('identity',l.target_id) ELSE json_array('entity',s.recording_id) END dedup_key
    FROM personal_tag_members tm JOIN catalog_entities e ON e.id=tm.entity_id
    JOIN catalog_bindings s ON (e.kind='recording' AND s.recording_id=e.id) OR (e.kind='release' AND s.release_id=e.id)
    LEFT JOIN catalog_state added ON added.key='membership_added:'||s.id
    LEFT JOIN metadata_identity_links l ON l.entity_id=s.recording_id AND l.kind='recording'
    LEFT JOIN metadata_entities me ON me.id=l.target_id
    WHERE tm.profile_id='default' AND tm.tag_id=? AND EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)
      AND (s.provider<>'local' OR (EXISTS(SELECT 1 FROM tracks t WHERE t.id=s.track_id)
        AND NOT EXISTS(SELECT 1 FROM catalog_pending p WHERE p.track_id=s.track_id)))),
    ranked AS (SELECT *,row_number() OVER (PARTITION BY dedup_key ORDER BY preferred_recording DESC,member_added IS NULL,member_added,id) choice,
      count(*) OVER (PARTITION BY dedup_key) source_count FROM candidates),
    selected AS (SELECT r.*,e.title,e.artist FROM ranked r JOIN catalog_entities e ON e.id=r.recording_id WHERE choice=1)` }
  private recording(row: Row): MusicTagRecording { return { recordingId: String(row.recording_id), title: String(row.title), artist: String(row.artist),
    sourceId: String(row.id), provider: String(row.provider), sourceCount: Number(row.source_count) } }
  private recordingsRead(query: MusicTagsMembersQuery, privateTracks: true): MusicTagsPlaybackPage
  private recordingsRead(query: MusicTagsMembersQuery, privateTracks: false): MusicTagsRecordingsPage
  private recordingsRead(query: MusicTagsMembersQuery, privateTracks: boolean): MusicTagsRecordingsPage | MusicTagsPlaybackPage {
    this.valid('tags.recordings', query)
    return this.read(() => {
      const token = this.fence(query.token), tag = this.tag(query.tagId), offset = query.offset ?? 0, cte = this.expansion()
      const total = Number(this.sql.prepare(`${cte} SELECT count(*) n FROM selected`).get(query.tagId)!.n)
      const rows = this.sql.prepare(`${cte} SELECT * FROM selected ORDER BY dedup_key,id LIMIT ? OFFSET ?`).all(query.tagId, query.limit ?? 50, offset)
      if (!privateTracks) return { token, tag, offset, total, items: rows.map(row => this.recording(row)) }
      return { token, tag, offset, total, items: rows.map(row => {
        const item = this.recording(row), track = this.owner.resolve(item.sourceId, token.catalogRevision)
        if (!track) throw Object.assign(new Error('标签中的来源已变化，请刷新后重试'), { code: 'STALE_REVISION' })
        return { ...item, track }
      }) }
    })
  }
  recordings(query: MusicTagsMembersQuery): MusicTagsRecordingsPage { return this.recordingsRead(query, false) }
  playbackPage(query: MusicTagsMembersQuery): MusicTagsPlaybackPage { return this.recordingsRead(query, true) }
  create(input: MusicTagsCreate, now: number): MusicTagsWriteResult {
    this.valid('tags.create', input); this.now(now)
    return this.transaction(() => {
      if (input.tagsRevision !== this.state().tagsRevision) throw stale()
      this.unique(input.name)
      const id = `tag:${randomUUID()}`
      this.sql.prepare("INSERT INTO personal_tags VALUES('default',?,?,?,1,0,?)").run(id, displayName(input.name), normalizeMusicTagName(input.name), now)
      this.bump(); return { token: this.state(), tag: this.tag(id) }
    })
  }
  rename(input: MusicTagsRename, now: number): MusicTagsWriteResult {
    this.valid('tags.rename', input); this.now(now)
    return this.transaction(() => {
      const tag = this.tag(input.tagId)
      if (input.nameRevision !== tag.nameRevision) throw stale()
      this.unique(input.name, input.tagId)
      const name = displayName(input.name)
      if (name !== tag.name) {
        this.sql.prepare("UPDATE personal_tags SET name=?,normalized_name=?,name_revision=name_revision+1,updated_at=? WHERE profile_id='default' AND id=?")
          .run(name, normalizeMusicTagName(name), now, input.tagId)
        this.bump()
      }
      return { token: this.state(), tag: this.tag(input.tagId) }
    })
  }
  delete(input: MusicTagsDelete): MusicTagsDeleteResult {
    this.valid('tags.delete', input)
    return this.transaction(() => {
      const tag = this.tag(input.tagId)
      if (input.nameRevision !== tag.nameRevision || input.membersRevision !== tag.membersRevision) throw stale()
      this.sql.prepare("DELETE FROM personal_tags WHERE profile_id='default' AND id=?").run(input.tagId)
      this.bump(); return { token: this.state(), deletedId: input.tagId }
    })
  }
  memberSet(input: MusicTagsMemberSet, now: number): MusicTagsWriteResult {
    this.valid('tags.member.set', input); this.now(now)
    return this.transaction(() => {
      const tag = this.tag(input.tagId)
      if (input.membersRevision !== tag.membersRevision) throw stale()
      this.target(input.entityId)
      const result = input.present
        ? this.sql.prepare("INSERT OR IGNORE INTO personal_tag_members VALUES('default',?,?)").run(input.tagId, input.entityId)
        : this.sql.prepare("DELETE FROM personal_tag_members WHERE profile_id='default' AND tag_id=? AND entity_id=?").run(input.tagId, input.entityId)
      if (result.changes) {
        this.sql.prepare("UPDATE personal_tags SET members_revision=members_revision+1,updated_at=? WHERE profile_id='default' AND id=?").run(now, input.tagId)
        this.bump()
      }
      return { token: this.state(), tag: this.tag(input.tagId) }
    })
  }
}
