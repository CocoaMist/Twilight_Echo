import type { LibraryQueuePlaybackWindow } from '../../../shared/libraryDatabase.ts'
import type { Track } from '../types/music'
import type { TrackData } from '../../../shared/track.ts'
import type { PlayMode } from '../types/settings'
import type { PreparePlayerNativeQueueOptions } from './nativeQueuePreparation.ts'

export { libraryQueueTrack } from '../../../core/playback/libraryTrack.ts'
export function libraryTrack(record: import('../../../shared/coreViews.ts').CoreTrackView): Track {
  return { ...record, source: record.source ?? 'local' }
}
import { libraryQueueTrack } from '../../../core/playback/libraryTrack.ts'

/** The native player gets only a current+next window. The explicit mapping
 * retains global positions while its loadQueue start index remains local. */
export function libraryNativeQueueOptions(
  window: LibraryQueuePlaybackWindow,
  current: TrackData,
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
