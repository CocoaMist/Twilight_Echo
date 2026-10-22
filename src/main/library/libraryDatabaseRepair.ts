import type { DatabaseSync } from 'node:sqlite'
import type { LibraryTrackRecord } from '../../shared/libraryDatabase.ts'
import {
  validateRepairTracks,
  type LibraryRepairCandidateCommand,
  type LibraryRepairCandidateReply,
  type LibraryPlaylistRelocations
} from '../../shared/playlistRepair.ts'
import { compactPlaylistRecord } from '../../shared/playlistSnapshot.ts'

const pathKey = (value: string) =>
  value.trim().replace(/\//g, '\\').replace(/\\+/g, '\\').toLocaleLowerCase('en-US')
const filename = (value: string) =>
  value.replace(/\\/g, '/').split('/').pop()!.toLocaleLowerCase('en-US')
const metadataKey = (value: string) => value.trim().toLocaleLowerCase()

/** Complete, disk-backed candidate index. It never touches canonical tracks,
 * revisions, scan checkpoints or backups, and vanishes with the SQL process. */
export class LibraryDatabaseRepair {
  private session: { id: string; sequence: number; sealed: boolean; count: number } | null = null
  private readonly sql: DatabaseSync
  private readonly transaction: <T>(action: () => T) => T
  constructor(sql: DatabaseSync, transaction: <T>(action: () => T) => T) {
    this.sql = sql
    this.transaction = transaction
  }

  execute(command: LibraryRepairCandidateCommand): LibraryRepairCandidateReply {
    if (command.kind === 'begin') {
      if (this.session) throw new Error('歌单修复候选索引正在使用')
      this.sql.exec(`CREATE TEMP TABLE IF NOT EXISTS repair_candidates(
        seq INTEGER PRIMARY KEY, id TEXT NOT NULL, path TEXT NOT NULL, filename TEXT NOT NULL,
        title TEXT NOT NULL, artist TEXT NOT NULL, duration REAL NOT NULL, payload TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS temp.repair_path ON repair_candidates(path);
        CREATE INDEX IF NOT EXISTS temp.repair_filename ON repair_candidates(filename,used,seq);
        CREATE INDEX IF NOT EXISTS temp.repair_metadata ON repair_candidates(title,artist,used,duration);
        CREATE INDEX IF NOT EXISTS temp.repair_id ON repair_candidates(id);
        DELETE FROM repair_candidates;`)
      this.session = { id: command.id, sequence: 0, sealed: false, count: 0 }
      return { count: 0 }
    }
    if (command.kind === 'close') {
      if (this.session?.id === command.id) {
        this.sql.exec('DELETE FROM repair_candidates;')
        this.session = null
      }
      return { count: 0 }
    }
    const session = this.session
    if (!session || session.id !== command.id) throw new Error('歌单修复会话已失效，请重新扫描')
    if (command.sequence !== session.sequence + 1) throw new Error('歌单修复批次已失效，请重新扫描')
    let result: LibraryPlaylistRelocations | undefined
    if (command.kind === 'append') {
      if (session.sealed) throw new Error('歌单修复扫描已经结束')
      validateRepairTracks(command.tracks)
      const insert = this.sql.prepare(
        'INSERT INTO repair_candidates(seq,id,path,filename,title,artist,duration,payload) VALUES(?,?,?,?,?,?,?,?)'
      )
      let count = session.count
      this.transaction(() => {
        for (const raw of command.tracks) {
          const track = compactPlaylistRecord(raw)
          insert.run(
            ++count,
            track.id,
            pathKey(track.filePath),
            filename(track.filePath),
            metadataKey(String(track.title)),
            metadataKey(String(track.artist)),
            Number(track.duration || 0),
            JSON.stringify(track)
          )
        }
      })
      session.count = count
    } else if (command.kind === 'seal') {
      if (session.sealed) throw new Error('歌单修复扫描已经结束')
      session.sealed = true
    } else {
      if (!session.sealed) throw new Error('候选扫描尚未完成，不能确定唯一匹配')
      validateRepairTracks(command.missing)
      result = this.transaction(() => this.resolve(command.missing))
    }
    session.sequence = command.sequence
    return { count: session.count, ...(result ? { result } : {}) }
  }

  private resolve(missing: LibraryTrackRecord[]): LibraryPlaylistRelocations {
    const result: LibraryPlaylistRelocations = {
      relocations: [],
      unresolvedTrackIds: [],
      ambiguousTrackIds: []
    }
    const exact = this.sql.prepare('SELECT 1 FROM repair_candidates WHERE path=? LIMIT 1')
    const available = ' AND used=0 ORDER BY c.seq LIMIT 2'
    const byName = this.sql.prepare(
      'SELECT payload FROM repair_candidates c WHERE filename=?' + available
    )
    const byMetadata = this.sql.prepare(
      'SELECT payload FROM repair_candidates c WHERE title=? AND artist=? AND duration BETWEEN ? AND ?' +
        available
    )
    const consume = this.sql.prepare('UPDATE repair_candidates SET used=1 WHERE id=?')
    for (const track of missing) {
      if (exact.get(pathKey(track.filePath))) continue
      const names = byName.all(filename(track.filePath || String(track.fileName || '')))
      const duration = Number(track.duration || 0)
      const matches =
        names.length === 1
          ? names
          : byMetadata.all(
              metadataKey(String(track.title)),
              metadataKey(String(track.artist)),
              duration - 2,
              duration + 2
            )
      if (matches.length === 1) {
        const candidate = JSON.parse(String(matches[0].payload)) as LibraryTrackRecord
        consume.run(candidate.id)
        result.relocations.push({ trackId: track.id, fromPath: track.filePath, toTrack: candidate })
      } else if (matches.length > 1 || names.length > 1) result.ambiguousTrackIds.push(track.id)
      else result.unresolvedTrackIds.push(track.id)
    }
    return result
  }
}
