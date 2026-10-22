import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type {
  LibraryCollectionPage,
  LibraryPlaylistSourceSummary,
  LibraryPage,
  LibraryPlaylistViewSync,
  LibraryPlaylistViewSyncResult,
  LibraryQuery,
  LibraryTrackRecord
} from '../../shared/libraryDatabase.ts'
import { compactPlaylistRecord } from '../../shared/playlistSnapshot.ts'
import { getTrackSource } from '../../shared/trackSourceIdentity.ts'
import { getPinyinInitials } from '../../shared/pinyinInitials.ts'
import { albumOrderIndex, getAlbumIdentity } from '../../shared/libraryIdentity.ts'
import { normalizeLibraryFilePath } from './libraryRepository.ts'
import { createPlaylistTrackLookup } from './libraryDatabasePlaylist.ts'
import { libraryPageBounds, validateLibraryPlaylistViewSync } from './libraryDatabaseValidation.ts'
import type { RecordingIdentity } from '../../shared/recordingIdentity.ts'
import { LibraryDatabaseAggregateViews } from './libraryDatabaseAggregate.ts'

type Row = Record<string, string | number | null>
type Lookup = ReturnType<typeof createPlaylistTrackLookup>
type RefreshKey = { column: 'id' | 'recording_key'; value: string }
type Build = {
  revision: number
  changeCursor: number
  resolve: Lookup
  // Null means a complete seek through the immutable definitions. Delta keys
  // use the same cursor per indexed key, including arbitrarily many duplicates.
  keys: RefreshKey[] | null
  keyIndex: number
  cursor: number
  membershipChanged: boolean
}
type View = {
  token: symbol
  sequence: number
  count: number
  bytes: number
  catalog: boolean
  groupCount: number
  committed: boolean
  touched: number
  revision: number
  changeCursor: number
  recordingKey(track: RecordingIdentity): string
  versions: Extract<LibraryPlaylistViewSync, { kind: 'begin' }>['versions']
  preserveSources?: boolean
  orders: Map<string, number[]>
  stats: Map<string, { total: number; duration: number }>
  build?: Build
}
type Owner = {
  sql: DatabaseSync
  statement(query: string): ReturnType<DatabaseSync['prepare']>
  transaction<T>(action: () => T): T
  revision(): number
  historyRevision(): number
  where(query: LibraryQuery): { sql: string; params: SQLInputValue[] }
}
const text = (value: unknown) => (typeof value === 'string' ? value : '')
const n = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
const collator = new Intl.Collator('zh')
const natural = new Intl.Collator('zh', { numeric: true, sensitivity: 'base' })
const numeric: Record<string, string> = {
  duration: 'duration',
  sampleRate: 'sample_rate',
  addedAt: 'added_at',
  recentlyAdded: 'added_at',
  lastPlayed: 'last_played',
  playlist: 'seq',
  insertion: 'seq'
}
const strings: Record<string, string> = {
  title: 'title',
  artist: 'artist',
  album: 'album',
  format: 'format'
}
const lossless = new Set([
  'flac',
  'alac',
  'wav',
  'wave',
  'aiff',
  'aif',
  'ape',
  'wv',
  'dsf',
  'dff',
  'mqa'
])
const changeIdentity = (row: 'old' | 'new') => `json_object('id',${row}.id,'source','local',
  'filePath',json_extract(${row}.payload,'$.filePath'),'title',json_extract(${row}.payload,'$.title'),
  'artist',json_extract(${row}.payload,'$.artist'),'subTrack',json_extract(${row}.payload,'$.subTrack'),
  'cueRange',json_extract(${row}.payload,'$.cueRange'))`
export interface PlaylistQueuePlan {
  viewId: string
  members: number[]
  index: number
}

/** Derived, process-local views, not a second playlist persistence owner.
 * Definitions are uploaded once in bounded batches; only compact sort/filter
 * columns and local references are materialized. Never a full Track[] cache. */
