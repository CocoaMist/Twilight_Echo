import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { LibraryMetadata } from '../../shared/libraryDatabase.ts'
import type { Playlist } from '../../shared/playlists.ts'
import { versionSourceKey } from '../../shared/trackSourceIdentity.ts'
import type { TrackData } from '../../shared/track.ts'
import { mergePersonalDomain } from '../../shared/personalBackup.ts'
import { LegacyMusicProvenance } from './legacyMusicProvenance.ts'
import { refreshLegacyMusicDispositions } from './libraryDatabaseLegacyMusic.ts'
import { libraryTrack } from '../../core/playback/libraryTrack.ts'
import {
  MUSIC_BACKUP_RECORDS, MUSIC_BACKUP_MAX_BYTES, MUSIC_BACKUP_MAX_RECORDS,
  emptyMusicBackupRecords, musicBackupJsonReplacer, validateMusicPersonalBackup, validMusicPersonalBackupRevision,
  type MusicBackupRecord, type MusicBackupRecordKind, type MusicBackupRecords, type CompleteMusicBackupRecords,
  type MusicPersonalBackupDocument, type MusicPersonalBackupMapping, type MusicPersonalBackupPreview,
  type MusicPersonalBackupRevision, type MusicPersonalBackupRestoreBundle, type MusicPersonalBackupRestoreResult
} from '../../shared/musicPersonalBackup.ts'

type Owner = { sql: DatabaseSync; metadata(): LibraryMetadata }
type Plan = { entities: Map<string, string>; identities: Map<string, string>; sources: Map<string, string>; mappings: MusicPersonalBackupMapping[]; errors: number; conflicts: MusicPersonalBackupPreview['referenceConflicts'] }
type Merge = 'keep-local' | 'use-backup'
/** Static SQL and explicit columns only. No portable record selects an SQL table or expression. */
const TABLES: Partial<Record<MusicBackupRecordKind, string>> = {
  entities: 'catalog_entities', sourceAliases: 'catalog_aliases', sources: 'catalog_sources', identities: 'metadata_entities', identityRefs: 'metadata_identity_refs',
  explorationRefs: 'music_exploration_refs', subjects: 'metadata_subjects', links: 'metadata_identity_links',
  suppressions: 'metadata_identity_suppressions', identityHistory: 'metadata_identity_history', linkHistory: 'metadata_link_history',
  overrides: 'metadata_overrides', sourcePreferences: 'metadata_source_preferences', artworkOverrides: 'metadata_artwork_overrides', ratings: 'personal_rating_values', ratingHistory: 'personal_rating_history',
  preferences: 'personal_preference_values', preferenceHistory: 'personal_preference_history', favorites: 'personal_preference_playlists',
  preferenceRestores: 'personal_preference_restores', tags: 'personal_tags', tagMembers: 'personal_tag_members', focus: 'personal_focus_queries',
  genres: 'music_genres', genreAliases: 'music_genre_aliases', genreOverrides: 'music_genre_overrides', genreImportOverrides: 'music_genre_import_overrides',
  genreImportNodes: 'music_genre_import_nodes', genreAliasBridges: 'music_genre_alias_bridges', performances: 'music_exploration_sets',
  performanceRelations: 'music_exploration_relations', legacyBindings: 'metadata_legacy_bindings',
  legacyDocuments: 'metadata_legacy_documents', legacyAlbums: 'metadata_legacy_albums', legacyInputs: 'metadata_legacy_inputs', legacyHistory: 'metadata_legacy_history'
}
const PK: Partial<Record<MusicBackupRecordKind, string[]>> = {
  entities: ['id'], sourceAliases: ['namespace', 'key'], identities: ['id'], identityRefs: ['provider', 'kind', 'id_type', 'value'], explorationRefs: ['provider', 'kind', 'id_type', 'value'],
  subjects: ['id'], links: ['entity_id', 'kind'], suppressions: ['entity_id', 'kind', 'provider', 'id_type', 'value'], overrides: ['entity_id'], sourcePreferences: ['entity_id'], artworkOverrides: ['entity_id'],
  ratings: ['profile_id', 'target_key'], preferences: ['profile_id', 'target_key'], favorites: ['id'], preferenceRestores: ['id'],
  tags: ['profile_id', 'id'], tagMembers: ['profile_id', 'tag_id', 'entity_id'], focus: ['profile_id', 'id'], genres: ['id'],
  genreAliases: ['provider', 'normalized'], genreOverrides: ['target_kind', 'target_id'], genreImportOverrides: ['target_kind', 'target_id', 'import_key'],
  genreImportNodes: ['provider', 'original_id'], genreAliasBridges: ['import_provider', 'provider', 'normalized'], performances: ['owner_id', 'provider', 'set_key'],
  legacyBindings: ['plugin_id', 'legacy_id', 'entity_id']
}
const HISTORY_TABLES = { ratingHistory: 'personal_rating_history', preferenceHistory: 'personal_preference_history', identityHistory: 'metadata_identity_history', linkHistory: 'metadata_link_history' } as const
const LEGACY_RECORDS = new Set<MusicBackupRecordKind>(['legacyDocuments', 'legacyAlbums', 'legacyInputs', 'legacyHistory', 'legacyBindings'])
const exportWhere = (name: MusicBackupRecordKind): string => name === 'sourceAliases' ? " WHERE namespace IN ('source.recording','source.release','source.artist')" : name === 'performances' ? " WHERE origin='manual'" : name === 'performanceRelations' ? " WHERE set_id IN (SELECT id FROM music_exploration_sets WHERE origin='manual')" : LEGACY_RECORDS.has(name) ? " WHERE plugin_id IN (SELECT plugin_id FROM metadata_legacy_documents WHERE state='published')" : ''
const stale = () => Object.assign(new Error('音乐整理或曲库已变化，请重新预览备份'), { code: 'STALE_REVISION' })
const invalid = () => new Error('无效的音乐整理备份')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const encoded = (v: unknown) => JSON.stringify(v, musicBackupJsonReplacer)
const str = (v: unknown) => String(v ?? '')
const grouped = (rows: MusicBackupRecord[], column: string): Map<string, MusicBackupRecord[]> => {
  const result = new Map<string, MusicBackupRecord[]>()
  for (const row of rows) { const key = str(row[column]), group = result.get(key); if (group) group.push(row); else result.set(key, [row]) }
  return result
}

