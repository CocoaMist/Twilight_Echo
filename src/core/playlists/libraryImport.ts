import { LIBRARY_PAGE_SIZE, type LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import type { TrackData as Track } from '../../shared/track.ts'
import { libraryTrack } from '../playback/libraryTrack.ts'
import { toPlaylistTrackSnapshot } from './data.ts'

/** Match only the requested paths. One read at a time, bounded full-record
 * windows, and one content revision for the entire import transaction. */
export async function resolveLibraryPlaylistImportPaths(
  paths: readonly string[],
  api: Pick<LibraryDatabaseApi, 'lookupTracksByPaths' | 'getTracksByIds' | 'getMetadata'>
): Promise<Array<Track | null>> {
  const result: Array<Track | null> = []
  let revision: number | undefined
  for (let offset = 0; offset < paths.length; offset += LIBRARY_PAGE_SIZE) {
    const requested = paths.slice(offset, offset + LIBRARY_PAGE_SIZE)
    const matches = await api.lookupTracksByPaths([...requested], revision)
    if (matches.ids.length !== requested.length) throw new Error('曲库返回了不完整的歌单匹配结果')
    if (revision !== undefined && matches.revision !== revision)
      throw new Error('曲库在导入期间发生变化，请重试')
    revision = matches.revision
    const ids = [...new Set(matches.ids.filter((id): id is string => id !== null))]
    const page = ids.length ? await api.getTracksByIds(ids, revision) : null
    if (page && (page.revision !== revision || page.tracks.length !== ids.length))
      throw new Error('曲库在导入期间发生变化，请重试')
    const tracks = new Map(
      page?.tracks.map((record) => {
        const track = toPlaylistTrackSnapshot(libraryTrack(record))
        return [track.id, track] as const
      }) ?? []
    )
    for (const id of matches.ids) {
      const track = id === null ? null : tracks.get(id)
      if (track === undefined) throw new Error('曲库返回了不完整的歌单曲目')
      result.push(track)
    }
  }
  if (revision !== undefined && (await api.getMetadata()).revision !== revision)
    throw new Error('曲库在导入期间发生变化，请重试')
  return result
}