export class LibraryDatabasePlaylistViews {
  private readonly owner: Owner
  private readonly views = new Map<string, View>()
  private readonly retiring = new Set<string>()
  private initialized = false
  private readonly aggregates: LibraryDatabaseAggregateViews
  constructor(owner: Owner) {
    this.owner = owner
    this.aggregates = new LibraryDatabaseAggregateViews(
      owner.sql,
      (action) => owner.transaction(action),
      (query) => owner.statement(query)
    )
  }
  private initialize() {
    if (this.initialized) return
    this.owner.sql.exec(`CREATE TEMP TABLE IF NOT EXISTS playlist_definitions(
      view_id TEXT NOT NULL,seq INTEGER NOT NULL,id TEXT NOT NULL,snapshot TEXT,recording_key TEXT,collection_id TEXT,PRIMARY KEY(view_id,seq));
      CREATE TEMP TABLE IF NOT EXISTS playlist_groups(
        view_id TEXT NOT NULL,id TEXT NOT NULL,seq INTEGER NOT NULL,name TEXT NOT NULL,cover TEXT,is_default INTEGER NOT NULL,
        search_name TEXT NOT NULL,track_count INTEGER NOT NULL DEFAULT 0,local_count INTEGER NOT NULL DEFAULT 0,duration REAL NOT NULL DEFAULT 0,
        PRIMARY KEY(view_id,id));
      CREATE TEMP TABLE IF NOT EXISTS playlist_group_sources(
        view_id TEXT NOT NULL,collection_id TEXT NOT NULL,source TEXT NOT NULL,count INTEGER NOT NULL,
        PRIMARY KEY(view_id,collection_id,source));
      CREATE INDEX IF NOT EXISTS playlist_definitions_id ON playlist_definitions(view_id,id,seq);
      CREATE INDEX IF NOT EXISTS playlist_definitions_recording ON playlist_definitions(view_id,recording_key,seq);
      CREATE TEMP TABLE IF NOT EXISTS playlist_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,payload TEXT NOT NULL);
      CREATE TEMP TRIGGER IF NOT EXISTS playlist_change_limit AFTER INSERT ON playlist_changes BEGIN
        DELETE FROM playlist_changes WHERE seq<=new.seq-4096; END;
      CREATE TEMP TRIGGER IF NOT EXISTS playlist_track_insert AFTER INSERT ON main.tracks BEGIN
        INSERT INTO playlist_changes(payload) VALUES(${changeIdentity('new')}); END;
      CREATE TEMP TRIGGER IF NOT EXISTS playlist_track_delete AFTER DELETE ON main.tracks BEGIN
        INSERT INTO playlist_changes(payload) VALUES(${changeIdentity('old')}); END;
      CREATE TEMP TRIGGER IF NOT EXISTS playlist_track_update AFTER UPDATE OF payload ON main.tracks WHEN old.payload<>new.payload BEGIN
        INSERT INTO playlist_changes(payload) VALUES(${changeIdentity('old')}),(${changeIdentity('new')}); END;
      CREATE TEMP TABLE IF NOT EXISTS playlist_members(
      uid INTEGER PRIMARY KEY,view_id TEXT NOT NULL,seq INTEGER NOT NULL,collection_id TEXT,id TEXT NOT NULL,local_id TEXT,snapshot TEXT,
      payload TEXT NOT NULL DEFAULT '{}',title TEXT NOT NULL DEFAULT '',artist TEXT NOT NULL DEFAULT '',album TEXT NOT NULL DEFAULT '',format TEXT NOT NULL DEFAULT '',
      album_key TEXT NOT NULL DEFAULT '',folder TEXT NOT NULL DEFAULT '',provider TEXT NOT NULL,search_text TEXT NOT NULL DEFAULT '',search_file TEXT NOT NULL DEFAULT '',
      duration REAL NOT NULL,sample_rate REAL NOT NULL DEFAULT 0,bit_depth REAL NOT NULL DEFAULT 0,added_at REAL NOT NULL DEFAULT 0,
      disc_no REAL NOT NULL DEFAULT 0,track_no REAL NOT NULL DEFAULT 0,file_name TEXT NOT NULL DEFAULT '',lossless INTEGER NOT NULL DEFAULT 0,dsd INTEGER NOT NULL DEFAULT 0,
      details_ready INTEGER NOT NULL DEFAULT 1,
      UNIQUE(view_id,seq));
      CREATE INDEX IF NOT EXISTS playlist_members_duration ON playlist_members(view_id,duration,seq);
      CREATE INDEX IF NOT EXISTS playlist_members_rate ON playlist_members(view_id,sample_rate,seq);
      CREATE INDEX IF NOT EXISTS playlist_members_added ON playlist_members(view_id,added_at,seq);
      CREATE INDEX IF NOT EXISTS playlist_members_pending_details ON playlist_members(view_id,seq) WHERE collection_id IS NULL AND details_ready=0;
      CREATE VIRTUAL TABLE IF NOT EXISTS temp.playlist_search USING fts5(search_text,search_file,content='playlist_members',content_rowid='uid',tokenize='trigram');
      CREATE TEMP TRIGGER IF NOT EXISTS playlist_member_ai AFTER INSERT ON playlist_members BEGIN
        INSERT INTO playlist_search(rowid,search_text,search_file) SELECT new.uid,new.search_text,new.search_file WHERE new.collection_id IS NULL AND new.details_ready=1;
        UPDATE playlist_groups SET track_count=track_count+1,local_count=local_count+(new.provider='local'),duration=duration+max(0,new.duration)
          WHERE view_id=new.view_id AND id=new.collection_id;
        INSERT INTO playlist_group_sources SELECT new.view_id,new.collection_id,new.provider,1 WHERE new.collection_id IS NOT NULL
          ON CONFLICT(view_id,collection_id,source) DO UPDATE SET count=count+1; END;
      CREATE TEMP TRIGGER IF NOT EXISTS playlist_member_ad AFTER DELETE ON playlist_members BEGIN
        INSERT INTO playlist_search(playlist_search,rowid,search_text,search_file) SELECT 'delete',old.uid,old.search_text,old.search_file WHERE old.collection_id IS NULL AND old.details_ready=1;
        UPDATE playlist_groups SET track_count=track_count-1,local_count=local_count-(old.provider='local'),duration=duration-max(0,old.duration)
          WHERE view_id=old.view_id AND id=old.collection_id;
        UPDATE playlist_group_sources SET count=count-1
          WHERE view_id=old.view_id AND collection_id=old.collection_id AND source=old.provider;
        DELETE FROM playlist_group_sources WHERE view_id=old.view_id AND collection_id=old.collection_id AND source=old.provider AND count=0; END;`)
    this.aggregates.initialize()
    this.initialized = true
  }
  private drop(id: string) {
    if (this.views.delete(id)) {
      this.aggregates.drop(id)
      this.retiring.add(id)
    }
  }
  get needsMaintenance(): boolean {
    return this.retiring.size > 0 || this.aggregates.needsMaintenance
  }
  /** Retire the handle immediately, but release at most 200 rows per turn.
   * Retiring handles still occupy a slot, bounding upload/drop churn. */
  maintenance(): void {
    const id = this.retiring.values().next().value
    if (id === undefined) {
      this.aggregates.maintenance()
      return
    }
    let done = false
    this.owner.transaction(() => {
      const removed = Number(
        this.owner
          .statement(
            `DELETE FROM playlist_members WHERE uid IN
          (SELECT uid FROM playlist_members WHERE view_id=? LIMIT 200)`
          )
          .run(id).changes
      )
      let remaining = 200 - removed
      if (remaining > 0) remaining -= this.aggregates.cleanup(id, remaining)
      if (remaining > 0) {
        remaining -= Number(
          this.owner
            .statement(
              `DELETE FROM playlist_definitions WHERE rowid IN
          (SELECT rowid FROM playlist_definitions WHERE view_id=? LIMIT ?)`
            )
            .run(id, remaining).changes
        )
      }
      if (remaining > 0) {
        remaining -= Number(
          this.owner
            .statement(
              `DELETE FROM playlist_groups WHERE rowid IN
          (SELECT rowid FROM playlist_groups WHERE view_id=? LIMIT ?)`
            )
            .run(id, remaining).changes
        )
      }
      if (remaining > 0) {
        this.owner
          .statement(
            `DELETE FROM playlist_group_sources WHERE rowid IN
          (SELECT rowid FROM playlist_group_sources WHERE view_id=? LIMIT ?)`
          )
          .run(id, remaining)
      }
      done =
        !this.aggregates.hasRows(id) &&
        !this.owner
          .statement(
            `SELECT 1 FROM playlist_members WHERE view_id=? UNION ALL
        SELECT 1 FROM playlist_definitions WHERE view_id=? UNION ALL
        SELECT 1 FROM playlist_groups WHERE view_id=? UNION ALL
        SELECT 1 FROM playlist_group_sources WHERE view_id=? LIMIT 1`
          )
          .get(id, id, id, id)
    })
    if (done) this.retiring.delete(id)
  }
  sync(request: LibraryPlaylistViewSync): LibraryPlaylistViewSyncResult {
    validateLibraryPlaylistViewSync(request)
    this.initialize()
    // Reload/crash cannot leave unbounded abandoned handles. Active readers
    // refresh the lease; an expired handle explicitly asks its owner to rebuild.
    for (const [id, view] of this.views) if (Date.now() - view.touched > 10 * 60_000) this.drop(id)
    this.maintenance()
    if (request.kind === 'drop') {
      this.drop(request.id)
      this.maintenance()
      return { id: request.id, sequence: 0, count: 0, committed: false }
    }
    if (request.kind === 'begin') {
      if (this.views.has(request.id) || this.retiring.has(request.id))
        throw new Error('Playlist view identity already exists or is being released')
      if (this.views.size + this.retiring.size >= 4)
        throw new Error('Too many playlist views; release an unused view or wait for cleanup')
      const preferences = {
        versions: structuredClone(request.versions),
        preserveSources: request.preserveSources
      }
      this.views.set(request.id, {
        token: Symbol(request.id),
        sequence: 0,
        count: 0,
        bytes: 0,
        catalog: request.catalog === true,
        groupCount: 0,
        committed: false,
        touched: Date.now(),
        revision: -1,
        changeCursor: 0,
        recordingKey: createPlaylistTrackLookup(this.owner.sql, preferences).recordingKey,
        versions: preferences.versions,
        preserveSources: request.preserveSources,
        orders: new Map(),
        stats: new Map()
      })
    } else {
      const view = this.get(request.id, false)
      if (view.committed || request.sequence !== view.sequence + 1)
        throw new Error('Playlist view changed or received an out-of-order batch')
      if (request.kind === 'groups') {
        if (!view.catalog) throw new Error('Playlist group definitions require a catalog view')
        const bytes = Buffer.byteLength(JSON.stringify(request.groups))
        if (
          view.groupCount + request.groups.length > 1_000_000 ||
          view.bytes + bytes > 256 * 1024 * 1024
        )
          throw new Error('Playlist catalog exceeds its definition capacity')
        this.owner.transaction(() => {
          const insert = this.owner
            .statement(`INSERT INTO playlist_groups(view_id,id,seq,name,cover,is_default,search_name)
            VALUES(?,?,?,?,?,?,?)`)
          for (let i = 0; i < request.groups.length; i++) {
            const group = request.groups[i]
            insert.run(
              request.id,
              group.id,
              view.groupCount + i,
              group.name,
              group.cover ?? null,
              group.isDefault ? 1 : 0,
              normalize(group.name)
            )
          }
        })
        view.groupCount += request.groups.length
        view.bytes += bytes
      } else if (request.kind === 'append') {
        const groupExists = this.owner.statement(
          'SELECT 1 FROM playlist_groups WHERE view_id=? AND id=?'
        )
        for (const entry of request.entries) {
          if (
            view.catalog
              ? !entry.collectionId || !groupExists.get(request.id, entry.collectionId)
              : entry.collectionId !== undefined
          )
            throw new Error('Playlist membership does not match its catalog group')
        }
        const entries = request.entries.map((entry) => ({
          id: entry.id,
          collectionId: entry.collectionId ?? null,
          snapshot: entry.snapshot ? JSON.stringify(compactPlaylistRecord(entry.snapshot)) : null
        }))
        const bytes = entries.reduce(
          (sum, entry) =>
            sum +
            Buffer.byteLength(entry.id) +
            Buffer.byteLength(entry.collectionId ?? '') +
            Buffer.byteLength(entry.snapshot ?? ''),
          0
        )
        if (
          view.count + entries.length > (view.catalog ? 8_000_000 : 1_000_000) ||
          view.bytes + bytes > 256 * 1024 * 1024
        )
          throw new Error('Playlist view exceeds its membership or snapshot capacity')
        this.owner.transaction(() => {
          const insert = this.owner.statement(
            'INSERT INTO playlist_definitions VALUES(?,?,?,?,?,?)'
          )
          for (let i = 0; i < entries.length; i++)
            insert.run(
              request.id,
              view.count + i,
              entries[i].id,
              entries[i].snapshot,
              request.entries[i].snapshot
                ? view.recordingKey(
                    request.entries[i].snapshot as LibraryTrackRecord & RecordingIdentity
                  )
                : null,
              entries[i].collectionId
            )
        })
        view.count += entries.length
        view.bytes += bytes
      } else view.committed = true
      view.sequence = request.sequence
    }
    const view = this.views.get(request.id)!
    return { id: request.id, sequence: view.sequence, count: view.count, committed: view.committed }
  }
  private get(id: string, committed = true): View {
    const view = this.views.get(id)
    if (view && Date.now() - view.touched > 10 * 60_000) this.drop(id)
    if (!view || this.retiring.has(id))
      throw new Error('Playlist view expired; rebuild its membership before retrying')
    if (committed && !view.committed) throw new Error('Playlist view upload is incomplete')
    view.touched = Date.now()
    return view
  }
  /** One bounded, synchronous transaction. The service requeues unfinished
   * requests after yielding; no SQLite transaction spans a yield. All readers
   * pass this gate, so partially rebuilt members are never published. */
  prepare(id: string, token?: symbol): { ready: boolean; token: symbol } {
    const view = this.get(id)
    if (token !== undefined && token !== view.token)
      throw new Error('Playlist view expired; rebuild its membership before retrying')
    const revision = this.owner.revision()
    if (view.build && view.build.revision !== revision) this.invalidate(view)
    if (view.revision === revision && !view.build) return { ready: true, token: view.token }
    try {
      const build = view.build ?? this.startBuild(view, revision)
      // Advance a private copy only after its writes commit. A failed batch can
      // be explicitly retried, without skipping definitions or serving old caches.
      const next = { ...build }
      const rows: Row[] = []
      if (next.keys === null) {
        rows.push(
          ...(this.owner
            .statement(
              'SELECT seq,id,snapshot,collection_id FROM playlist_definitions WHERE view_id=? AND seq>? ORDER BY seq LIMIT 200'
            )
            .all(id, next.cursor) as Row[])
        )
        if (rows.length) next.cursor = Number(rows.at(-1)!.seq)
      } else {
        let probes = 0
        while (next.keyIndex < next.keys.length && rows.length < 200 && probes++ < 200) {
          const key = next.keys[next.keyIndex],
            limit = 200 - rows.length
          const found = this.owner
            .statement(
              `SELECT seq,id,snapshot,collection_id FROM playlist_definitions WHERE view_id=? AND ${key.column}=? AND seq>? ORDER BY seq LIMIT ?`
            )
            .all(id, key.value, next.cursor, limit) as Row[]
          rows.push(...found)
          if (found.length < limit) {
            next.keyIndex++
            next.cursor = -1
          } else next.cursor = Number(found.at(-1)!.seq)
        }
      }
      const unique = [...new Map(rows.map((row) => [row.seq, row])).values()]
      if (unique.length) {
        this.owner.transaction(() => {
          this.owner
            .statement(
              `DELETE FROM playlist_members WHERE view_id=? AND seq IN
            (SELECT CAST(value AS INTEGER) FROM json_each(?))`
            )
            .run(id, JSON.stringify(unique.map((row) => row.seq)))
          this.materialize(id, unique, next.resolve, view.catalog, !view.preserveSources)
        })
        next.membershipChanged = true
      }
      const done = next.keys === null ? rows.length < 200 : next.keyIndex >= next.keys.length
      if (done) {
        view.revision = revision
        view.changeCursor = next.changeCursor
        view.build = undefined
        if (next.membershipChanged) {
          view.orders.clear()
          view.stats.clear()
        }
      } else view.build = next
      return { ready: done, token: view.token }
    } catch (error) {
      // Earlier batches may already be committed, so a failed build must start
      // from definitions, not incrementally patch an incomplete old projection.
      this.invalidate(view)
      throw error
    }
  }
  prepareQuery(query: LibraryQuery, token?: symbol): { ready: boolean; token: symbol } {
    const id = query.playlistView!,
      view = this.get(id)
    if (query.aggregate && (!view.preserveSources || view.catalog))
      throw new Error('Aggregate queries require a preserveSources detail view')
    const result = this.prepare(id, token)
    if (!result.ready) return result
    if (!query.aggregate)
      return {
        ready: view.catalog || this.prepareDetails(id),
        token: result.token
      }
    if (query.aggregate.sourceCounts) return result
    const ready = this.aggregates.prepare(id, this.owner.revision(), view.versions)
    return {
      ready:
        ready &&
        (query.aggregate.variantRow !== undefined
          ? this.aggregates.prepareVariants(query)
          : this.aggregates.prepareSelection(query)),
      token: result.token
    }
  }
  private prepareDetails(id: string): boolean {
    // Recording views need only resolved references/snapshots and duration;
    // grouping/search read their compact identities directly. Build ordinary
    // sort/filter columns and occurrence FTS only if that API is actually used.
    // Reuse the resolved IDs, not another lookup that could change membership.
    const rows = this.owner
      .statement(
        `SELECT m.seq,m.local_id,d.id,d.snapshot,d.collection_id FROM playlist_members m
        JOIN playlist_definitions d ON d.view_id=m.view_id AND d.seq=m.seq
        WHERE m.view_id=? AND m.collection_id IS NULL AND m.details_ready=0 ORDER BY m.seq LIMIT 200`
      )
      .all(id) as Row[]
    if (rows.length)
      this.owner.transaction(() => {
        this.owner
          .statement(
            `DELETE FROM playlist_members WHERE view_id=? AND seq IN
            (SELECT CAST(value AS INTEGER) FROM json_each(?))`
          )
          .run(id, JSON.stringify(rows.map((row) => row.seq)))
        this.materialize(
          id,
          rows,
          () => rows.map((row) => (row.local_id === null ? null : text(row.local_id))),
          false,
          true
        )
      })
    return rows.length < 200
  }
  private invalidate(view: View) {
    view.revision = -1
    view.build = undefined
    view.orders.clear()
    view.stats.clear()
  }
  private startBuild(view: View, revision: number): Build {
    const resolve = createPlaylistTrackLookup(this.owner.sql, view)
    const changes = this.owner
      .statement('SELECT seq,payload FROM playlist_changes WHERE seq>? ORDER BY seq')
      .all(view.changeCursor) as Row[]
    const incremental =
      view.revision >= 0 && (!changes.length || Number(changes[0].seq) === view.changeCursor + 1)
    let keys: RefreshKey[] | null = null
    if (incremental) {
      const ids = new Set<string>(),
        recordingKeys = new Set<string>()
      for (const change of changes) {
        const identity = JSON.parse(text(change.payload)) as RecordingIdentity
        if (identity.subTrack === null) delete identity.subTrack
        if (identity.cueRange === null) delete identity.cueRange
        ids.add(identity.id)
        recordingKeys.add(resolve.recordingKey(identity))
      }
      keys = [
        ...[...ids].map((value) => ({ column: 'id' as const, value })),
        ...[...recordingKeys].map((value) => ({ column: 'recording_key' as const, value }))
      ]
    }
    return {
      revision,
      resolve,
      keys,
      keyIndex: 0,
      cursor: -1,
      changeCursor: changes.length ? Number(changes.at(-1)!.seq) : view.changeCursor,
      membershipChanged: !incremental
    }
  }
  private ensure(id: string): View {
    while (!this.prepare(id).ready) {
      /* Direct synchronous compatibility entry point. */
    }
    return this.get(id)
  }
  private materialize(
    id: string,
    rows: Row[],
    resolve: (...args: Parameters<Lookup>) => ReturnType<Lookup>,
    catalog: boolean,
    fullDetails: boolean
  ): void {
    const entries = rows.map((row) => ({
      id: text(row.id),
      snapshot: row.snapshot ? (JSON.parse(text(row.snapshot)) as LibraryTrackRecord) : undefined
    }))
    const ids = resolve(
      entries as Array<{ id: string; snapshot?: LibraryTrackRecord & RecordingIdentity }>
    ).map((id, i) => (entries[i].snapshot?.externalEntry ? null : id))
    if (catalog || !fullDetails) {
      // Catalogs and recording views do not use ordinary per-member sort/filter
      // columns or FTS. Catalogs also need no remote snapshot for hydration.
      this.owner
        .statement(
          `INSERT INTO playlist_members(view_id,seq,collection_id,id,local_id,provider,duration,details_ready)
        SELECT ?,CAST(json_extract(j.value,'$.seq') AS INTEGER),json_extract(j.value,'$.collectionId'),t.id,t.id,'local',t.duration,?
        FROM json_each(?) j CROSS JOIN tracks t ON t.id=json_extract(j.value,'$.id')`
        )
        .run(
          id,
          catalog ? 1 : 0,
          JSON.stringify(
            ids.map((trackId, i) => ({
              id: trackId,
              seq: rows[i].seq,
              collectionId: rows[i].collection_id
            }))
          )
        )
      const remote: Array<{
        seq: number
        collectionId: string | number | null
        id: string
        snapshot: string | null
        source: string
        duration: number
      }> = []
      for (let i = 0; i < entries.length; i++) {
        const snapshot = entries[i].snapshot
        if (!ids[i] && snapshot && (snapshot.externalEntry || getTrackSource(snapshot) !== 'local'))
          remote.push({
            seq: Number(rows[i].seq),
            collectionId: rows[i].collection_id,
            id: snapshot.id,
            snapshot: catalog ? null : text(rows[i].snapshot),
            source: getTrackSource(snapshot),
            duration: n(snapshot.duration)
          })
      }
      // Definitions already bound this turn to 200 occurrences. Step one SQL
      // statement for the batch, retaining the same row triggers and rollback.
      if (remote.length)
        this.owner
          .statement(
            `INSERT INTO playlist_members(view_id,seq,collection_id,id,snapshot,provider,duration,details_ready)
          SELECT ?,json_extract(value,'$.seq'),json_extract(value,'$.collectionId'),json_extract(value,'$.id'),
            json_extract(value,'$.snapshot'),json_extract(value,'$.source'),json_extract(value,'$.duration'),?
          FROM json_each(?)`
          )
          .run(id, catalog ? 1 : 0, JSON.stringify(remote))
      return
    }
    const local = this.owner.statement(`INSERT INTO playlist_members(
      view_id,seq,collection_id,id,local_id,snapshot,payload,title,artist,album,format,album_key,folder,provider,search_text,search_file,
      duration,sample_rate,bit_depth,added_at,disc_no,track_no,file_name,lossless,dsd)
      SELECT ?,CAST(json_extract(j.value,'$.seq') AS INTEGER),json_extract(j.value,'$.collectionId'),t.id,t.id,NULL,
      json_object('filePath',json_extract(t.payload,'$.filePath'),'dir',json_extract(t.payload,'$.dir'),
        'artists',json_extract(t.payload,'$.artists'),'genre',json_extract(t.payload,'$.genre')),
      t.title,t.artist,t.album,t.format,t.album_key,t.folder,'local',t.search_text,t.search_file,
      t.duration,t.sample_rate,t.bit_depth,t.added_at,t.disc_no,t.track_no,t.file_name,t.lossless,t.dsd
      FROM json_each(?) j CROSS JOIN tracks t ON t.id=json_extract(j.value,'$.id')`)
    const remote = this.owner.statement(`INSERT INTO playlist_members(
      view_id,seq,collection_id,id,local_id,snapshot,payload,title,artist,album,format,album_key,folder,provider,search_text,search_file,
      duration,sample_rate,bit_depth,added_at,disc_no,track_no,file_name,lossless,dsd)
      VALUES(?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    local.run(
      id,
      JSON.stringify(
        ids.map((trackId, i) => ({
          seq: Number(rows[i].seq),
          id: trackId,
          collectionId: rows[i].collection_id
        }))
      )
    )
    for (let i = 0; i < entries.length; i++) {
      const snapshot = entries[i].snapshot
      if (ids[i] || !snapshot || (!snapshot.externalEntry && getTrackSource(snapshot) === 'local'))
        continue
      const title = text(snapshot.title).trim(),
        artist = text(snapshot.artist).trim(),
        album = text(snapshot.album).trim()
      const format = text(snapshot.format).trim(),
        payload = JSON.stringify(snapshot)
      remote.run(
        id,
        Number(rows[i].seq),
        rows[i].collection_id,
        snapshot.id,
        payload,
        payload,
        title,
        artist,
        album,
        format,
        getAlbumIdentity({
          filePath: snapshot.filePath,
          album,
          artist,
          albumId: text(snapshot.albumId),
          albumArtist: text(snapshot.albumArtist),
          dir: text(snapshot.dir)
        }),
        normalizeLibraryFilePath(
          text(snapshot.dir) || snapshot.filePath.replace(/[\\/][^\\/]*$/, '')
        ),
        getTrackSource(snapshot),
        [
          ...[title, artist, album].map(normalize),
          ...[title, artist, album].map(getPinyinInitials)
        ].join('\u001f'),
        normalize(text(snapshot.fileName)),
        n(snapshot.duration),
        n(snapshot.sampleRate),
        n(snapshot.bitDepth),
        n(snapshot.addedAt),
        albumOrderIndex(typeof snapshot.discNumber === 'number' ? snapshot.discNumber : undefined),
        albumOrderIndex(
          typeof snapshot.trackNumber === 'number' ? snapshot.trackNumber : undefined
        ),
        text(snapshot.fileName),
        lossless.has(format.toLowerCase()) || n(snapshot.bitDepth) >= 16 ? 1 : 0,
        ['dsf', 'dff', 'dsd', 'sacd iso'].includes(format.toLowerCase()) ? 1 : 0
      )
    }
  }
  private scope(query: LibraryQuery) {
    if (query.sort === 'unifiedSearch')
      throw new Error('Unified search ordering is not a playlist view sort')
    const where = this.owner.where(query)
    return {
      sql: `${where.sql || 'WHERE 1'} AND view_id=?`,
      params: [...where.params, query.playlistView!]
    }
  }
  private source = `(SELECT m.*,COALESCE(h.last_played,0) AS last_played FROM playlist_members m LEFT JOIN library_history h ON h.id=m.id)`
  private order(query: LibraryQuery, view: View): number[] {
    const { sql, params } = this.scope(query),
      sort = query.sort ?? 'title'
    const direction =
      sort === 'recentlyAdded' || (sort !== 'playlist' && query.direction === 'desc') ? -1 : 1
    const key = JSON.stringify([
      sql,
      params,
      sort,
      direction,
      sort === 'lastPlayed' ? this.owner.historyRevision() : null
    ])
    const cached = view.orders.get(key)
    if (cached) {
      view.orders.delete(key)
      view.orders.set(key, cached)
      return cached
    }
    let members: number[]
    if (numeric[sort])
      members = (
        this.owner
          .statement(
            `SELECT seq FROM ${this.source} ${sql} ORDER BY ${numeric[sort]} ${direction < 0 ? 'DESC' : 'ASC'},seq ${sort === 'recentlyAdded' ? 'DESC' : 'ASC'}`
          )
          .all(...params) as Row[]
      ).map((row) => Number(row.seq))
    else {
      const column = strings[sort] ?? 'title'
      const rows = this.owner
        .statement(
          `SELECT seq,${column} AS value${sort === 'trackNumber' ? ',disc_no,track_no,file_name,title' : ''} FROM ${this.source} ${sql}`
        )
        .all(...params) as Row[]
      rows.sort(
        (a, b) =>
          (sort === 'trackNumber'
            ? Number(a.disc_no) - Number(b.disc_no) ||
              Number(a.track_no) - Number(b.track_no) ||
              natural.compare(text(a.file_name), text(b.file_name)) ||
              collator.compare(text(a.title), text(b.title))
            : collator.compare(text(a.value), text(b.value))) * direction ||
          Number(a.seq) - Number(b.seq)
      )
      members = rows.map((row) => Number(row.seq))
    }
    view.orders.set(key, members)
    while (view.orders.size > 3) view.orders.delete(view.orders.keys().next().value!)
    return members
  }
  query(query: LibraryQuery): LibraryPage {
    if (this.get(query.playlistView!).catalog)
      throw new Error('Playlist catalogs support summaries, not track queries')
    while (!this.prepareQuery(query).ready) {
      /* Internal synchronous compatibility entry point. */
    }
    if (query.aggregate) return this.aggregatePage(query)
    const view = this.get(query.playlistView!),
      { offset, limit } = libraryPageBounds(query.offset, query.limit)
    const where = this.scope(query),
      sort = query.sort ?? 'title',
      column = numeric[sort]
    const statsKey = JSON.stringify([where.sql, where.params])
    let stats = view.stats.get(statsKey)
    if (!stats) {
      const row = this.owner
        .statement(
          `SELECT count(*) AS n,sum(CASE WHEN duration>0 THEN duration ELSE 0 END) AS duration FROM playlist_members ${where.sql}`
        )
        .get(...where.params) as Row
      stats = { total: Number(row.n), duration: Number(row.duration) }
      view.stats.set(statsKey, stats)
      while (view.stats.size > 32) view.stats.delete(view.stats.keys().next().value!)
    }
    let start = offset,
      anchorIndex: number | undefined,
      members: number[]
    if (query.anchorId !== undefined || query.playlistEntryId !== undefined || !column) {
      const order = this.order(query, view)
      if (query.anchorId !== undefined || query.playlistEntryId !== undefined) {
        const member =
          query.playlistEntryId === undefined
            ? (
                this.owner
                  .statement(
                    `SELECT seq FROM playlist_members WHERE view_id=? AND id=? ORDER BY seq LIMIT 1`
                  )
                  .get(query.playlistView!, query.anchorId!) as Row | undefined
              )?.seq
            : Number(query.playlistEntryId)
        anchorIndex = member === undefined ? -1 : order.indexOf(Number(member))
        if (anchorIndex >= 0) start = Math.floor(anchorIndex / limit) * limit
      }
      members = order.slice(start, start + limit)
    } else
      members = (
        this.owner
          .statement(
            `SELECT seq FROM ${this.source} ${where.sql} ORDER BY ${column} ${sort === 'recentlyAdded' || (sort !== 'playlist' && query.direction === 'desc') ? 'DESC' : 'ASC'},seq ${sort === 'recentlyAdded' ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?`
          )
          .all(...where.params, limit, start) as Row[]
      ).map((row) => Number(row.seq))
    const page = this.hydrate(query.playlistView!, members)
    return {
      ...page,
      total: stats.total,
      totalDuration: stats.duration,
      offset: start,
      ...(anchorIndex !== undefined ? { anchorIndex } : {})
    }
  }
  private hydrate(id: string, members: number[]): LibraryPage {
    const rows = this.owner
      .statement(
        `SELECT m.seq,m.id,COALESCE(m.snapshot,t.payload) AS payload,COALESCE(t.version,0) AS version
      FROM json_each(?) j CROSS JOIN playlist_members m ON m.view_id=? AND m.seq=CAST(j.value AS INTEGER)
      LEFT JOIN tracks t ON t.id=m.local_id ORDER BY CAST(j.key AS INTEGER)`
      )
      .all(JSON.stringify(members), id) as Row[]
    const versions: Record<string, number> = Object.create(null)
    for (const row of rows) if (Number(row.version)) versions[text(row.id)] = Number(row.version)
    return {
      tracks: rows.map((row) => JSON.parse(text(row.payload)) as LibraryTrackRecord),
      versions,
      entryIds: rows.map((row) => String(row.seq)),
      total: members.length,
      offset: 0,
      revision: this.owner.revision(),
      historyRevision: this.owner.historyRevision()
    }
  }
  private aggregatePage(query: LibraryQuery): LibraryPage {
    const id = query.playlistView!,
      { offset, limit } = libraryPageBounds(query.offset, query.limit)
    if (query.aggregate!.sourceCounts) {
      const rows = this.owner
        .statement(
          'SELECT provider,count(*) AS n FROM playlist_members WHERE view_id=? GROUP BY provider'
        )
        .all(id) as Row[]
      const hidden = new Set(query.aggregate!.hiddenSources ?? [])
      const counts = new Map(rows.map((row) => [text(row.provider), Number(row.n)]))
      for (const source of hidden) if (!counts.has(source)) counts.set(source, 0)
      const sources = [...counts]
        .map(([source, count]) => ({ source, count, hidden: hidden.has(source) }))
        .sort((a, b) =>
          a.source === b.source
            ? 0
            : a.source === 'local'
              ? -1
              : b.source === 'local'
                ? 1
                : a.source.localeCompare(b.source, 'en')
        )
      return {
        ...this.hydrate(id, []),
        offset,
        total: sources.length,
        aggregate: {
          rows: [],
          rowCount: 0,
          memberCount: rows.reduce((sum, row) => sum + Number(row.n), 0),
          sources: sources.slice(offset, offset + limit)
        }
      }
    }
    if (query.aggregate!.variantRow !== undefined) {
      const members = this.aggregates.variants(query)
      return {
        ...this.hydrate(id, members.slice(offset, offset + limit)),
        offset,
        total: members.length,
        aggregate: { rows: [], rowCount: 0, memberCount: members.length }
      }
    }
    const selection = this.aggregates.selection(query)
    let start = offset,
      anchorIndex: number | undefined
    if (query.playlistEntryId !== undefined || query.anchorId !== undefined) {
      anchorIndex = selection.rows.findIndex((row) =>
        query.playlistEntryId !== undefined
          ? row.seq === Number(query.playlistEntryId)
          : (
              this.owner
                .statement('SELECT id FROM playlist_members WHERE view_id=? AND seq=?')
                .get(id, row.seq) as Row
            )?.id === query.anchorId
      )
      if (anchorIndex >= 0) start = Math.floor(anchorIndex / limit) * limit
    }
    const window = selection.rows.slice(start, start + limit)
    return {
      ...this.hydrate(
        id,
        window.map((row) => row.seq)
      ),
      offset: start,
      total: selection.rows.length,
      totalDuration: selection.duration,
      aggregate: {
        rows: window.map((row) => row.meta),
        rowCount: selection.rowCount,
        memberCount: selection.memberCount
      },
      ...(anchorIndex !== undefined ? { anchorIndex } : {})
    }
  }
  queuePlan(query: LibraryQuery, selectedId?: string): PlaylistQueuePlan {
    if (this.get(query.playlistView!).catalog)
      throw new Error('Playlist catalogs cannot be used as playback queues')
    if (query.aggregate?.variantRow !== undefined || query.aggregate?.sourceCounts)
      throw new Error('Aggregate variant/source pages cannot create playback queues')
    while (!this.prepareQuery(query).ready) {
      /* Synchronous compatibility. */
    }
    const view = this.get(query.playlistView!)
    const members = query.aggregate
      ? this.aggregates
          .selection(query)
          .rows.filter((row) => !row.meta.preferenceUnavailable)
          .map((row) => row.seq)
      : (() => {
          const metadataRows = new Set(
            (
              this.owner
                .statement(
                  "SELECT seq FROM playlist_members WHERE view_id=? AND json_extract(snapshot,'$.externalEntry') IS NOT NULL"
                )
                .all(query.playlistView!) as Row[]
            ).map((row) => Number(row.seq))
          )
          return this.order(query, view).filter((seq) => !metadataRows.has(seq))
        })()
    let index = 0
    if (query.playlistEntryId !== undefined) {
      index = members.indexOf(Number(query.playlistEntryId))
      const row = this.owner
        .statement('SELECT id FROM playlist_members WHERE view_id=? AND seq=?')
        .get(query.playlistView!, Number(query.playlistEntryId)) as Row | undefined
      if (selectedId && row?.id !== selectedId)
        throw new Error('Selected playlist occurrence no longer matches the track')
    } else if (selectedId) {
      const occurrences = new Set(
        (
          this.owner
            .statement('SELECT seq FROM playlist_members WHERE view_id=? AND id=?')
            .all(query.playlistView!, selectedId) as Row[]
        ).map((row) => Number(row.seq))
      )
      index = members.findIndex((member) => occurrences.has(member))
    }
    if (index < 0) throw new Error('Selected track is not in the playlist query')
    return { viewId: query.playlistView!, members, index }
  }
  collections(query: LibraryQuery): LibraryCollectionPage {
    if (!this.get(query.playlistView!).catalog)
      throw new Error('Playlist summaries require a catalog view')
    const allowed = new Set([
      'playlistView',
      'search',
      'searchLiteral',
      'offset',
      'limit',
      'contentRevision',
      'collectionOrder',
      'collectionCountOnly',
      'genreSeparators'
    ])
    if (Object.entries(query).some(([key, value]) => value !== undefined && !allowed.has(key)))
      throw new Error('Unsupported playlist catalog query scope')
    this.ensure(query.playlistView!)
    const id = query.playlistView!,
      { offset, limit } = libraryPageBounds(query.offset, query.limit),
      search = query.searchLiteral
        ? (query.search?.trim() ?? '').toLocaleLowerCase('zh-CN')
        : normalize(query.search?.trim() ?? '')
    const scope = query.searchLiteral
      ? "WHERE g.view_id=? AND library_metadata_contains(g.name,'','',?)=1"
      : 'WHERE g.view_id=? AND instr(g.search_name,?)>0'
    const total = Number(
      (
        this.owner
          .statement(`SELECT count(*) AS n FROM playlist_groups g ${scope}`)
          .get(id, search) as Row
      ).n
    )
    const rows = query.collectionCountOnly
      ? []
      : (this.owner
          .statement(
            `WITH card_order AS (
        SELECT value AS id,min(CAST(key AS INTEGER)) AS rank FROM json_each(?) GROUP BY value)
      SELECT g.id,g.name,g.cover,g.is_default,g.track_count,g.local_count,g.duration FROM playlist_groups g
      LEFT JOIN card_order o ON o.id=g.id ${scope}
      ORDER BY COALESCE(o.rank,1000000+g.seq),g.seq LIMIT ? OFFSET ?`
          )
          .all(JSON.stringify(query.collectionOrder ?? []), id, search, limit, offset) as Row[])
    const sources = this.owner.statement(`SELECT source,count FROM playlist_group_sources
      WHERE view_id=? AND collection_id=? AND source<>'local' ORDER BY source LIMIT 20`)
    const sourceCount = this.owner.statement(`SELECT count(*) AS n FROM playlist_group_sources
      WHERE view_id=? AND collection_id=? AND source<>'local'`)
    // SQL owns membership and totals. Only a page of headers and twenty provider
    // labels per card crosses IPC; no members (including snapshots) are hydrated.
    return {
      items: rows.map((row) => {
        const local = Number(row.local_count),
          provider = Number(row.track_count) - local,
          providerCount = Number((sourceCount.get(id, text(row.id)) as Row).n)
        const providers: LibraryPlaylistSourceSummary['providers'] = (
          sources.all(id, text(row.id)) as Row[]
        ).map((source) => ({ source: text(source.source), count: Number(source.count) }))
        return {
          id: text(row.id),
          name: text(row.name),
          cover: row.cover === null ? null : text(row.cover),
          isDefault: !!row.is_default,
          trackCount: Number(row.track_count),
          duration: Math.max(0, Number(row.duration)),
          sourceSummary: {
            total: Number(row.track_count),
            local,
            provider,
            providers,
            ...(providerCount > providers.length
              ? { additionalProviders: providerCount - providers.length }
              : {})
          }
        }
      }),
      total,
      revision: this.owner.revision(),
      offset,
      letterOffsets: {}
    }
  }
}
