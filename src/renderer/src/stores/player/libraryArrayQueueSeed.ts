import { LIBRARY_PAGE_SIZE, type LibraryTrackRecord } from '../../../../shared/libraryDatabase.ts'
import { compactPlaylistRecord } from '../../../../shared/playlistSnapshot.ts'
import type { LibraryQueueSeedItem } from '../../../../shared/libraryQueueBuild.ts'
import type { Track } from '../../types/music'
import type { PlayMode } from '../../types/settings'
import { getTrackSource } from '../../utils/playerTrackUtils.ts'
import { shuffleArray } from '../../utils/playerQueueUtils.ts'
import type { LibraryQueueSeedProducer } from './libraryQueueBuild.ts'

/** Plan over the existing immutable arrays. Only positions/occurrence IDs are
 * retained; compact track snapshots are made one page at a time. */
export function createLibraryArrayQueueSeed(
  queue: readonly Track[],
  original: readonly Track[],
  current: Track | null,
  currentIndex: number,
  mode: PlayMode,
  pendingMode: boolean
): { selectedIndex?: number; produce: LibraryQueueSeedProducer } {
  const base = original.length ? original : queue
  if (base.length !== queue.length) throw new Error('原始队列与当前队列不一致，请重试')
  const positions = new Map<string, number>()
  base.forEach((track, index) => {
    if (!track.queueEntryId || positions.has(track.queueEntryId))
      throw new Error('队列条目标识不完整，请重新选择队列')
    positions.set(track.queueEntryId, index)
  })
  const seen = new Set<string>()
  const order = queue.map((track, index) => {
    const id = track.queueEntryId
    if (!id || seen.has(id) || !positions.has(id) || base[positions.get(id)!].id !== track.id)
      throw new Error('队列条目标识已变化，请重试')
    seen.add(id)
    return index
  })
  if (
    current &&
    (queue[currentIndex]?.id !== current.id ||
      queue[currentIndex]?.queueEntryId !== current.queueEntryId)
  )
    throw new Error('当前歌曲不在原队列中，未切换播放来源')

  // Apply an already-requested boundary mode to the seed, without mutating the
  // old queue before adoption. Match the existing renderer boundary behavior.
  let displayed = order
  if (mode !== 'shuffle') displayed = [...order].sort((a, b) => position(a) - position(b))
  else if (pendingMode && current)
    displayed = [currentIndex, ...shuffleArray(order.filter((index) => index !== currentIndex))]

  function position(index: number): number {
    return positions.get(queue[index].queueEntryId!)!
  }
  const selected = current ? displayed.indexOf(currentIndex) : undefined
  return {
    selectedIndex: selected,
    produce: async (append) => {
      for (let offset = 0; offset < displayed.length; offset += LIBRARY_PAGE_SIZE) {
        const items = displayed.slice(offset, offset + LIBRARY_PAGE_SIZE).map((index) => {
          const track = queue[index]
          const snapshot = compactPlaylistRecord(track as unknown as LibraryTrackRecord)
          const item: LibraryQueueSeedItem = {
            id: track.id,
            originalPosition: position(index)
          }
          if (getTrackSource(track) === 'local') {
            delete snapshot.streamUrl
            item.localSnapshot = snapshot
          } else item.snapshot = snapshot
          return item
        })
        await append(items)
      }
    }
  }
}
