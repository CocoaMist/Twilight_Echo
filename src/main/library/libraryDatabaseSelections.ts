import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { LIBRARY_PAGE_SIZE, type LibraryPage } from '../../shared/libraryDatabase.ts'
import type {
  LibrarySelectionPage,
  LibrarySelectionRequest,
  LibrarySelectionSnapshot
} from '../../shared/librarySelection.ts'
import { compactPlaylistRecord } from '../../shared/playlistSnapshot.ts'
import { getTrackSource } from '../../shared/trackSourceIdentity.ts'
import { normalizeLibraryFilePath } from './libraryRepository.ts'
import { validateLibraryQuery } from './libraryDatabaseValidation.ts'

type Owner = {
  sql: DatabaseSync
  transaction<T>(action: () => T): T
  query(request: LibrarySelectionRequest, offset: number, limit: number): LibraryPage
}
export type LibrarySelectionBuild = {
  id: string
  request: LibrarySelectionRequest
  range: number
  offset: number
}
type Session = {
  build: LibrarySelectionBuild
  snapshot: LibrarySelectionSnapshot
  count: number
  ready: boolean
  retiring: boolean
  touched: number
}
const LEASE_MS = 120_000
const MAX_SESSIONS = 4

export function validateLibrarySelection(value: unknown): asserts value is LibrarySelectionRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid library selection')
  const request = value as LibrarySelectionRequest
  validateLibraryQuery(request.query)
  if (
    !Number.isSafeInteger(request.query.contentRevision) ||
    request.query.contentRevision < 0 ||
    (request.query.sort === 'lastPlayed' && request.query.historyRevision === undefined) ||
    !Number.isSafeInteger(request.total) ||
    request.total < 0 ||
    !Array.isArray(request.ranges) ||
    request.ranges.length > 4096 ||
    // Selection positions describe the complete table, never a located page or
    // aggregate recording/source-count view with different occurrence semantics.
    ['offset', 'limit', 'anchorId', 'playlistEntryId', 'aggregate'].some(
      (key) => request.query[key as keyof typeof request.query] !== undefined
    )
  )
    throw new Error('Invalid library selection scope')
  let previousEnd = -1
  for (const range of request.ranges) {
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      !range.every(Number.isSafeInteger) ||
      range[0] <= previousEnd ||
      range[0] < 0 ||
      range[1] <= range[0] ||
      range[1] > request.total
    )
      throw new Error('Invalid library selection ranges')
    previousEnd = range[1]
  }
}

/** Disposable action intent in the existing SQL owner. Only a 200-record batch
 * is hydrated at a time; no hidden playback queue or persistent library copy. */
export class LibraryDatabaseSelections {
  private readonly owner: Owner
  private readonly sessions = new Map<string, Session>()
  private initialized = false

