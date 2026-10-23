import type { LibraryTrackRecord } from '../../shared/libraryDatabase.ts'
import type { TrackData } from '../../shared/track.ts'
import { getTrackSource } from '../../shared/trackSourceIdentity.ts'

/** Legacy documents may omit display fields. Their database identities and
 * extension fields survive; occurrence identity always comes from the queue. */
export function libraryTrack(record: LibraryTrackRecord): TrackData {
  const fileName =
    typeof record.fileName === 'string'
      ? record.fileName
      : record.filePath.split(/[\\/]/).pop() || record.id
  const { queueEntryId: _queueEntryId, ...metadata } = record
  return {
    ...metadata,
    // Legacy SQL rows have arbitrary IDs (e.g. track:10:2), not provider IDs.
    source:
      typeof record.source === 'string'
        ? getTrackSource({ id: record.id, source: record.source })
        : 'local',
    title: typeof record.title === 'string' ? record.title : fileName,
    artist: typeof record.artist === 'string' ? record.artist : '未知艺术家',
    album: typeof record.album === 'string' ? record.album : '未知专辑',
    fileName,
    duration:
      typeof record.duration === 'number' && Number.isFinite(record.duration) ? record.duration : 0,
    size: typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : 0,
    cover: typeof record.cover === 'string' ? record.cover : null,
    lyrics: typeof record.lyrics === 'string' ? record.lyrics : null
  }
}

export function libraryQueueTrack(record: LibraryTrackRecord, queueEntryId: string): TrackData {
  return { ...libraryTrack(record), queueEntryId }
}
