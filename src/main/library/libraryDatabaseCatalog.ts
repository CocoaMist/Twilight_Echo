import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type {
  CatalogDetail,
  CatalogEntity,
  CatalogKind,
  CatalogPage,
  CatalogQuery,
  CatalogSourcePage,
  CatalogSourceQuery,
  CatalogStatus,
  CatalogSync,
  CatalogSyncResult
} from '../../shared/musicCatalog.ts'
import { validCatalogPayload, CATALOG_MAX_BATCH_BYTES } from '../../shared/musicCatalog.ts'
import { parseMusicVersions, type MusicVersionsDocument } from '../../shared/musicVersions.ts'
import { getTrackSource, versionSourceKey } from '../../shared/trackSourceIdentity.ts'
import { getAlbumIdentity } from '../../shared/libraryIdentity.ts'
import type { TrackData } from '../../shared/track.ts'
import { projectCoreTrack } from '../../core/projections.ts'
import { normalizeCueRange } from '../../shared/cue.ts'
import { libraryTrack } from '../../core/playback/libraryTrack.ts'

/** Created in the same schema transaction as user_version. Backfill is deliberately not DDL. */
export const CATALOG_SCHEMA_SQL = `
CREATE TABLE catalog_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO catalog_state VALUES('revision','0'),('local_cursor','0'),
  ('local_horizon',CAST((SELECT coalesce(max(seq),0) FROM tracks) AS TEXT));
CREATE TABLE catalog_entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,
  artist TEXT NOT NULL,identity TEXT NOT NULL CHECK(identity IN ('source','manual')));
CREATE TABLE catalog_aliases(namespace TEXT NOT NULL,key TEXT NOT NULL,
  entity_id TEXT NOT NULL REFERENCES catalog_entities(id),PRIMARY KEY(namespace,key));
CREATE TABLE catalog_sources(id TEXT PRIMARY KEY,source_key TEXT NOT NULL UNIQUE,provider TEXT NOT NULL,
  track_id TEXT NOT NULL,recording_id TEXT NOT NULL REFERENCES catalog_entities(id),
  release_id TEXT REFERENCES catalog_entities(id),album_key TEXT,payload TEXT NOT NULL,
  availability TEXT NOT NULL CHECK(availability IN ('indexed','unknown','missing')));
CREATE INDEX catalog_source_track ON catalog_sources(provider,track_id);
CREATE INDEX catalog_source_recording ON catalog_sources(recording_id);
CREATE INDEX catalog_source_release ON catalog_sources(release_id);
CREATE TABLE catalog_source_artists(source_id TEXT NOT NULL REFERENCES catalog_sources(id),
  artist_id TEXT NOT NULL REFERENCES catalog_entities(id),PRIMARY KEY(source_id,artist_id));
CREATE INDEX catalog_artist_sources ON catalog_source_artists(artist_id,source_id);
CREATE TABLE catalog_memberships(owner TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES catalog_sources(id),
  PRIMARY KEY(owner,source_id));
CREATE INDEX catalog_membership_sources ON catalog_memberships(source_id);
CREATE TABLE catalog_facts(source_id TEXT NOT NULL REFERENCES catalog_sources(id),
  entity_id TEXT NOT NULL REFERENCES catalog_entities(id),field TEXT NOT NULL,value TEXT NOT NULL,
  origin TEXT NOT NULL,PRIMARY KEY(source_id,entity_id,field));
CREATE INDEX catalog_entity_facts ON catalog_facts(entity_id,source_id);
CREATE TABLE catalog_pending(track_id TEXT PRIMARY KEY);
CREATE TRIGGER catalog_tracks_ai AFTER INSERT ON tracks BEGIN
  INSERT INTO catalog_pending SELECT new.id WHERE NOT EXISTS(SELECT 1 FROM catalog_pending WHERE track_id=new.id); END;
CREATE TRIGGER catalog_tracks_au AFTER UPDATE ON tracks BEGIN
  INSERT INTO catalog_pending SELECT old.id WHERE NOT EXISTS(SELECT 1 FROM catalog_pending WHERE track_id=old.id);
  INSERT INTO catalog_pending SELECT new.id WHERE NOT EXISTS(SELECT 1 FROM catalog_pending WHERE track_id=new.id); END;
CREATE TRIGGER catalog_tracks_ad AFTER DELETE ON tracks BEGIN
  INSERT INTO catalog_pending SELECT old.id WHERE NOT EXISTS(SELECT 1 FROM catalog_pending WHERE track_id=old.id); END;
CREATE TABLE catalog_imports(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,sequence INTEGER NOT NULL);
CREATE TABLE catalog_import_members(import_id TEXT NOT NULL REFERENCES catalog_imports(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES catalog_sources(id),PRIMARY KEY(import_id,source_id));
CREATE TABLE catalog_versions(scope TEXT NOT NULL,id TEXT NOT NULL,
  entity_id TEXT NOT NULL REFERENCES catalog_entities(id),label TEXT NOT NULL,
  preferred_source TEXT,family_id TEXT,preferred_version TEXT,PRIMARY KEY(scope,id));
CREATE TABLE catalog_version_sources(scope TEXT NOT NULL,source_key TEXT NOT NULL,version_id TEXT NOT NULL,
  PRIMARY KEY(scope,source_key),FOREIGN KEY(scope,version_id) REFERENCES catalog_versions(scope,id) ON DELETE CASCADE);
CREATE VIEW catalog_bindings AS SELECT s.*,
  coalesce(tv.entity_id,s.recording_id) AS recording,
  coalesce(av.entity_id,s.release_id) AS release,
  CASE WHEN tv.preferred_source=s.source_key THEN 1 ELSE 0 END AS preferred_recording,
  CASE WHEN av.preferred_source=s.album_key THEN 1 ELSE 0 END AS preferred_release
  FROM catalog_sources s
  LEFT JOIN catalog_version_sources ts ON ts.scope='tracks' AND ts.source_key=s.source_key
  LEFT JOIN catalog_versions tv ON tv.scope=ts.scope AND tv.id=ts.version_id
  LEFT JOIN catalog_version_sources als ON als.scope='albums' AND als.source_key=s.album_key
  LEFT JOIN catalog_versions av ON av.scope=als.scope AND av.id=als.version_id;
CREATE VIEW catalog_entity_sources AS
  SELECT recording AS entity_id,id AS source_id FROM catalog_bindings
  UNION ALL SELECT release,id FROM catalog_bindings WHERE release IS NOT NULL
  UNION ALL SELECT artist_id,source_id FROM catalog_source_artists;
`