  constructor(owner: Owner) {
    this.owner = owner
  }
  private initialize(): void {
    if (this.initialized) return
    this.owner.transaction(() =>
      this.owner.sql.exec(`CREATE TEMP TABLE selection_rows(
      lease TEXT NOT NULL,seq INTEGER NOT NULL,position INTEGER NOT NULL,
      entry_id TEXT,definition_id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,instance INTEGER,
      PRIMARY KEY(lease,seq));
      CREATE TEMP TABLE selection_files(
        lease TEXT NOT NULL,file_key TEXT NOT NULL,seq INTEGER NOT NULL,
        PRIMARY KEY(lease,file_key));
      CREATE UNIQUE INDEX temp.selection_files_order ON selection_files(lease,seq);`)
    )
    this.initialized = true
  }
  begin(input: LibrarySelectionRequest): LibrarySelectionBuild {
    validateLibrarySelection(input)
    this.expire()
    if (this.sessions.size >= MAX_SESSIONS)
      throw new Error('Too many track selections; wait for release or cleanup')
    this.initialize()
    const request = structuredClone(input),
      id = randomUUID(),
      build = { id, request, range: 0, offset: request.ranges[0]?.[0] ?? 0 }
    this.sessions.set(id, {
      build,
      snapshot: {
        id,
        revision: request.query.contentRevision,
        ...(request.query.sort === 'lastPlayed'
          ? { historyRevision: request.query.historyRevision }
          : {}),
        total: request.total,
        selectedCount: request.ranges.reduce((count, [start, end]) => count + end - start, 0),
        localTrackCount: 0,
        fileCount: 0
      },
      count: 0,
      ready: false,
      retiring: false,
      touched: Date.now()
    })
    return build
  }
  advance(
    build: LibrarySelectionBuild
  ): { ready: false } | { ready: true; snapshot: LibrarySelectionSnapshot } {
    const session = this.get(build.id)
    if (session.build !== build || session.ready)
      throw new Error('Selection build is no longer active')
    const { request } = build,
      range = request.ranges[build.range],
      limit = range ? Math.min(LIBRARY_PAGE_SIZE, range[1] - build.offset) : 1,
      page = this.owner.query(request, build.offset, limit)
    if (page.total !== request.total || page.revision !== request.query.contentRevision)
      throw new Error('Library selection changed; refresh before selecting again')
    if (range && (page.offset !== build.offset || page.tracks.length !== limit))
      throw new Error('Library selection page is incomplete')
    const definitions =
      request.query.playlistView && page.entryIds
        ? new Map(
            this.owner.sql
              .prepare(
                `SELECT seq,id FROM playlist_definitions
            WHERE view_id=? AND seq IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`
              )
              .all(request.query.playlistView, JSON.stringify(page.entryIds))
              .map((row) => [String(row.seq), String(row.id)])
          )
        : new Map<string, string>()
    const instances = new Map(
      this.owner.sql
        .prepare('SELECT id,seq FROM tracks WHERE id IN (SELECT value FROM json_each(?))')
        .all(JSON.stringify(page.tracks.map((track) => track.id)))
        .map((row) => [String(row.id), Number(row.seq)])
    )
    const insert = this.owner.sql.prepare('INSERT INTO selection_rows VALUES(?,?,?,?,?,?,?,?)'),
      insertFile = this.owner.sql.prepare('INSERT OR IGNORE INTO selection_files VALUES(?,?,?)')
    let localCount = 0,
      fileCount = 0
    this.owner.transaction(() => {
      // Empty selection still probes its content/count fence, but stores no row.
      for (let index = 0; range && index < page.tracks.length; index++) {
        const raw = page.tracks[index],
          track = compactPlaylistRecord(raw),
          entry = page.entryIds?.[index],
          seq = session.count + index,
          definitionId = entry === undefined ? track.id : definitions.get(entry)
        if (!definitionId) throw new Error('Playlist selection definition disappeared')
        for (const field of ['cover', 'coverSmall', 'coverSource', 'coverSmallSource'])
          if (typeof track[field] === 'string' && track[field].startsWith('data:'))
            delete track[field]
        insert.run(
          build.id,
          seq,
          build.offset + index,
          entry ?? null,
          definitionId,
          page.versions[track.id] ?? 0,
          JSON.stringify(track),
          getTrackSource(track) === 'local' ? (instances.get(track.id) ?? null) : null
        )
        if (getTrackSource(track) === 'local' && track.filePath) {
          localCount++
          fileCount += Number(
            insertFile.run(build.id, normalizeLibraryFilePath(track.filePath), seq).changes
          )
        }
      }
    })
    session.count += range ? page.tracks.length : 0
    session.snapshot.localTrackCount += localCount
    session.snapshot.fileCount += fileCount
    session.touched = Date.now()
    if (range) {
      build.offset += page.tracks.length
      if (build.offset === range[1]) {
        build.range++
        build.offset = request.ranges[build.range]?.[0] ?? 0
      }
    }
    if (build.range < request.ranges.length) return { ready: false }
    session.ready = true
    return { ready: true, snapshot: { ...session.snapshot } }
  }
  read(
    id: string,
    cursor = 0,
    projection: 'tracks' | 'files' = 'tracks',
    requireCurrent = false
  ): LibrarySelectionPage {
    const session = this.get(id)
    if (!session.ready) throw new Error('Track selection is not ready')
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      cursor > session.count ||
      (projection !== 'tracks' && projection !== 'files')
    )
      throw new Error('Invalid track selection cursor or projection')
    const source =
      projection === 'files'
        ? 'selection_files f JOIN selection_rows r ON r.lease=f.lease AND r.seq=f.seq'
        : 'selection_rows r'
    const rows = this.owner.sql
      .prepare(
        `SELECT r.* FROM ${source}
      WHERE r.lease=? AND r.seq>=? ORDER BY r.seq LIMIT ?`
      )
      .all(id, cursor, LIBRARY_PAGE_SIZE)
    if (requireCurrent) {
      const current = this.owner.sql.prepare('SELECT seq,version,file_key FROM tracks WHERE id=?')
      for (const row of rows) {
        const track = JSON.parse(String(row.payload)),
          actual = current.get(track.id)
        if (
          !actual ||
          Number(actual.seq) !== Number(row.instance) ||
          Number(actual.version) !== Number(row.version) ||
          actual.file_key !== normalizeLibraryFilePath(track.filePath)
        )
          throw Object.assign(new Error('曲目在选择后已变化，请重新选择'), {
            code: 'STALE_REVISION'
          })
      }
    }
    const next = rows.length ? Number(rows[rows.length - 1].seq) + 1 : session.count
    const more =
      next < session.count &&
      this.owner.sql
        .prepare(
          `SELECT 1 FROM ${source}
      WHERE r.lease=? AND r.seq>=? LIMIT 1`
        )
        .get(id, next)
    return {
      snapshot: { ...session.snapshot },
      rows: rows.map((row) => ({
        position: Number(row.position),
        ...(row.entry_id === null ? {} : { entryId: String(row.entry_id) }),
        definitionId: String(row.definition_id),
        track: JSON.parse(String(row.payload)),
        version: Number(row.version),
        ...(row.instance === null ? {} : { instance: Number(row.instance) })
      })),
      nextCursor: more ? next : null
    }
  }
  close(id: string): void {
    this.assertId(id)
    const session = this.sessions.get(id)
    if (session) session.retiring = true
  }
  private assertId(id: string): void {
    if (typeof id !== 'string' || !id || id.length > 128)
      throw new Error('Invalid track selection identity')
  }
  private get(id: string): Session {
    this.assertId(id)
    this.expire()
    const session = this.sessions.get(id)
    if (!session || session.retiring) throw new Error('Track selection expired; select again')
    session.touched = Date.now()
    return session
  }
  private expire(): void {
    const now = Date.now()
    for (const session of this.sessions.values())
      if (now - session.touched >= LEASE_MS) session.retiring = true
  }
  get needsMaintenance(): boolean {
    this.expire()
    return [...this.sessions.values()].some((session) => session.retiring)
  }
  maintenance(): void {
    this.expire()
    const session = [...this.sessions.values()].find((session) => session.retiring)
    if (!session) return
    const id = session.build.id
    const done = this.owner.transaction(() => {
      const rows = this.owner.sql
        .prepare('SELECT seq FROM selection_rows WHERE lease=? ORDER BY seq LIMIT ?')
        .all(id, LIBRARY_PAGE_SIZE)
        .map((row) => Number(row.seq))
      const ids = JSON.stringify(rows)
      this.owner.sql
        .prepare(
          'DELETE FROM selection_files WHERE lease=? AND seq IN (SELECT value FROM json_each(?))'
        )
        .run(id, ids)
      this.owner.sql
        .prepare(
          'DELETE FROM selection_rows WHERE lease=? AND seq IN (SELECT value FROM json_each(?))'
        )
        .run(id, ids)
      return rows.length < LIBRARY_PAGE_SIZE
    })
    if (done) this.sessions.delete(id)
  }
}
