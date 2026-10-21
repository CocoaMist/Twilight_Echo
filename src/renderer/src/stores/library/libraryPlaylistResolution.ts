import { LIBRARY_PAGE_SIZE, type LibraryDatabaseApi } from '../../../../shared/libraryDatabase.ts'
import type { RecordingIdentity, RecordingVersion } from '../../../../shared/recordingIdentity.ts'
import type { Playlist } from './musicStoreTypes.ts'
import type { Track } from '../../types/music.ts'
import { getTrackSource } from '../../utils/trackSourceIdentity.ts'
import { libraryTrack } from '../../utils/libraryQueuePlayback.ts'

/** Only the matching fields cross the lookup seam, never playlist artwork,
 * lyrics, analysis or transient provider URLs. */
export function playlistRecordingIdentity(track: Track): RecordingIdentity {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    filePath: track.filePath,
    source: getTrackSource(track),
    duration: track.duration,
    ...(track.subTrack !== undefined ? { subTrack: track.subTrack } : {}),
    ...(track.cueRange !== undefined ? { cueRange: track.cueRange } : {}),
    ...(track.ncmSongId !== undefined ? { ncmSongId: track.ncmSongId } : {})
  }
}

/** A stable complete playlist read with bounded hydration. Consumers keep text
 * or lightweight IDs between calls, not a second full Track[] for the playlist. */
export async function readLibraryPlaylistTracks(
  playlist: Pick<Playlist, 'trackIds' | 'trackSnapshots'>,
  api: Pick<LibraryDatabaseApi, 'lookupPlaylistTracks' | 'getTracksByIds' | 'getMetadata'>,
  options: {
    expectedRevision?: number
    getVersions(): { revision: number; versions: RecordingVersion[] }
    preserveSources?: boolean
    consume(tracks: readonly Track[]): void | Promise<void>
  }
): Promise<void> {
  const ids = playlist.trackIds.slice(),
    snapshots = playlist.trackSnapshots,
    preferences = options.getVersions()
  let revision: number | undefined = options.expectedRevision
  for (let offset = 0; offset < ids.length; offset += LIBRARY_PAGE_SIZE) {
    const requested = ids.slice(offset, offset + LIBRARY_PAGE_SIZE)
    const matches = await api.lookupPlaylistTracks(
      {
        entries: requested.map((id) => ({
          id,
          ...(snapshots?.[id] ? { snapshot: playlistRecordingIdentity(snapshots[id]) } : {})
        })),
        versions: preferences.versions,
        preserveSources: options.preserveSources
      },
      revision
    )
    if (
      matches.ids.length !== requested.length ||
      (revision !== undefined && matches.revision !== revision)
    )
      throw new Error('曲库在读取歌单期间发生变化，请重试')
    revision = matches.revision
    const localIds = [...new Set(matches.ids.filter((id): id is string => id !== null))]
    const page = localIds.length ? await api.getTracksByIds(localIds, revision) : null
    if (page && (page.revision !== revision || page.tracks.length !== localIds.length))
      throw new Error('曲库在读取歌单期间发生变化，请重试')
    const local = new Map(page?.tracks.map((record) => [record.id, libraryTrack(record)]) ?? [])
    const resolved: Track[] = []
    for (let i = 0; i < requested.length; i++) {
      const localId = matches.ids[i]
      if (localId !== null) {
        const track = local.get(localId)
        if (!track) throw new Error('曲库返回了不完整的歌单曲目')
        resolved.push(track)
      } else {
        const snapshot = snapshots?.[requested[i]]
        if (snapshot && getTrackSource(snapshot) !== 'local') resolved.push(snapshot)
      }
    }
    if (options.getVersions().revision !== preferences.revision)
      throw new Error('录音版本偏好在读取歌单期间发生变化，请重试')
    await options.consume(resolved)
  }
  if (revision !== undefined && (await api.getMetadata()).revision !== revision)
    throw new Error('曲库在读取歌单期间发生变化，请重试')
  if (options.getVersions().revision !== preferences.revision)
    throw new Error('录音版本偏好在读取歌单期间发生变化，请重试')
}