export class LibraryDatabasePersonalMusic {
  private readonly owner: Owner
  constructor(owner: Owner) { this.owner = owner }
  private get sql() { return this.owner.sql }
  private meta(key: string): string | null {
    const r = this.sql.prepare('SELECT value FROM meta WHERE key=?').get(key)
    if (!r) return null
    try { return JSON.parse(String(r.value)) as string } catch { return String(r.value) }
  }
  private setMeta(key: string, value: unknown) { this.sql.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)) }
  private origin(create = false): string | null {
    const old = this.meta('music_backup_origin')
    if (old || !create) return old
    const origin = randomUUID(); this.setMeta('music_backup_origin', origin); return origin
  }
  private number(query: string): number { return Number(Object.values(this.sql.prepare(query).get() ?? { n: 0 })[0]) }
  revision(): MusicPersonalBackupRevision {
    return {
      library: this.number("SELECT value FROM meta WHERE key='revision'"), catalog: this.number("SELECT value FROM catalog_state WHERE key='revision'"),
      metadata: this.number('SELECT metadata_revision FROM music_browse_state WHERE id=1'),
      identity: this.number(`SELECT coalesce((SELECT max(seq) FROM metadata_identity_history),0)+coalesce((SELECT max(seq) FROM metadata_link_history),0)`),
      ratings: this.number("SELECT revision FROM personal_ratings_state WHERE profile_id='default'"),
      preferences: this.number("SELECT revision FROM personal_preferences_state WHERE profile_id='default'"),
      playlists: this.number('SELECT coalesce((SELECT revision FROM personal_preference_playlists WHERE id=1),0)'),
      tags: this.number("SELECT revision+link_revision FROM personal_tags_state WHERE profile_id='default'"),
      focus: this.number("SELECT revision FROM personal_focus_state WHERE profile_id='default'"),
      genres: this.number("SELECT value FROM music_genre_state WHERE key='revision'"), exploration: this.number('SELECT revision FROM music_exploration_state WHERE id=1')
    }
  }
  restored(id: string): boolean { return this.meta(`music_backup_restore:${id}`) !== null }
  result(): MusicPersonalBackupRestoreResult { return { revision: this.revision(), metadata: this.owner.metadata() } }
  assertRevision(revision: MusicPersonalBackupRevision) { if (!validMusicPersonalBackupRevision(revision) || !same(this.revision(), revision)) throw stale() }
  private read<T>(action: () => T): T {
    if (this.sql.isTransaction) return action()
    this.sql.exec('BEGIN')
    try { const result = action(); this.sql.exec('COMMIT'); return result }
    catch (error) { if (this.sql.isTransaction) this.sql.exec('ROLLBACK'); throw error }
  }
  export(maxBytes: number): MusicPersonalBackupDocument {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MUSIC_BACKUP_MAX_BYTES) throw new Error('无效的音乐整理备份容量')
    const origin = this.origin(true)!
    return this.read(() => {
      const data: MusicPersonalBackupDocument = { version: 1, origin, dictionaryVersion: this.number("SELECT value FROM music_genre_state WHERE key='dictionary_version'"), records: emptyMusicBackupRecords() }
      let count = 0, bytes = Buffer.byteLength(JSON.stringify(data))
      const append = (name: MusicBackupRecordKind, row: MusicBackupRecord) => {
        const clean = { ...row }
        for (const field of ['payload', 'evidence', 'query', 'migration_receipt', 'bindings', 'base']) if (typeof clean[field] === 'string') clean[field] = encoded(JSON.parse(clean[field] as string))
        // music owns only the one system view, not ordinary playlists.
        if (name === 'favorites') {
          const playlists = JSON.parse(String(clean.payload)) as Playlist[]
          const selected = playlists.filter(p => p.id === row.default_id)
          for (const view of selected) {
            const snapshots = { ...view.trackSnapshots }
            view.trackIds = view.trackIds.map(id => {
              const saved = this.meta('music_backup_offline_favorite_id:' + id)
              if (!saved) return id
              const original = JSON.parse(saved) as { originalId: string; snapshot?: TrackData }
              delete snapshots[id]
              if (original.snapshot) snapshots[original.originalId] = original.snapshot
              return original.originalId
            })
            view.trackSnapshots = Object.keys(snapshots).length ? snapshots : undefined
          }
          clean.payload = encoded(selected)
        }
        bytes += Buffer.byteLength(JSON.stringify(clean)) + 1
        if (bytes > maxBytes || ++count > MUSIC_BACKUP_MAX_RECORDS) throw new Error('music 数据超过备份容量，未截断导出；请选择较少的备份域')
        data.records[name]!.push(clean)
      }
      for (const name of Object.keys(TABLES) as MusicBackupRecordKind[]) {
        if (LEGACY_RECORDS.has(name)) continue
        const table = TABLES[name]!, columns = MUSIC_BACKUP_RECORDS[name].filter(k => k !== 'event_id').join(',')
        for (const raw of this.sql.prepare(`SELECT ${columns} FROM ${table}${exportWhere(name)} ORDER BY rowid`).iterate()) {
          const row = raw as MusicBackupRecord
          if ('seq' in row) row.event_id = this.meta(`music_backup_event:${name}:${row.seq}`) ?? JSON.stringify([origin, name, row.seq])
          append(name, row)
        }
      }
      this.exportLegacy(data, append)
      for (const [kind, table] of Object.entries(HISTORY_TABLES)) append('historyWatermarks', { kind, seq: Number(this.sql.prepare('SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name=?),0) n').get(table)!.n) })
      // Offline source bindings remain portable without becoming catalog_sources or members.
      const offline = this.meta('music_backup_offline_sources')
      if (offline) {
        const existing = new Set(data.records.sources.map(r => str(r.source_key)))
        for (const row of JSON.parse(offline) as MusicBackupRecord[]) if (!existing.has(str(row.source_key))) append('sources', row)
      }
      for (const row of this.sql.prepare(`SELECT s.source_key,c.value AS added_at FROM catalog_state c JOIN catalog_sources s ON c.key='membership_added:'||s.id`).iterate()) append('membershipAdded', row as MusicBackupRecord)
      const membership = this.meta('music_backup_offline_membership')
      if (membership) {
        const existing = new Set(data.records.membershipAdded.map(r => str(r.source_key)))
        for (const row of JSON.parse(membership) as MusicBackupRecord[]) if (!existing.has(str(row.source_key))) append('membershipAdded', row)
      }
      // Restored legacy aliases may have no legacy content document (restricted text is excluded).
      if (!validateMusicPersonalBackup(data)) throw new Error('音乐整理数据引用不完整，未生成可恢复备份')
      return data
    })
  }
  /** User imports and explicit edits are portable; automatic provider prose is not. */
  private legacyAlbum(value: unknown, prior?: unknown, manual?: unknown, provenance?: 'manual' | 'provider' | 'excluded' | 'unverified' | null): Record<string, unknown> {
    const album = value && typeof value === 'object' ? value as Record<string, unknown> : {}, before = prior && typeof prior === 'object' ? prior as Record<string, unknown> : {}, edited = manual && typeof manual === 'object' ? manual as Record<string, unknown> : {}
    const result: Record<string, unknown> = {}
    for (const key of ['id', 'title', 'artist', 'year', 'folder', 'localNote']) if (key in album) result[key] = album[key]
    const source = album.descriptionSource as { method?: string } | undefined
    const explicitDescription = 'description' in edited && !same(edited.description, before.description) && same(edited.description, album.description)
    if (provenance === 'manual') {
      // Missing is an explicit manual clear. A retained provider badge is not
      // attribution for the user's replacement paragraph.
      result.description = album.description ?? null
    } else if (!provenance && 'description' in album && (!source || source.method === 'external-ai' || explicitDescription)) {
      result.description = album.description
      if (source) result.descriptionSource = source
    }
    if (Array.isArray(album.producers)) result.producers = album.producers.filter(p => p && typeof p === 'object' && ['manual', 'local'].includes(String((p as { source?: unknown }).source)))
    return result
  }
  private exportLegacy(data: MusicPersonalBackupDocument, append: (name: MusicBackupRecordKind, row: MusicBackupRecord) => void) {
    const provenance = new LegacyMusicProvenance(this.sql)
    for (const document of this.sql.prepare("SELECT plugin_id,source_revision,revision,input_revision FROM metadata_legacy_documents WHERE state='published' ORDER BY plugin_id").all()) {
      const plugin = str(document.plugin_id), history = this.sql.prepare('SELECT * FROM metadata_legacy_history WHERE plugin_id=? ORDER BY revision').all(plugin)
      const albums = this.sql.prepare('SELECT * FROM metadata_legacy_albums WHERE plugin_id=? ORDER BY legacy_id').all(plugin)
      const inputs = this.sql.prepare('SELECT * FROM metadata_legacy_inputs WHERE plugin_id=? ORDER BY legacy_id').all(plugin)
      const valueAt = (snapshot: Record<string, unknown> | undefined, id: string): unknown => snapshot ? (JSON.parse(str(snapshot.payload)) as { albums?: Record<string, unknown> }).albums?.[id] : undefined
      const current = new Map(albums.map(row => [str(row.legacy_id), JSON.parse(str(row.payload)) as unknown]))
      const pair = (id: string) => {
        const revision = Number(inputs.find(row => row.legacy_id === id)?.revision ?? 0)
        const previous = history.filter(row => Number(row.revision) < revision).at(-1)
        return { before: valueAt(previous, id), after: revision > 0 && previous ? valueAt(history.find(row => Number(row.revision) >= revision), id) ?? current.get(id) : undefined }
      }
      append('legacyDocuments', { ...document, base: '{"albums":{}}' } as MusicBackupRecord)
      for (const row of albums) {
        const id = str(row.legacy_id), manual = pair(id)
        append('legacyAlbums', { plugin_id: plugin, legacy_id: id, payload: encoded(this.legacyAlbum(current.get(id), manual.before, manual.after, provenance.disposition(plugin, id, -1, current.get(id)))), disposition: str(row.disposition) })
      }
      for (const row of inputs) append('legacyInputs', row as MusicBackupRecord)
      const bindings = this.sql.prepare('SELECT * FROM metadata_legacy_bindings WHERE plugin_id=? ORDER BY legacy_id,entity_id').all(plugin)
      for (const row of bindings) append('legacyBindings', row as MusicBackupRecord)
      for (const row of history) {
        const value = JSON.parse(str(row.payload)) as { albums?: Record<string, unknown> }, safeAlbums: Record<string, unknown> = {}
        for (const [id, album] of Object.entries(value.albums ?? {})) { const manual = pair(id); safeAlbums[id] = this.legacyAlbum(album, manual.before, manual.after, provenance.disposition(plugin, id, Number(row.revision), album)) }
        append('legacyHistory', { plugin_id: plugin, revision: Number(row.revision), payload: encoded({ albums: safeAlbums }), bindings: str(row.bindings),
          event_id: this.meta(`music_backup_legacy_event:${plugin}:${row.revision}`) ?? JSON.stringify([data.origin, 'legacyHistory', Number(row.revision)]) })
      }
    }
  }
  private restoreLegacy(records: MusicBackupRecords, policy: Merge, origin: string) {
    const provenance = new LegacyMusicProvenance(this.sql)
    for (const doc of records.legacyDocuments) {
      const plugin = str(doc.plugin_id), old = this.sql.prepare('SELECT * FROM metadata_legacy_documents WHERE plugin_id=?').get(plugin)
      if (old?.state === 'staging') throw new Error('旧资料迁移尚未发布，请先完成迁移再恢复音乐整理')
      const revision = Math.max(Number(old?.revision ?? 0), Number(doc.revision), ...records.legacyHistory.filter(row => row.plugin_id === plugin).map(row => Number(row.revision))) + 1
      this.sql.prepare(`INSERT INTO metadata_legacy_documents(plugin_id,state,source_revision,revision,expected,content_revision,base,input_revision) VALUES(?,'published',?,?,0,?,?,?)
        ON CONFLICT(plugin_id) DO UPDATE SET revision=excluded.revision,input_revision=excluded.input_revision`)
        .run(plugin, Number(doc.source_revision), revision, this.revision().library, str(doc.base), revision)
      // Explicitly deleted original IDs remain tombstones; restoring a deletion is not an empty automatic cache.
      for (const input of records.legacyInputs.filter(row => row.plugin_id === plugin)) {
        const local = this.sql.prepare('SELECT revision FROM metadata_legacy_inputs WHERE plugin_id=? AND legacy_id=?').get(plugin, input.legacy_id)
        if (local && policy === 'keep-local') continue
        this.sql.prepare('INSERT INTO metadata_legacy_inputs VALUES(?,?,?) ON CONFLICT(plugin_id,legacy_id) DO UPDATE SET revision=excluded.revision').run(plugin, input.legacy_id, revision)
        if (!records.legacyAlbums.some(row => row.plugin_id === plugin && row.legacy_id === input.legacy_id)) this.sql.prepare('DELETE FROM metadata_legacy_albums WHERE plugin_id=? AND legacy_id=?').run(plugin, input.legacy_id)
      }
      for (const album of records.legacyAlbums.filter(row => row.plugin_id === plugin)) {
        const local = this.sql.prepare('SELECT payload FROM metadata_legacy_albums WHERE plugin_id=? AND legacy_id=?').get(plugin, album.legacy_id)
        const value = JSON.parse(str(album.payload)) as Record<string, unknown>, previous = local ? JSON.parse(str(local.payload)) as Record<string, unknown> : {}
        // Merge individual exported fields; excluded provider fields keep their current independent authority.
        const next = policy === 'keep-local' ? { ...value, ...previous } : { ...previous, ...value }
        this.sql.prepare(`INSERT INTO metadata_legacy_albums VALUES(?,?,?,?) ON CONFLICT(plugin_id,legacy_id) DO UPDATE SET payload=excluded.payload`)
          .run(plugin, album.legacy_id, encoded(next), album.disposition)
        if ('description' in value && (policy === 'use-backup' || !('description' in previous))) provenance.portable(plugin, str(album.legacy_id), -1, next)
      }
      for (const binding of records.legacyBindings.filter(row => row.plugin_id === plugin)) {
        const exists = this.sql.prepare('SELECT 1 FROM metadata_legacy_albums WHERE plugin_id=? AND legacy_id=?').get(plugin, binding.legacy_id)
        if (exists) this.put('legacyBindings', binding, policy)
      }
      for (const row of records.legacyHistory.filter(row => row.plugin_id === plugin)) {
        const key = `music_backup_legacy_seen:${JSON.stringify([plugin, row.event_id])}`
        if (this.meta(key)) continue
        const event = JSON.parse(str(row.event_id)) as [string, string, number]
        const local = this.sql.prepare('SELECT * FROM metadata_legacy_history WHERE plugin_id=? AND revision=?').get(plugin, row.revision)
        if (event[0] === this.origin() && local && same(local.payload, row.payload) && same(local.bindings, row.bindings)) { this.setMeta(key, row.revision); continue }
        const seq = local ? Number(this.sql.prepare('SELECT coalesce(max(revision),0)+1 n FROM metadata_legacy_history WHERE plugin_id=?').get(plugin)!.n) : Number(row.revision)
        this.sql.prepare('INSERT INTO metadata_legacy_history VALUES(?,?,?,?)').run(plugin, seq, row.payload, row.bindings)
        const saved = JSON.parse(str(row.payload)) as { albums?: Record<string, unknown> }
        for (const [id, album] of Object.entries(saved.albums ?? {})) provenance.portable(plugin, id, seq, album)
        this.setMeta(key, seq); this.setMeta(`music_backup_legacy_event:${plugin}:${seq}`, row.event_id)
      }
      this.sql.prepare('UPDATE metadata_legacy_documents SET expected=(SELECT count(*) FROM metadata_legacy_albums WHERE plugin_id=?) WHERE plugin_id=?').run(plugin, plugin)
      this.setMeta(this.mappingKey(origin, 'legacy-document', plugin), plugin)
    }
    // Compare the final merged documents, including retained local IDs and
    // explicit manual clears, before publishing this restore transaction.
    if (records.legacyDocuments.length) refreshLegacyMusicDispositions(this.sql)
  }
  private mappingKey(origin: string, type: string, id: string) { return `music_backup_mapping:${JSON.stringify([origin, type, id])}` }
  private mappedId(origin: string, type: string, id: string, index: number): string {
    return this.meta(this.mappingKey(origin, type, id)) ?? (origin === this.origin() ? id : `backup_${origin}_${type}_${index}`)
  }
  private plan(data: MusicPersonalBackupDocument): Plan {
    const r = data.records, plan: Plan = { entities: new Map(), identities: new Map(), sources: new Map(), mappings: [], errors: 0, conflicts: [] }
    const aliases = grouped(r.sourceAliases, 'entity_id'), identityRefs = grouped(r.identityRefs, 'target_id'), explorationRefs = grouped(r.explorationRefs, 'entity_id')
    for (const row of r.sources) {
      const source = this.sql.prepare('SELECT id,recording_id,release_id FROM catalog_sources WHERE source_key=? AND provider=?').get(row.source_key, row.provider)
      if (!source) continue
      plan.sources.set(str(row.id), str(source.id))
      for (const key of ['recording_id', 'release_id']) if (row[key] !== null && source[key] !== null) {
        const id = str(row[key]), target = str(source[key])
        if (plan.entities.has(id) && plan.entities.get(id) !== target) plan.errors++
        plan.entities.set(id, target)
      }
    }
    for (const [index, row] of r.identities.entries()) {
      const incomingId = str(row.id), found = new Set<string>()
      const prior = this.meta(this.mappingKey(data.origin, 'identity', incomingId))
      if (prior && this.sql.prepare('SELECT 1 FROM metadata_entities WHERE id=?').get(prior)) found.add(prior)
      if (data.origin === this.origin() && this.sql.prepare('SELECT 1 FROM metadata_entities WHERE id=? AND kind=?').get(incomingId, row.kind)) found.add(incomingId)
      for (const ref of identityRefs.get(incomingId) ?? []) {
        const existing = this.sql.prepare('SELECT target_id FROM metadata_identity_refs WHERE provider=? AND kind=? AND id_type=? AND value=?').get(ref.provider, ref.kind, ref.id_type, ref.value)
        if (existing) found.add(str(existing.target_id))
      }
      if (found.size > 1) { plan.errors++; plan.conflicts.push({ incomingId, kind: str(row.kind), title: str(row.name), targetIds: [...found].slice(0, 16) }) }
      const targetId = [...found][0] ?? this.mappedId(data.origin, 'identity', incomingId, index)
      // Creation provenance is not lookup authority (refs are). Still surface
      // its storage uniqueness conflict before staging instead of late SQL failure.
      const provenance = this.sql.prepare('SELECT id FROM metadata_entities WHERE provider=? AND kind=? AND external_id=?').get(row.provider, row.kind, row.external_id)
      if (provenance && provenance.id !== targetId && !this.sql.prepare('SELECT 1 FROM metadata_entities WHERE id=?').get(targetId)) { plan.errors++; plan.conflicts.push({ incomingId, kind: str(row.kind), title: str(row.name), targetIds: [str(provenance.id)] }) }
      plan.identities.set(incomingId, targetId)
      plan.mappings.push({ kind: 'identity', incomingId, targetId, method: prior ? 'previous-import' : found.has(incomingId) && data.origin === this.origin() ? 'same-origin' : found.size ? 'external-reference' : 'offline-anchor' })
    }
    for (const [index, row] of r.entities.entries()) {
      const incomingId = str(row.id), found = new Set<string>(), source = plan.entities.get(incomingId)
      if (source) found.add(source)
      for (const alias of aliases.get(incomingId) ?? []) {
        const existing = this.sql.prepare('SELECT entity_id FROM catalog_aliases WHERE namespace=? AND key=?').get(alias.namespace, this.aliasKey(alias, plan.entities))
        if (existing) found.add(str(existing.entity_id))
      }
      const prior = this.meta(this.mappingKey(data.origin, 'entity', incomingId))
      if (prior && this.sql.prepare('SELECT 1 FROM catalog_entities WHERE id=?').get(prior)) found.add(prior)
      if (data.origin === this.origin() && this.sql.prepare('SELECT 1 FROM catalog_entities WHERE id=? AND kind=?').get(incomingId, row.kind)) found.add(incomingId)
      for (const ref of explorationRefs.get(incomingId) ?? []) {
        const existing = this.sql.prepare('SELECT entity_id FROM music_exploration_refs WHERE provider=? AND kind=? AND id_type=? AND value=?').get(ref.provider, ref.kind, ref.id_type, ref.value)
        if (existing) found.add(str(existing.entity_id))
      }
      if (found.size > 1) { plan.errors++; plan.conflicts.push({ incomingId, kind: str(row.kind), title: str(row.title), targetIds: [...found].slice(0, 16) }) }
      const targetId = [...found][0] ?? this.mappedId(data.origin, 'entity', incomingId, index)
      plan.entities.set(incomingId, targetId)
      plan.mappings.push({ kind: 'entity', incomingId, targetId, method: prior ? 'previous-import' : found.has(incomingId) && data.origin === this.origin() ? 'same-origin' : source ? 'source' : found.size ? 'external-reference' : 'offline-anchor' })
      const existing = this.sql.prepare('SELECT kind,identity FROM catalog_entities WHERE id=?').get(targetId)
      if (existing && (existing.kind !== row.kind || existing.identity !== row.identity)) plan.errors++
    }
    for (const [name, table] of [['tags', 'personal_tags'], ['focus', 'personal_focus_queries']] as const) for (const row of r[name]) {
      const existing = this.sql.prepare(`SELECT id FROM ${table} WHERE profile_id='default' AND normalized_name=? AND id<>?`).get(row.normalized_name, row.id)
      if (existing) { plan.errors++; plan.conflicts.push({ incomingId: str(row.id), kind: name === 'tags' ? 'tag' : 'focus', title: str(row.name), targetIds: [str(existing.id)] }) }
    }
    return plan
  }
  private genreConflicts(records: MusicBackupRecords, policy: Merge): MusicPersonalBackupPreview['referenceConflicts'] {
    const rows = this.sql.prepare('SELECT * FROM music_genres').all(), local = new Map(rows.map(row => [str(row.id), row]))
    const hierarchy = new Map(rows.map(row => [str(row.id), row.parent_id === null ? null : str(row.parent_id)]))
    for (const row of records.genres) if (!local.has(str(row.id)) || (policy === 'use-backup' && row.user_modified === 1)) hierarchy.set(str(row.id), row.parent_id === null ? null : str(row.parent_id))
    // Dictionary node IDs are stable identities, not localized names. Keep this
    // installation's unmodified definitions; restore only user edits/new nodes.
    // Alias normalization is a separate wire contract: a future algorithm must
    // not become a silently ineffective or incorrectly matching local mapping.
    const conflicts: MusicPersonalBackupPreview['referenceConflicts'] = records.genreAliases
      .filter(row => row.normalization_version !== 1)
      .map(row => ({ incomingId: str(row.normalized), kind: 'genre-alias', title: str(row.value), targetIds: [] })), checked = new Set<string>()
    const names = new Map(records.genres.map(row => [str(row.id), str(row.name)]))
    for (const row of rows) if (!names.has(str(row.id))) names.set(str(row.id), str(row.name))
    for (const id of hierarchy.keys()) {
      const seen = new Set<string>(); let next: string | null | undefined = id
      while (next && !checked.has(next)) {
        if (seen.has(next)) {
          conflicts.push({ incomingId: next, kind: 'genre', title: names.get(next) ?? next, targetIds: [...seen].slice(0, 16) }); break
        }
        seen.add(next); next = hierarchy.get(next)
      }
      for (const visited of seen) checked.add(visited)
    }
    return conflicts
  }
  /** Same logical-record inventory as export, without materializing its payloads. */
  private recordCount(): number {
    let count = Object.entries(TABLES).reduce((n, [name, table]) => n + this.number(`SELECT count(*) FROM ${table}${exportWhere(name as MusicBackupRecordKind)}`), Object.keys(HISTORY_TABLES).length)
    count += this.number("SELECT count(*) FROM catalog_state c JOIN catalog_sources s ON c.key='membership_added:'||s.id")
    count += this.number(`SELECT count(*) FROM json_each((SELECT json_extract(value,'$') FROM meta WHERE key='music_backup_offline_sources')) j
      WHERE NOT EXISTS(SELECT 1 FROM catalog_sources s WHERE s.source_key=json_extract(j.value,'$.source_key'))`)
    count += this.number(`SELECT count(*) FROM json_each((SELECT json_extract(value,'$') FROM meta WHERE key='music_backup_offline_membership')) j
      WHERE NOT EXISTS(SELECT 1 FROM catalog_state c JOIN catalog_sources s ON c.key='membership_added:'||s.id WHERE s.source_key=json_extract(j.value,'$.source_key'))`)
    return count
  }
  preview(data?: MusicPersonalBackupDocument, conflict: Merge = 'use-backup'): MusicPersonalBackupPreview {
    if (data !== undefined && !validateMusicPersonalBackup(data)) throw invalid()
    if (!['keep-local', 'use-backup'].includes(conflict)) throw invalid()
    return this.read(() => {
      const current = this.recordCount()
      if (!data) return { incoming: 0, current, conflicts: 0, missingSources: 0, mappedEntities: 0, unbound: 0, referenceMapping: 0, dependencies: [], revision: this.revision(), mappings: [], mappingCount: 0, mappingsTruncated: false, referenceConflicts: [] }
      const plan = this.plan(data), rows = this.remap(data, plan), conflicts = this.conflicts(rows), genreConflicts = this.genreConflicts(rows, conflict)
      plan.errors += genreConflicts.length; plan.conflicts.push(...genreConflicts)
      const missingSources = data.records.sources.length - plan.sources.size
      return { incoming: Object.values(data.records).reduce((n, rows) => n + rows.length, 0), current, conflicts: conflicts + plan.errors,
        missingSources, mappedEntities: plan.mappings.filter(x => x.method !== 'offline-anchor').length,
        unbound: plan.mappings.filter(x => x.method === 'offline-anchor').length,
        referenceMapping: plan.mappings.filter(x => x.method === 'external-reference').length,
        dependencies: [...(missingSources ? ['library:missing-sources'] : []), ...(plan.errors ? ['music:identity-reference-conflict'] : []), ...(data.records.genres.some(g => str(g.id).startsWith('genre:')) ? ['genres:dictionary'] : []),
          ...(data.dictionaryVersion !== this.number("SELECT value FROM music_genre_state WHERE key='dictionary_version'") ? ['genres:cross-dictionary'] : [])],
        revision: this.revision(), mappings: plan.mappings.slice(0, 100), mappingCount: plan.mappings.length, mappingsTruncated: plan.mappings.length > 100, referenceConflicts: plan.conflicts.slice(0, 100) }
    })
  }
  private remap(data: MusicPersonalBackupDocument, plan: Plan): CompleteMusicBackupRecords {
    const records = { ...emptyMusicBackupRecords(), ...structuredClone(data.records) }, map = (value: unknown, mapping: Map<string, string>) => value === null ? null : mapping.get(str(value)) ?? value
    const keys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(keys)
      if (!value || typeof value !== 'object') return value
      return Object.fromEntries(Object.entries(value).map(([key, val]) => [key,
        ['entityId', 'entity_id', 'recordingId', 'releaseId', 'workId'].includes(key) ? map(val, plan.entities) : key === 'targetId' ? map(val, plan.identities) : key === 'sourceId' ? map(val, plan.sources) : key === 'sourceIds' && Array.isArray(val) ? val.map(v => map(v, plan.sources)) : key === 'targetKey' ? target(str(val)) : key === 'inputVersion' && typeof val === 'string' ? inputVersion(val) : keys(val)]))
    }
    const inputVersion = (value: string): string => {
      try { const input = JSON.parse(value) as unknown[]; if (Array.isArray(input) && input.length === 5 && Array.isArray(input[4])) input[4] = input[4].map(v => map(v, plan.sources)); return JSON.stringify(input) } catch { return value }
    }
    const target = (value: string) => {
      const key = JSON.parse(value) as string[]
      key[2] = str(map(key[2], key[0] === 'identity' ? plan.identities : plan.entities)); return JSON.stringify(key)
    }
    const linkMap = new Map<string, string>()
    const tagMap = new Map(records.tags.map(row => [str(row.id), str(row.id)]))
    const focusMap = new Map(records.focus.map(row => [str(row.id), str(row.id)]))
    for (const [index, row] of records.links.entries()) {
      const entity = map(row.entity_id, plan.entities), old = this.sql.prepare('SELECT id FROM metadata_identity_links WHERE entity_id=? AND kind=?').get(entity as SQLInputValue, row.kind)
      linkMap.set(str(row.id), old ? str(old.id) : this.mappedId(data.origin, 'link', str(row.id), index))
    }
    for (const [name, rows] of Object.entries(records) as Array<[MusicBackupRecordKind, MusicBackupRecord[]]>) for (const row of rows) {
      if (name === 'entities') row.id = map(row.id, plan.entities) as string
      if (name === 'identities') row.id = map(row.id, plan.identities) as string
      if (name === 'subjects') row.id = map(row.id, plan.entities) as string
      if (name === 'sourceAliases') row.key = this.aliasKey(row, plan.entities)
      if (name === 'tags') row.id = tagMap.get(str(row.id))!
      if (name === 'tagMembers') row.tag_id = tagMap.get(str(row.tag_id))!
      if (name === 'focus') {
        row.id = focusMap.get(str(row.id))!
        const query = JSON.parse(str(row.query)) as Record<string, unknown>
        const tags = (node: unknown): unknown => {
          if (Array.isArray(node)) return node.map(tags)
          if (!node || typeof node !== 'object') return node
          return Object.fromEntries(Object.entries(node).map(([key, val]) => [key, key === 'tag' && val && typeof val === 'object' ? { id: map((val as { id: string }).id, tagMap) } : tags(val)]))
        }
        row.query = JSON.stringify(tags(query))
      }
      for (const k of ['entity_id', 'recording_id', 'release_id', 'owner_id', 'from_id', 'to_id']) if (k in row) row[k] = map(row[k], plan.entities) as MusicBackupRecord[string]
      if ('target_id' in row && name !== 'genreOverrides' && name !== 'genreImportOverrides') row.target_id = map(row.target_id, plan.identities) as MusicBackupRecord[string]
      if ('target_key' in row) row.target_key = target(str(row.target_key))
      if (name === 'links') row.id = linkMap.get(str(row.id))!
      if (name === 'identityHistory') row.link_id = linkMap.get(str(row.link_id))!
      if (['identityHistory', 'linkHistory', 'favorites'].includes(name)) for (const field of ['evidence', 'migration_receipt']) if (typeof row[field] === 'string') row[field] = JSON.stringify(keys(JSON.parse(str(row[field]))))
      if (name === 'legacyHistory') row.bindings = JSON.stringify(keys(JSON.parse(str(row.bindings))))
      if (name === 'membershipAdded') { /* keyed by source identity, never internal source UUID */ }
      if (name === 'genreOverrides' || name === 'genreImportOverrides') {
        if (row.target_kind === 'source') row.target_id = map(row.target_id, plan.sources) as string
      }
    }
    const sets = new Map<string, string>()
    records.performances.forEach((row, index) => { const old = str(row.id); row.id = this.mappedId(data.origin, 'performance-set', old, index); sets.set(old, str(row.id)) })
    records.performanceRelations.forEach((row, index) => { row.set_id = sets.get(str(row.set_id))!; row.id = this.mappedId(data.origin, 'performance-relation', str(row.id), index) })
    return records
  }
  private aliasKey(row: MusicBackupRecord, entities: Map<string, string>): string {
    if (row.namespace !== 'source.artist') return str(row.key)
    const key = JSON.parse(str(row.key)) as unknown[]
    if ((key.length === 3 || (key.length === 4 && key[2] === 'name')) &&
      typeof key[1] === 'string' && entities.has(key[1])) key[1] = entities.get(key[1])!
    return JSON.stringify(key)
  }
  private existing(name: MusicBackupRecordKind, row: MusicBackupRecord): MusicBackupRecord | undefined {
    const pk = PK[name]!, args = pk.map(k => row[k])
    return this.sql.prepare(`SELECT ${MUSIC_BACKUP_RECORDS[name].join(',')} FROM ${TABLES[name]} WHERE ${pk.map(k => `${k}=?`).join(' AND ')}`).get(...args) as MusicBackupRecord | undefined
  }
  private conflicts(records: MusicBackupRecords): number {
    let result = 0
    for (const name of ['links', 'overrides', 'sourcePreferences', 'artworkOverrides', 'ratings', 'preferences', 'tags', 'focus', 'genres', 'genreAliases', 'genreOverrides', 'favorites', 'performances'] as MusicBackupRecordKind[]) for (const row of records[name] ?? []) {
      const old = this.existing(name, row)
      if (old && MUSIC_BACKUP_RECORDS[name].some(k => !['revision', 'name_revision', 'members_revision', 'query_revision', 'updated_at', 'saved_at', 'migration_receipt', 'legacy_revision', 'id'].includes(k) && !same(old[k], row[k]))) result++
    }
    return result
  }
  private put(name: MusicBackupRecordKind, row: MusicBackupRecord, policy: Merge, force = false): void {
    const old = this.existing(name, row)
    if (old && policy === 'keep-local' && !force) return
    const next = { ...row }
    for (const k of ['revision', 'name_revision', 'members_revision', 'query_revision']) if (k in next) next[k] = Math.max(Number(old?.[k] ?? 0), Number(next[k])) + (old ? 1 : 0)
    const columns = MUSIC_BACKUP_RECORDS[name], pk = PK[name]!, update = columns.filter(k => !pk.includes(k))
    this.sql.prepare(`INSERT INTO ${TABLES[name]}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')}) ON CONFLICT(${pk.join(',')}) ${update.length ? `DO UPDATE SET ${update.map(k => `${k}=excluded.${k}`).join(',')}` : 'DO NOTHING'}`)
      .run(...columns.map(k => next[k]))
  }
  private history(name: 'ratingHistory' | 'preferenceHistory' | 'identityHistory' | 'linkHistory', rows: MusicBackupRecord[]) {
    const mapping = new Map<number, number>(), inserted = new Set<number>()
    for (const row of rows) {
      const key = `music_backup_event_seen:${row.event_id}`
      const seen = this.meta(key)
      if (seen) { mapping.set(Number(row.seq), Number(seen)); continue }
      const columns = MUSIC_BACKUP_RECORDS[name].filter(k => k !== 'seq' && k !== 'event_id')
      const event = JSON.parse(str(row.event_id)) as [string, string, number]
      if (event[0] === this.origin() && event[1] === name) {
        const old = this.sql.prepare(`SELECT * FROM ${TABLES[name]} WHERE seq=?`).get(event[2])
        if (old && columns.filter(k => k !== 'evidence').every(k => same(old[k], row[k]))) { this.setMeta(key, str(event[2])); mapping.set(Number(row.seq), event[2]); continue }
      }
      const result = this.sql.prepare(`INSERT INTO ${TABLES[name]}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(k => row[k]))
      const seq = Number(result.lastInsertRowid); mapping.set(Number(row.seq), seq); inserted.add(seq)
      this.setMeta(key, String(seq))
      this.setMeta(`music_backup_event:${name}:${result.lastInsertRowid}`, row.event_id)
    }
    return { mapping, inserted }
  }
  /** Seq numbers are database-local; historical receipts refer to identity events. */
  private historyReferences(name: 'identityHistory' | 'linkHistory', rows: MusicBackupRecord[], state: ReturnType<LibraryDatabasePersonalMusic['history']>, identity: Map<number, number>) {
    for (const row of rows) {
      const seq = state.mapping.get(Number(row.seq))!
      if (!state.inserted.has(seq)) continue
      const value = JSON.parse(str(row.evidence)) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const audit = value as { decision?: { restoredFrom?: number }; evidence?: { verification?: { method?: string; parent?: { historySeq: number } } } }
      if (audit.decision?.restoredFrom !== undefined) audit.decision.restoredFrom = identity.get(audit.decision.restoredFrom) ?? 0
      const proof = audit.evidence?.verification
      if (proof?.method === 'album_member' && proof.parent) proof.parent.historySeq = identity.get(proof.parent.historySeq) ?? 0
      // Missing legacy parent events stay non-restorable, rather than accidentally
      // naming an unrelated event that happens to have the old sequence number.
      this.sql.prepare(`UPDATE ${TABLES[name]} SET evidence=? WHERE seq=?`).run(encoded(audit), seq)
    }
  }
  private favoriteView(row: MusicBackupRecord, policy: Merge, now: number) {
    const old = this.sql.prepare('SELECT * FROM personal_preference_playlists WHERE id=1').get()
    const incoming = (JSON.parse(str(row.payload)) as Playlist[]).find(p => p.id === row.default_id)
    if (!incoming) throw invalid()
    const playlists = old ? JSON.parse(str(old.payload)) as Playlist[] : []
    const index = playlists.findIndex(p => p.id === old?.default_id)
    const current = index >= 0 ? playlists[index] : null
    let next = incoming
    if (current) next = policy === 'keep-local' ? current : { ...incoming, id: current.id }
    // Snapshot ordering is recoverable even when no source is presently authorized.
    if (index >= 0) playlists[index] = next
    else playlists.unshift(next)
    this.sql.prepare(`INSERT INTO personal_preference_playlists VALUES(1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      revision=excluded.revision,saved_at=excluded.saved_at,payload=excluded.payload,default_id=excluded.default_id,migration_receipt=excluded.migration_receipt`)
      .run(Math.max(Number(old?.revision ?? 0), Number(row.revision)) + 1, new Date(now).toISOString(), encoded(playlists), Number(old?.legacy_revision ?? row.legacy_revision), next.id,
        old && policy === 'keep-local' ? str(old.migration_receipt) : str(row.migration_receipt))
  }
  private prepareFavoriteView(row: MusicBackupRecord, data: MusicPersonalBackupDocument): MusicBackupRecord {
    const views = JSON.parse(str(row.payload)) as Playlist[], view = views[0], snapshots: Record<string, TrackData> = {}, ids: string[] = []
    const receipt = JSON.parse(str(row.migration_receipt)) as { items?: Array<{ trackId: string; sourceId?: string }> }
    const byKey = new Map(data.records.sources.map(row => [str(row.source_key), row])), byId = new Map(data.records.sources.map(row => [str(row.id), row])), byTrack = grouped(data.records.sources, 'track_id'), receiptItems = new Map(receipt.items?.map(item => [item.trackId, item]))
    for (const originalId of view.trackIds) {
      const snapshot = view.trackSnapshots?.[originalId]
      const matchingTracks = byTrack.get(originalId), exact = snapshot ? byKey.get(versionSourceKey(snapshot)) : byId.get(receiptItems.get(originalId)?.sourceId ?? '') ?? (matchingTracks?.length === 1 ? matchingTracks[0] : undefined)
      const source = exact ? this.sql.prepare(`SELECT s.*,t.payload AS local_payload FROM catalog_sources s
        LEFT JOIN tracks t ON s.provider='local' AND t.id=s.track_id WHERE source_key=? AND availability<>'missing'
        AND EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)
        AND (s.provider<>'local' OR (t.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM catalog_pending p WHERE p.track_id=s.track_id)))`).get(exact.source_key) : undefined
      const track = source ? source.provider === 'local'
        ? libraryTrack(JSON.parse(str(source.local_payload))) : JSON.parse(str(source.payload)) as TrackData : undefined
      const existing = track ? snapshots[track.id] : undefined
      if (track && (!existing || versionSourceKey(existing) === versionSourceKey(track))) {
        // The system view retains migrated occurrences, not just distinct favorites.
        ids.push(track.id); snapshots[track.id] = track
      } else {
        const id = `offline_favorite_${randomUUID()}`
        ids.push(id)
        snapshots[id] = { id, source: 'local', filePath: '', title: snapshot?.title ?? originalId, artist: snapshot?.artist ?? '', album: snapshot?.album ?? '', duration: snapshot?.duration ?? 0 } as TrackData
        const retained = { id, originalId, snapshot }
        this.setMeta('music_backup_offline_favorite_id:' + id, encoded(retained))
        if (exact) {
          const key = 'music_backup_offline_favorites:' + exact.source_key, old = JSON.parse(this.meta(key) ?? '[]') as Array<typeof retained>
          if (!old.some(row => row.id === id)) old.push(retained)
          this.setMeta(key, encoded(old))
        }
      }
    }
    view.trackIds = ids; view.trackSnapshots = Object.keys(snapshots).length ? snapshots : undefined
    return { ...row, payload: encoded(views) }
  }
  private playlists(incoming: Playlist[], conflict: Merge, now: number) {
    if (incoming.some(p => p.isDefault && (p.trackIds.length || p.trackSnapshots))) throw new Error('v2 歌单不能包含第二份收藏成员')
    let row = this.sql.prepare('SELECT * FROM personal_preference_playlists WHERE id=1').get()
    if (!row) {
      const view = incoming.find(p => p.isDefault) ?? { id: `favorites_${randomUUID()}`, name: '我喜欢的音乐', isDefault: true, trackIds: [], createdAt: new Date(now).toISOString() }
      this.favoriteView({ id: 1, revision: 0, saved_at: new Date(now).toISOString(), payload: encoded([view]), default_id: view.id, legacy_revision: 0,
        migration_receipt: encoded({ sourceRevision: 0, defaultPlaylistId: view.id, migratedAt: now, rawRowCount: 0, logicalMemberCount: 0, resolvedRowCount: 0, unresolvedRowCount: 0, items: [] }) }, 'keep-local', now)
      row = this.sql.prepare('SELECT * FROM personal_preference_playlists WHERE id=1').get()!
    }
    const data = JSON.parse(str(row.payload)) as Playlist[], system = data.find(p => p.id === row!.default_id)!
    const ordinary = mergePersonalDomain('playlists', data.filter(p => !p.isDefault), incoming.filter(p => !p.isDefault), conflict) as Playlist[]
    this.sql.prepare('UPDATE personal_preference_playlists SET payload=?,revision=revision+1,saved_at=? WHERE id=1').run(encoded([system, ...ordinary]), new Date(now).toISOString())
  }
  apply(bundle: MusicPersonalBackupRestoreBundle, library: () => void): MusicPersonalBackupRestoreResult {
    if (this.restored(bundle.restoreId)) return this.result()
    this.assertRevision(bundle.expectedRevision)
    if (!['keep-local', 'use-backup'].includes(bundle.conflict) || !/^[a-zA-Z0-9-]{1,128}$/.test(bundle.restoreId) || (bundle.music && !validateMusicPersonalBackup(bundle.music))) throw invalid()
    if (bundle.playlistsExpectedRevision !== undefined && bundle.playlistsExpectedRevision !== this.revision().playlists) throw stale()
    const now = bundle.now ?? Date.now(), policy = bundle.conflict
    if (!Number.isSafeInteger(now) || now < 0) throw invalid()
    library()
    const data = bundle.music
    if (data) {
      const plan = this.plan(data)
      if (plan.errors) throw Object.assign(new Error('备份关联或整理对象存在冲突，请先按预览处理'), { code: 'IDENTITY_CONFLICT' })
      const r = this.remap(data, plan)
      if (this.genreConflicts(r, policy).length) throw Object.assign(new Error('流派层级形成循环或别名标准化版本不兼容，请先按预览处理'), { code: 'IDENTITY_CONFLICT' })
      const suppressions = grouped(r.suppressions, 'entity_id'), tagMembers = grouped(r.tagMembers, 'tag_id'), performanceRelations = grouped(r.performanceRelations, 'set_id')
      for (const mapping of plan.mappings) this.setMeta(this.mappingKey(data.origin, mapping.kind, mapping.incomingId), mapping.targetId)
      for (const row of r.entities) this.put('entities', row, row.identity === 'manual' ? policy : 'keep-local')
      for (const row of r.sourceAliases) this.put('sourceAliases', row, 'keep-local')
      for (const row of r.identities) this.put('identities', row, 'keep-local')
      for (const name of ['identityRefs', 'explorationRefs'] as const) for (const row of r[name]) this.put(name, row, 'keep-local')
      // Links precede personal target values: identity conflicts are resolved before selecting a field's value.
      for (const row of r.subjects) this.put('subjects', row, policy)
      for (const row of r.links) {
        const selected = !this.existing('links', row) || policy === 'use-backup'
        this.put('links', row, policy)
        if (selected) {
          this.sql.prepare('DELETE FROM metadata_identity_suppressions WHERE entity_id=? AND kind=?').run(row.entity_id, row.kind)
          for (const suppression of (suppressions.get(str(row.entity_id)) ?? []).filter(s => s.kind === row.kind)) this.put('suppressions', suppression, 'use-backup')
        }
      }
      for (const name of ['overrides', 'sourcePreferences', 'artworkOverrides'] as const) for (const row of r[name]) {
        this.sql.prepare('INSERT OR IGNORE INTO metadata_subjects(id) VALUES(?)').run(row.entity_id)
        this.put(name, row, policy)
      }
      for (const name of ['ratings', 'preferences'] as const) for (const row of r[name]) this.put(name, row, policy)
      for (const name of ['ratingHistory', 'preferenceHistory'] as const) this.history(name, r[name])
      const identityHistory = this.history('identityHistory', r.identityHistory), linkHistory = this.history('linkHistory', r.linkHistory)
      this.historyReferences('identityHistory', r.identityHistory, identityHistory, identityHistory.mapping)
      this.historyReferences('linkHistory', r.linkHistory, linkHistory, identityHistory.mapping)
      for (const row of r.historyWatermarks) {
        const table = HISTORY_TABLES[row.kind as keyof typeof HISTORY_TABLES], old = this.sql.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(table)
        if (old) this.sql.prepare('UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name=?').run(row.seq, table)
        else this.sql.prepare('INSERT INTO sqlite_sequence VALUES(?,?)').run(table, row.seq)
      }
      for (const row of r.favorites) this.favoriteView(this.prepareFavoriteView(row, { ...data, records: { ...data.records, sources: r.sources } }), policy, now)
      for (const row of r.preferenceRestores) this.put('preferenceRestores', row, 'keep-local')
      for (const row of r.tags) {
        const exists = this.existing('tags', row), sameName = this.sql.prepare("SELECT id FROM personal_tags WHERE profile_id='default' AND normalized_name=?").get(row.normalized_name)
        if (sameName && sameName.id !== row.id) throw new Error('备份标签名称与另一本地标签冲突，请先重命名标签')
        this.put('tags', row, policy)
        if (!exists || policy === 'use-backup') {
          this.sql.prepare("DELETE FROM personal_tag_members WHERE profile_id='default' AND tag_id=?").run(row.id)
          for (const member of tagMembers.get(str(row.id)) ?? []) this.put('tagMembers', member, 'use-backup')
        }
      }
      data.records.tags.forEach((row, index) => this.setMeta(this.mappingKey(data.origin, 'tag', str(row.id)), str(r.tags[index].id)))
      data.records.focus.forEach((row, index) => this.setMeta(this.mappingKey(data.origin, 'focus', str(row.id)), str(r.focus[index].id)))
      for (const row of r.focus) {
        const sameName = this.sql.prepare("SELECT id FROM personal_focus_queries WHERE profile_id='default' AND normalized_name=?").get(row.normalized_name)
        if (sameName && sameName.id !== row.id) throw new Error('备份 Focus 名称与另一本地集合冲突，请先重命名集合')
        this.put('focus', row, policy)
      }
      // Insert nodes without parents, then apply the already-validated hierarchy.
      const chosen = r.genres.filter(row => !this.existing('genres', row) || (policy === 'use-backup' && Number(row.user_modified) === 1))
      for (const row of chosen) this.put('genres', { ...row, parent_id: null }, 'use-backup')
      for (const row of chosen) this.sql.prepare('UPDATE music_genres SET parent_id=? WHERE id=?').run(row.parent_id, row.id)
      const hierarchy = new Map(this.sql.prepare('SELECT id,parent_id FROM music_genres').all().map(row => [str(row.id), row.parent_id === null ? null : str(row.parent_id)]))
      const checked = new Set<string>()
      for (const id of hierarchy.keys()) { const seen = new Set<string>(); let next: string | null | undefined = id
        while (next && !checked.has(next)) { if (seen.has(next)) throw new Error('本机与备份合并后的流派层级形成循环，恢复已回滚'); seen.add(next); next = hierarchy.get(next) }
        for (const visited of seen) checked.add(visited)
      }
      for (const name of ['genreAliases', 'genreOverrides', 'genreImportOverrides', 'genreImportNodes', 'genreAliasBridges'] as const) for (const row of r[name]) this.put(name, row, name === 'genreAliases' && row.user_modified !== 1 ? 'keep-local' : policy)
      for (const row of r.performances) {
        const incomingSetId = row.id
        const old = this.existing('performances', row)
        if (old && policy === 'keep-local') continue
        if (old) row.id = old.id
        this.put('performances', row, policy)
        this.sql.prepare('DELETE FROM music_exploration_relations WHERE set_id=?').run(row.id)
        for (const rel of performanceRelations.get(str(incomingSetId)) ?? []) {
          rel.set_id = row.id
          const cols = MUSIC_BACKUP_RECORDS.performanceRelations
          this.sql.prepare(`INSERT INTO music_exploration_relations(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map(k => rel[k]))
        }
      }
      this.restoreLegacy(r, policy, data.origin)
      const offline = JSON.parse(this.meta('music_backup_offline_sources') ?? '[]') as MusicBackupRecord[]
      for (const row of r.sources) {
        const existing = offline.findIndex(x => x.source_key === row.source_key)
        if (existing < 0) offline.push(row); else if (policy === 'use-backup') offline[existing] = row
        if (existing < 0 || policy === 'use-backup') this.setMeta('music_backup_offline_source:' + row.source_key, row)
      }
      this.setMeta('music_backup_offline_sources', encoded(offline))
      const oldMembership = JSON.parse(this.meta('music_backup_offline_membership') ?? '[]') as MusicBackupRecord[]
      for (const row of r.membershipAdded) {
        const source = this.sql.prepare('SELECT id FROM catalog_sources WHERE source_key=?').get(row.source_key)
        if (source) {
          const key = 'membership_added:' + source.id, old = this.sql.prepare('SELECT value FROM catalog_state WHERE key=?').get(key)
          if (!old || policy === 'use-backup') this.sql.prepare('INSERT INTO catalog_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, row.added_at)
        }
        const index = oldMembership.findIndex(x => x.source_key === row.source_key)
        if (index < 0) oldMembership.push(row); else if (policy === 'use-backup') oldMembership[index] = row
        if (index < 0 || policy === 'use-backup') this.setMeta('music_backup_offline_membership:' + row.source_key, row)
      }
      this.setMeta('music_backup_offline_membership', encoded(oldMembership))
      this.sql.exec(`UPDATE personal_ratings_state SET revision=revision+1; UPDATE personal_preferences_state SET revision=revision+1;
        UPDATE personal_tags_state SET revision=revision+1; UPDATE personal_focus_state SET revision=revision+1;
        UPDATE music_genre_state SET value=CAST(value AS INTEGER)+1 WHERE key='revision';
        UPDATE catalog_state SET value=CAST(value AS INTEGER)+1 WHERE key='revision';`)
    }
    if (bundle.playlists) this.playlists(bundle.playlists, policy, now)
    if (this.sql.prepare('PRAGMA foreign_key_check').get()) throw new Error('音乐备份引用校验失败，恢复已回滚')
    this.setMeta(`music_backup_restore:${bundle.restoreId}`, now)
    return this.result()
  }
}