type Row = Record<string, string | number | null>
type Owner = { sql: DatabaseSync; transaction<T>(action: () => T): T }
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const stale = () =>
  Object.assign(new Error('音乐资料已变化，请刷新后重试'), { code: 'STALE_REVISION' })
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Stores source identity, never guesses recording equality from names. All writes are bounded. */
export class LibraryDatabaseCatalog {
  private readonly owner: Owner
  constructor(owner: Owner) {
    this.owner = owner
  }
  private get sql() {
    return this.owner.sql
  }
  private state(key: string): string | null {
    return (
      ((this.sql.prepare('SELECT value FROM catalog_state WHERE key=?').get(key) as Row | undefined)
        ?.value as string) ?? null
    )
  }
  private set(key: string, value: string | number) {
    this.sql
      .prepare(
        'INSERT INTO catalog_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
      .run(key, String(value))
  }
  private bump() {
    this.set('revision', Number(this.state('revision')) + 1)
  }
  private fence(revision?: number) {
    if (revision !== undefined && revision !== Number(this.state('revision'))) throw stale()
  }
  status(): CatalogStatus {
    const cursor = Number(this.state('local_cursor')),
      horizon = Number(this.state('local_horizon'))
    const dirty = Number(
      (this.sql.prepare('SELECT count(*) AS n FROM catalog_pending').get() as Row).n
    )
    const playlists = this.state('playlists_revision'),
      versions = this.state('versions_revision')
    return {
      revision: Number(this.state('revision')),
      localCursor: cursor,
      localHorizon: horizon,
      localPending: cursor < horizon || dirty > 0,
      dirtySources: dirty,
      playlistsRevision: playlists === null ? null : Number(playlists),
      versionsRevision: versions === null ? null : Number(versions)
    }
  }
  advance(limit = 200): CatalogStatus {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new Error('Invalid catalog batch size')
    return this.owner.transaction(() => {
      const cursor = Number(this.state('local_cursor')),
        horizon = Number(this.state('local_horizon'))
      let processed = 0
      if (cursor < horizon) {
        const rows = this.sql
          .prepare('SELECT seq,payload FROM tracks WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?')
          .all(cursor, horizon, limit) as Row[]
        for (const row of rows) {
          const raw = JSON.parse(str(row.payload))
          const track = libraryTrack(raw)
          this.upsert(track, 'local', raw)
          this.sql.prepare('DELETE FROM catalog_pending WHERE track_id=?').run(track.id)
        }
        this.set('local_cursor', rows.length === limit ? Number(rows.at(-1)!.seq) : horizon)
        processed += rows.length
      }
      const pending = this.sql
        .prepare('SELECT track_id FROM catalog_pending ORDER BY track_id LIMIT ?')
        .all(limit - processed) as Row[]
      for (const item of pending) {
        const row = this.sql.prepare('SELECT payload FROM tracks WHERE id=?').get(item.track_id) as
          | Row
          | undefined
        if (row) {
          const raw = JSON.parse(str(row.payload))
          this.upsert(libraryTrack(raw), 'local', raw)
        } else {
          this.sql
            .prepare(
              "DELETE FROM catalog_memberships WHERE owner='local' AND source_id IN (SELECT id FROM catalog_sources WHERE provider='local' AND track_id=?)"
            )
            .run(item.track_id)
          this.sql
            .prepare(
              "UPDATE catalog_sources SET availability='missing' WHERE provider='local' AND track_id=?"
            )
            .run(item.track_id)
        }
        this.sql.prepare('DELETE FROM catalog_pending WHERE track_id=?').run(item.track_id)
      }
      if (processed || pending.length || cursor < horizon) this.bump()
      return this.status()
    })
  }
  private entity(
    namespace: string,
    key: string,
    kind: CatalogKind,
    title: string,
    artist = '',
    identity: 'source' | 'manual' = 'source'
  ): string {
    const found = this.sql
      .prepare('SELECT entity_id FROM catalog_aliases WHERE namespace=? AND key=?')
      .get(namespace, key) as Row | undefined
    const id = found ? str(found.entity_id) : `music_${randomUUID()}`
    if (!found) {
      this.sql
        .prepare('INSERT INTO catalog_entities VALUES(?,?,?,?,?)')
        .run(id, kind, title, artist, identity)
      this.sql.prepare('INSERT INTO catalog_aliases VALUES(?,?,?)').run(namespace, key, id)
    } else
      this.sql
        .prepare('UPDATE catalog_entities SET title=?,artist=? WHERE id=?')
        .run(title, artist, id)
    return id
  }
  private upsert(input: TrackData, owner?: 'local', raw: Partial<TrackData> = input): string {
    if (
      !input ||
      typeof input.id !== 'string' ||
      input.id.length > 8192 ||
      (input.source !== undefined &&
        (typeof input.source !== 'string' || input.source.length > 128)) ||
      (input.filePath !== undefined && typeof input.filePath !== 'string')
    )
      throw new Error('Invalid catalog source')
    const provider = getTrackSource(input)
    if (
      !input.id ||
      !provider ||
      ['network', 'radio', 'podcast'].includes(provider) ||
      (owner === 'local' && provider !== 'local') ||
      (provider === 'local' && !input.filePath)
    )
      throw new Error('Unsupported catalog music source')
    const key = versionSourceKey(input)
    if (key.length > 16384) throw new Error('Catalog source identity too long')
    const previous = this.sql
      .prepare('SELECT * FROM catalog_sources WHERE source_key=?')
      .get(key) as Row | undefined
    const id = previous ? str(previous.id) : `source_${randomUUID()}`
    const recording = this.entity(
      'source.recording',
      key,
      'recording',
      str(input.title),
      str(input.artist)
    )
    const albumIdentity = getAlbumIdentity(input)
    const albumKey = JSON.stringify(['album', provider, albumIdentity])
    // A provider's title alone is not a release ID. Keep the legacy album key
    // for explicit version mappings, but do not automatically group these items.
    const releaseKey =
      provider !== 'local' && !str(input.albumId).trim()
        ? JSON.stringify([provider, 'track', key])
        : albumKey
    let release: string | null = null
    if (str(raw.album).trim()) {
      // A tag-only rename retains its source's existing album identity. Explicit
      // provider/album IDs use the new declared identity instead.
      const alias = this.sql
        .prepare("SELECT entity_id FROM catalog_aliases WHERE namespace='source.release' AND key=?")
        .get(releaseKey) as Row | undefined
      if (!alias && previous?.release_id && !input.albumId) {
        release = str(previous.release_id)
        this.sql
          .prepare("INSERT INTO catalog_aliases VALUES('source.release',?,?)")
          .run(releaseKey, release)
        this.sql
          .prepare('UPDATE catalog_entities SET title=?,artist=? WHERE id=?')
          .run(input.album, input.albumArtist || input.artist || '', release)
      } else
        release = this.entity(
          'source.release',
          releaseKey,
          'release',
          input.album,
          input.albumArtist || input.artist || ''
        )
    }
    const track = snapshot(input, provider)
    if (owner) {
      // A changed selector/path is a different source. Retain its offline record,
      // but do not keep it as a live library member under the same Track ID.
      this.sql
        .prepare(
          `DELETE FROM catalog_memberships WHERE owner='local' AND source_id IN
        (SELECT id FROM catalog_sources WHERE provider='local' AND track_id=? AND source_key<>?)`
        )
        .run(input.id, key)
      this.sql
        .prepare(
          "UPDATE catalog_sources SET availability='missing' WHERE provider='local' AND track_id=? AND source_key<>?"
        )
        .run(input.id, key)
    }
    this.sql
      .prepare(
        `INSERT INTO catalog_sources VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_key) DO UPDATE SET track_id=excluded.track_id,release_id=excluded.release_id,
      album_key=excluded.album_key,payload=excluded.payload,availability=excluded.availability`
      )
      .run(
        id,
        key,
        provider,
        input.id,
        recording,
        release,
        release ? albumKey : null,
        JSON.stringify(track),
        provider === 'local' ? 'indexed' : 'unknown'
      )
    this.sql.prepare('DELETE FROM catalog_source_artists WHERE source_id=?').run(id)
    this.sql.prepare('DELETE FROM catalog_facts WHERE source_id=?').run(id)
    const fact = (entityId: string, field: string, value: string) =>
      this.sql
        .prepare('INSERT OR REPLACE INTO catalog_facts VALUES(?,?,?,?,?)')
        .run(id, entityId, field, value, provider === 'local' ? 'file' : 'provider')
    if (str(raw.title).trim()) fact(recording, 'title', str(raw.title))
    if (str(raw.artist).trim()) fact(recording, 'artist', str(raw.artist))
    if (release) fact(release, 'album', input.album)
    const artists =
      Array.isArray(raw.artists) && raw.artists.length
        ? (track.artists ?? [])
        : [{ name: str(raw.artist) }]
    for (const [index, artist] of artists.entries()) {
      if (!str(artist.name).trim()) continue
      // A compilation's first credit need not be the same person on every track.
      // Without provider IDs, keep source-scoped credits until identification.
      const artistKey =
        artist.id !== undefined
          ? JSON.stringify([provider, String(artist.id)])
          : JSON.stringify([provider, recording, index])
      const performer = this.entity('source.artist', artistKey, 'artist', artist.name)
      this.sql
        .prepare('INSERT OR IGNORE INTO catalog_source_artists VALUES(?,?)')
        .run(id, performer)
      fact(performer, 'artist', artist.name)
    }
    if (owner)
      this.sql.prepare('INSERT OR IGNORE INTO catalog_memberships VALUES(?,?)').run(owner, id)
    return id
  }
  sync(request: CatalogSync): CatalogSyncResult {
    if (!request || !['begin', 'append', 'commit', 'abort'].includes(request.kind))
      throw new Error('Invalid catalog import')
    if (request.kind !== 'begin' && (typeof request.id !== 'string' || request.id.length > 128))
      throw new Error('Invalid catalog import ID')
    return this.owner.transaction(() => {
      if (request.kind === 'begin') {
        if (!Number.isSafeInteger(request.revision) || request.revision < 0)
          throw new Error('Invalid playlist catalog revision')
        this.sql.exec('DELETE FROM catalog_imports')
        const id = randomUUID()
        this.sql.prepare('INSERT INTO catalog_imports VALUES(?,?,0)').run(id, request.revision)
        return { id, sequence: 0 }
      }
      const job = this.sql.prepare('SELECT * FROM catalog_imports WHERE id=?').get(request.id) as
        | Row
        | undefined
      if (request.kind === 'abort') {
        this.sql.prepare('DELETE FROM catalog_imports WHERE id=?').run(request.id)
        return { id: request.id, sequence: Number(job?.sequence ?? 0) }
      }
      if (!job || request.sequence !== Number(job.sequence)) throw stale()
      if (request.kind === 'append') {
        if (!Array.isArray(request.tracks) || request.tracks.length > 200)
          throw new Error('Catalog source page exceeds 200')
        if (Buffer.byteLength(JSON.stringify(request.tracks), 'utf8') > CATALOG_MAX_BATCH_BYTES)
          throw new Error('Catalog source page exceeds 1 MiB')
        for (const track of request.tracks) {
          if (getTrackSource(track) === 'local') continue
          const source = this.upsert(track)
          this.sql
            .prepare('INSERT OR IGNORE INTO catalog_import_members VALUES(?,?)')
            .run(request.id, source)
        }
        this.sql
          .prepare('UPDATE catalog_imports SET sequence=sequence+1 WHERE id=?')
          .run(request.id)
        // Existing sources may have received new metadata, even before this
        // membership generation is published. Fence readers of those changes.
        if (request.tracks.length) this.bump()
        return { id: request.id, sequence: request.sequence + 1 }
      }
      this.sql.prepare("DELETE FROM catalog_memberships WHERE owner='playlists'").run()
      this.sql
        .prepare(
          "INSERT INTO catalog_memberships SELECT 'playlists',source_id FROM catalog_import_members WHERE import_id=?"
        )
        .run(request.id)
      this.set('playlists_revision', Number(job.revision))
      this.sql.prepare('DELETE FROM catalog_imports WHERE id=?').run(request.id)
      this.bump()
      return { id: request.id, sequence: request.sequence }
    })
  }
  projectVersions(document: MusicVersionsDocument, revision: number): void {
    const parsed = parseMusicVersions(JSON.stringify(document))
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid version revision')
    this.owner.transaction(() => {
      this.sql.exec('DELETE FROM catalog_version_sources; DELETE FROM catalog_versions;')
      for (const scope of ['tracks', 'albums'] as const) {
        const families = new Map(
          parsed[scope].families.flatMap((f) => f.versions.map((id) => [id, f] as const))
        )
        for (const version of parsed[scope].versions) {
          const kind = scope === 'tracks' ? 'recording' : 'release'
          const id = this.entity(
            'manual.version',
            JSON.stringify([scope, version.id]),
            kind,
            version.label,
            '',
            'manual'
          )
          const family = families.get(version.id)
          this.sql
            .prepare('INSERT INTO catalog_versions VALUES(?,?,?,?,?,?,?)')
            .run(
              scope,
              version.id,
              id,
              version.label,
              version.preferredSource,
              family?.id ?? null,
              family?.preferredVersion ?? null
            )
          for (const source of version.sources)
            this.sql
              .prepare('INSERT INTO catalog_version_sources VALUES(?,?,?)')
              .run(scope, source, version.id)
        }
      }
      this.set('versions_revision', revision)
      this.bump()
    })
  }
  query(query: CatalogQuery): CatalogPage {
    if (!validCatalogPayload('catalog.query', query)) throw new Error('Invalid catalog query')
    this.fence(query.revision)
    const params: SQLInputValue[] = []
    const conditions = ['1=1']
    if (query.scope !== 'all')
      conditions.push('EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)')
    if (query.source) {
      conditions.push('s.provider=?')
      params.push(query.source)
    }
    // Aggregate from the source side once, rather than an OR-correlated full
    // source scan for every entity. Filtering keeps sourceCount meaningful.
    const cte = `WITH candidates AS (SELECT b.entity_id,count(*) AS source_count
      FROM catalog_entity_sources b JOIN catalog_sources s ON s.id=b.source_id
      WHERE ${conditions.join(' AND ')} GROUP BY b.entity_id)`
    params.push(query.kind)
    let where = 'e.kind=?'
    if (query.search) {
      where += " AND instr(lower(e.title || ' ' || e.artist),lower(?))>0"
      params.push(query.search)
    }
    const from = `FROM candidates c JOIN catalog_entities e ON e.id=c.entity_id WHERE ${where}`
    const total = Number(
      (this.sql.prepare(`${cte} SELECT count(*) AS n ${from}`).get(...params) as Row).n
    )
    const offset = query.offset ?? 0
    const rows = this.sql
      .prepare(
        `${cte} SELECT e.*,c.source_count ${from}
      ORDER BY e.title COLLATE NOCASE,e.id LIMIT ? OFFSET ?`
      )
      .all(...params, query.limit ?? 200, offset) as Row[]
    return { revision: Number(this.state('revision')), offset, total, items: rows.map(entityView) }
  }
  detail(id: string, revision?: number): CatalogDetail {
    if (!validCatalogPayload('catalog.detail', { id, revision }))
      throw new Error('Invalid catalog entity')
    this.fence(revision)
    const row = this.sql
      .prepare(
        `SELECT e.*,(SELECT count(*) FROM catalog_entity_sources b WHERE b.entity_id=e.id) AS source_count
      FROM catalog_entities e WHERE e.id=?`
      )
      .get(id) as Row | undefined
    const mapped =
      row?.kind === 'recording' ? 'recording_id' : row?.kind === 'release' ? 'release_id' : null
    const args: SQLInputValue[] = [id]
    const projection = mapped
      ? `UNION ALL SELECT f.source_id,f.field,f.value,f.origin
      FROM catalog_entity_sources b JOIN catalog_sources s ON s.id=b.source_id
      JOIN catalog_facts f ON f.source_id=s.id AND f.entity_id=s.${mapped}
      WHERE b.entity_id=? AND f.entity_id<>?`
      : ''
    if (mapped) args.push(id, id)
    const facts = this.sql
      .prepare(
        `SELECT f.source_id,f.field,f.value,f.origin FROM catalog_facts f
      WHERE f.entity_id=? ${projection}
      ORDER BY source_id,field LIMIT 201`
      )
      .all(...args) as Row[]
    return {
      revision: Number(this.state('revision')),
      entity: row ? entityView(row) : null,
      factsTruncated: facts.length > 200,
      facts: facts.slice(0, 200).map((f) => ({
        sourceId: str(f.source_id),
        field: f.field as 'title' | 'artist' | 'album',
        value: str(f.value),
        origin: f.origin as 'file' | 'provider'
      }))
    }
  }
  sources(query: CatalogSourceQuery): CatalogSourcePage {
    if (!validCatalogPayload('catalog.sources', query))
      throw new Error('Invalid catalog sources query')
    this.fence(query.revision)
    const from =
      'FROM catalog_entity_sources b JOIN catalog_bindings s ON s.id=b.source_id WHERE b.entity_id=?'
    const total = Number(
      (this.sql.prepare(`SELECT count(*) AS n ${from}`).get(query.entityId) as Row).n
    )
    const offset = query.offset ?? 0
    const rows = this.sql
      .prepare(
        `SELECT s.*,EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id) AS member,
      CASE WHEN b.entity_id=s.recording THEN s.preferred_recording WHEN b.entity_id=s.release THEN s.preferred_release ELSE 0 END AS preferred
      ${from} ORDER BY s.id LIMIT ? OFFSET ?`
      )
      .all(query.entityId, query.limit ?? 200, offset) as Row[]
    return {
      revision: Number(this.state('revision')),
      offset,
      total,
      items: rows.map((s) => ({
        id: str(s.id),
        provider: str(s.provider),
        recordingId: str(s.recording),
        releaseId: s.release as string | null,
        availability: s.availability as 'indexed' | 'unknown' | 'missing',
        inLibrary: !!s.member,
        preferred: !!s.preferred,
        track: displayTrack(JSON.parse(str(s.payload)))
      }))
    }
  }
  resolve(sourceId: string, revision: number): TrackData | null {
    if (!validCatalogPayload('catalog.play', { sourceId, revision }))
      throw new Error('Invalid catalog source reference')
    this.fence(revision)
    const source = this.sql.prepare('SELECT * FROM catalog_sources WHERE id=?').get(sourceId) as
      | Row
      | undefined
    if (!source) return null
    if (source.provider !== 'local') return JSON.parse(str(source.payload)) as TrackData
    const current = this.sql
      .prepare('SELECT payload FROM tracks WHERE id=?')
      .get(source.track_id) as Row | undefined
    if (!current) return null
    const track = libraryTrack(JSON.parse(str(current.payload)))
    return versionSourceKey(track) === source.source_key ? track : null
  }
}

function entityView(row: Row): CatalogEntity {
  return {
    id: str(row.id),
    kind: row.kind as CatalogKind,
    title: str(row.title),
    artist: str(row.artist),
    identity: row.identity as 'source' | 'manual',
    sourceCount: Number(row.source_count)
  }
}

function displayTrack(track: TrackData) {
  const {
    id: _id,
    queueEntryId: _occurrence,
    subTrack: _selector,
    ...display
  } = projectCoreTrack(track)
  return display
}

/** A safe durable provider reference, never a captured URL, credential or analysis payload. */
function snapshot(track: TrackData, provider: string): TrackData {
  const result: TrackData = {
    id: track.id,
    title: str(track.title),
    artist: str(track.artist),
    album: str(track.album),
    source: provider,
    duration: finite(track.duration),
    size: finite(track.size),
    filePath: '',
    fileName: '',
    cover: null,
    lyrics: null
  }
  for (const field of [
    'albumId',
    'albumArtist',
    'releaseDate',
    'genre',
    'isrc',
    'format',
    'sampleRate',
    'bitDepth',
    'bitrate',
    'discNumber',
    'trackNumber',
    'cueRange',
    'ncmSongId',
    'addedAt'
  ] as const)
    if (typeof track[field] === 'string')
      Object.assign(result, { [field]: (track[field] as string).slice(0, 32768) })
    else if (typeof track[field] === 'number' && Number.isFinite(track[field]))
      Object.assign(result, { [field]: track[field] })
  if (track.cueRange) result.cueRange = normalizeCueRange(track.cueRange) ?? undefined
  if (Array.isArray(track.artists))
    result.artists = track.artists
      .slice(0, 128)
      .filter((a) => a && typeof a.name === 'string')
      .map((a) => ({
        name: a.name.slice(0, 32768),
        ...(typeof a.id === 'string'
          ? { id: a.id.slice(0, 8192) }
          : typeof a.id === 'number' && Number.isFinite(a.id)
            ? { id: a.id }
            : {})
      }))
  return result
}
