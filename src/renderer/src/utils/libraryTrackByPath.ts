import type { LibraryDatabaseApi } from '../../../shared/libraryDatabase.ts'
import type { TrackData as Track } from '../../../shared/track.ts'
import { libraryTrack } from '../../../core/playback/libraryTrack.ts'

type PathLookupApi = Pick<LibraryDatabaseApi, 'lookupTracksByPaths' | 'getTracksByIds'>

export async function lookupLibraryTracksByPaths(
  paths: string[],
  api: PathLookupApi,
  expectedRevision?: number
): Promise<{ tracks: Track[]; revision: number }> {
  const lookup = await api.lookupTracksByPaths(paths, expectedRevision)
  const ids = lookup.ids.filter((id): id is string => id !== null)
  if (!ids.length) return { tracks: [], revision: lookup.revision }
  const page = await api.getTracksByIds(ids, lookup.revision)
  if (page.revision !== lookup.revision || page.tracks.length !== ids.length)
    throw new Error('曲库在按路径读取期间发生变化，请重试')
  return { tracks: page.tracks.map(libraryTrack), revision: lookup.revision }
}

export async function lookupLibraryTrackByPath(
  path: string,
  api: PathLookupApi,
  expectedRevision?: number
): Promise<Track | null> {
  const result = await lookupLibraryTracksByPaths([path], api, expectedRevision)
  return result.tracks[0] ?? null
}
