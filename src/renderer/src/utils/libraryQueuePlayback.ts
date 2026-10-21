import type {
  LibraryQueuePlaybackWindow,
  LibraryTrackRecord
} from '../../../shared/libraryDatabase.ts'
import type { Track } from '../types/music'
import type { PlayMode } from '../types/settings'
import type { PreparePlayerNativeQueueOptions } from './nativeQueuePreparation.ts'
import { getTrackSource } from '../../../shared/trackSourceIdentity.ts'

/** Legacy documents may omit display fields. Their database identities and
 * extension fields survive; occurrence identity always comes from the queue. */
export function libraryTrack(record: LibraryTrackRecord): Track {
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

export function libraryQueueTrack(record: LibraryTrackRecord, queueEntryId: string): Track {
  return { ...libraryTrack(record), queueEntryId }
}

/** The native player gets only a current+next window. The explicit mapping
 * retains global positions while its loadQueue start index remains local. */
export function libraryNativeQueueOptions(
  window: LibraryQueuePlaybackWindow,
  current: Track,
  currentTarget: string,
  playMode: PlayMode,
  isCurrent?: () => boolean
): PreparePlayerNativeQueueOptions {
  const first = window.items[0]
  if (
    !first?.track ||
    first.position !== window.queue.index ||
    first.queueEntryId !== window.queue.selectedEntryId ||
    first.queueEntryId !== current.queueEntryId ||
    first.track.id !== current.id
  )
    throw new Error('Database playback window no longer matches the selected occurrence')
  const items = playMode === 'repeat' ? [first] : window.items
  if (items.length > 2 || items.some((item) => !item.track))
    throw new Error('Invalid database playback window')
  const queue = items.map((item) => libraryQueueTrack(item.track!, item.queueEntryId))
  return {
    queue,
    currentTrack: current,
    currentTarget,
    currentIndex: 0,
    playMode,
    isCurrent,
    libraryQueue: {
      id: window.queue.id,
      revision: window.queue.revision,
      total: window.queue.total,
      lastPlayablePosition: window.lastPlayablePosition,
      positions: items.map((item) => item.position)
    }
  }
}
