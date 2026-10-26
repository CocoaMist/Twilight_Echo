import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { versionSourceKey, type TrackSourceIdentity } from '../../shared/trackSourceIdentity.ts'
import { normalizePortableLibraryPath } from '../../shared/playlistPaths.ts'
import {
  prepareSearchFieldsFromBlob,
  prepareSearchQuery,
  scorePreparedSearchRelevance,
  type SearchPersonalSignals
} from '../../shared/searchRelevance.ts'

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const titleOrder = new Intl.Collator('zh')
const idOrder = new Intl.Collator()

export interface UnifiedLibraryOrderOptions {
  search?: string
  typoPenaltyFactor?: number
  searchFileName?: boolean
}

function preferredIds(sql: DatabaseSync, sources: string[]): Set<string> {
  const paths = new Map<string, Set<string>>()
  for (const source of sources) {
    // Provider preferences cannot match a local recording. Old opaque keys
    // remain valid config but cannot equal today's canonical local source key.
    if (!source.startsWith('["local",')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch {
      continue
    }
    if (!Array.isArray(parsed) || typeof parsed[1] !== 'string') continue
    const path = normalizePortableLibraryPath(parsed[1]),
      keys = paths.get(path) ?? new Set<string>()
    keys.add(source)
    paths.set(path, keys)
  }
  const ids = new Set<string>()
  const lookup =
    sql.prepare(`SELECT id,json_object('id',id,'filePath',json_extract(payload,'$.filePath'),
    'subTrack',json_extract(payload,'$.subTrack'),'cueRange',json_extract(payload,'$.cueRange')) AS identity
    FROM tracks WHERE playlist_path=?`)
  for (const [path, keys] of paths)
    for (const row of lookup.iterate(path)) {
      const track = JSON.parse(text(row.identity)) as TrackSourceIdentity
      if (keys.has(versionSourceKey({ ...track, source: 'local' }))) ids.add(text(row.id))
    }
  return ids
}

/** Sort only candidate IDs and comparison keys. Preferences resolve through
 * the existing path index, not a second full-library identity projection. */
export function unifiedLibraryOrder(
  sql: DatabaseSync,
  where: string,
  params: SQLInputValue[],
  preferredSources: string[],
  direction: number,
  options?: UnifiedLibraryOrderOptions
): string[] {
  const preferred = preferredIds(sql, preferredSources)
  const preparedQuery = prepareSearchQuery(options?.search ?? '', options?.typoPenaltyFactor ?? 1)
  const rows: Array<{
    id: string
    seq: number
    lossless: number
    preferred: number
    score: number
    title: string
    artist: string
  }> = []
  for (const row of sql
    .prepare(
      `SELECT seq,id,lossless,search_text,search_file,
    json_extract(payload,'$.title') AS title,json_extract(payload,'$.artist') AS artist,
    json_extract(payload,'$.album') AS album,json_extract(payload,'$.fileName') AS file_name,
    CASE WHEN json_type(payload,'$.title') IS NOT 'text' AND json_type(payload,'$.fileName') IS NOT 'text'
      THEN json_extract(payload,'$.filePath') END AS fallback_path,
    json_extract(payload,'$.favorite') AS fav,json_extract(payload,'$.banned') AS banned,
    json_extract(payload,'$.playCount') AS play_count,json_extract(payload,'$.lastPlayed') AS payload_last_played
    FROM tracks ${where}`
    )
    .iterate(...params)) {
    const fileName =
      typeof row.file_name === 'string'
        ? row.file_name
        : text(row.fallback_path).split(/[\\/]/).pop() || text(row.id)
    const rawTitle = typeof row.title === 'string' ? row.title : ''
    const rawArtist = typeof row.artist === 'string' ? row.artist : ''
    const rawAlbum = typeof row.album === 'string' ? row.album : ''
    const rawFileName = typeof row.file_name === 'string' ? row.file_name : ''
    let score = 0
    if (preparedQuery.fullNormalized) {
      const fields = prepareSearchFieldsFromBlob(
        text(row.search_text),
        '\u001f',
        { title: rawTitle, artist: rawArtist, album: rawAlbum, fileName: rawFileName },
        text(row.search_file)
      )
      const signals: SearchPersonalSignals = {
        favorite: row.fav === 1,
        banned: row.banned === 1,
        playCount: typeof row.play_count === 'number' ? row.play_count : undefined,
        lastPlayed:
          typeof row.payload_last_played === 'number' ? row.payload_last_played : undefined
      }
      score = scorePreparedSearchRelevance(fields, preparedQuery, {
        searchFileName: options?.searchFileName ?? true,
        signals
      }).total
    }
    rows.push({
      id: text(row.id),
      seq: Number(row.seq),
      lossless: Number(row.lossless),
      preferred: preferred.has(text(row.id)) ? 1 : 0,
      score,
      title: typeof row.title === 'string' ? row.title : fileName,
      artist: typeof row.artist === 'string' ? row.artist : '未知艺术家'
    })
  }
  rows.sort(
    (left, right) =>
      (right.preferred - left.preferred ||
        right.score - left.score ||
        right.lossless - left.lossless ||
        titleOrder.compare(left.title, right.title) ||
        titleOrder.compare(left.artist, right.artist) ||
        idOrder.compare(left.id, right.id)) * direction || left.seq - right.seq
  )
  return rows.map((row) => row.id)
}
