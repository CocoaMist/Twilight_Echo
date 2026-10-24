import type { DatabaseSync } from 'node:sqlite'
import type {
  LibraryHistorySyncRequest,
  LibraryHistorySyncResult
} from '../../shared/libraryDatabase.ts'
import { validateLibraryHistorySync } from './libraryDatabaseValidation.ts'

export const LIBRARY_HISTORY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS library_history(id TEXT PRIMARY KEY,last_played REAL NOT NULL);
  INSERT OR IGNORE INTO meta VALUES('history_revision','0');
  DROP TRIGGER IF EXISTS tracks_au;
  CREATE TRIGGER tracks_au AFTER UPDATE OF payload,file_key ON tracks BEGIN
    INSERT INTO track_search(track_search,rowid,search_text,search_file) VALUES('delete',old.seq,old.search_text,old.search_file);
    INSERT INTO track_search(rowid,search_text,search_file) VALUES(new.seq,new.search_text,new.search_file);
    UPDATE files SET content_version=content_version+1 WHERE file_key=new.file_key;
  END;
`

/** Core listening statistics remain the history authority. This is a durable, atomic lightweight
 * projection for indexed library ordering, not a second listening-statistics store. */
export class LibraryDatabaseHistory {
  private stage: {
    id: string
    mode: 'replace' | 'patch'
    sequence: number
    expectedRevision?: number
  } | null = null
  private receipt: LibraryHistorySyncResult | null = null
  private readonly owner: {
    sql: DatabaseSync
    transaction<T>(action: () => T): T
  }
  constructor(owner: LibraryDatabaseHistory['owner']) {
    this.owner = owner
  }

  get revision(): number {
    return Number(
      this.owner.sql.prepare("SELECT value FROM meta WHERE key='history_revision'").get()?.value
    )
  }

  sync(request: LibraryHistorySyncRequest): LibraryHistorySyncResult {
    validateLibraryHistorySync(request)
    const { sql } = this.owner
    if (request.kind === 'begin') {
      if (request.mode === 'patch' && request.expectedRevision !== this.revision)
        throw new Error(
          'Listening history changed concurrently; replace its projection before retrying'
        )
      this.owner.transaction(() =>
        sql.exec(
          'CREATE TEMP TABLE IF NOT EXISTS history_staging(id TEXT PRIMARY KEY,last_played REAL NOT NULL); DELETE FROM history_staging;'
        )
      )
      this.stage = {
        id: request.id,
        mode: request.mode,
        sequence: 0,
        expectedRevision: request.expectedRevision
      }
      this.receipt = null
      return { id: request.id, sequence: 0, revision: this.revision, committed: false }
    }
    if (
      request.kind === 'commit' &&
      this.receipt?.id === request.id &&
      this.receipt.sequence === request.sequence
    )
      return { ...this.receipt }
    const stage = this.stage
    if (!stage || stage.id !== request.id || request.sequence !== stage.sequence + 1)
      throw new Error('History projection session or sequence expired; start a new projection')
    if (request.kind === 'append') {
      this.owner.transaction(() => {
        const insert = sql.prepare('INSERT OR REPLACE INTO history_staging VALUES(?,?)')
        for (const entry of request.entries) insert.run(entry.id, entry.lastPlayed)
      })
      stage.sequence = request.sequence
      return {
        id: request.id,
        sequence: request.sequence,
        revision: this.revision,
        committed: false
      }
    }
    const result = this.owner.transaction(() => {
      if (stage.mode === 'patch' && stage.expectedRevision !== this.revision)
        throw new Error(
          'Listening history changed concurrently; replace its projection before retrying'
        )
      const changed = sql
        .prepare(
          `SELECT 1 FROM history_staging s LEFT JOIN library_history h USING(id)
        WHERE s.last_played<>COALESCE(h.last_played,0)
        ${stage.mode === 'replace' ? 'UNION ALL SELECT 1 FROM library_history WHERE id NOT IN (SELECT id FROM history_staging)' : ''} LIMIT 1`
        )
        .get()
      if (changed) {
        if (stage.mode === 'replace')
          sql.exec('DELETE FROM library_history WHERE id NOT IN (SELECT id FROM history_staging);')
        sql.exec(`DELETE FROM library_history WHERE id IN (SELECT id FROM history_staging WHERE last_played=0);
          INSERT INTO library_history SELECT id,last_played FROM history_staging WHERE last_played>0
          ON CONFLICT(id) DO UPDATE SET last_played=excluded.last_played;
          UPDATE tracks SET last_played=COALESCE((SELECT last_played FROM library_history h WHERE h.id=tracks.id),0)
          WHERE ${stage.mode === 'patch' ? 'id IN (SELECT id FROM history_staging) AND ' : ''}
          last_played<>COALESCE((SELECT last_played FROM library_history h WHERE h.id=tracks.id),0);
          UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='history_revision';`)
      }
      sql.exec('DELETE FROM history_staging;')
      return {
        id: request.id,
        sequence: request.sequence,
        revision: this.revision,
        committed: true
      }
    })
    this.stage = null
    this.receipt = result
    return { ...result }
  }
}
