import type { Track } from '../types/music'

export const PLAYBACK_QUEUE_ROW_HEIGHT = 54
export const PLAYBACK_QUEUE_OVERSCAN = 6

export interface PlaybackQueueDisplayItem {
  index: number
  id: string
  queueEntryId: string
  title: string
  artist: string
  cover: string | null
}

export interface PlaybackQueueWindow {
  start: number
  end: number
}

export {
  toPlaybackQueueSnapshot,
  toPlaybackQueueSnapshots,
  patchPlaybackQueueTrack,
  matchesPlaybackQueueSnapshot,
  createPlaybackQueueSnapshotCache
} from '../../../core/playback/queueSnapshots.ts'

export function getPlaybackQueueWindow(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = PLAYBACK_QUEUE_ROW_HEIGHT,
  overscan = PLAYBACK_QUEUE_OVERSCAN
): PlaybackQueueWindow {
  const safeTotal = Math.max(0, Math.floor(total))
  const safeRowHeight = Math.max(1, rowHeight)
  const start = Math.max(0, Math.floor(Math.max(0, scrollTop) / safeRowHeight) - overscan)
  const visibleCount = Math.ceil(Math.max(0, viewportHeight) / safeRowHeight) + overscan * 2
  return { start: Math.min(safeTotal, start), end: Math.min(safeTotal, start + visibleCount) }
}

export function getPlaybackQueueScrollTopForIndex(
  index: number,
  total: number,
  viewportHeight: number,
  rowHeight = PLAYBACK_QUEUE_ROW_HEIGHT
): number {
  const safeTotal = Math.max(0, Math.floor(total))
  if (safeTotal === 0) return 0
  const safeRowHeight = Math.max(1, rowHeight)
  const safeIndex = Math.min(safeTotal - 1, Math.max(0, Math.floor(index)))
  const maxScrollTop = Math.max(0, safeTotal * safeRowHeight - Math.max(0, viewportHeight))
  const centered = safeIndex * safeRowHeight - (viewportHeight - safeRowHeight) / 2
  return Math.min(maxScrollTop, Math.max(0, centered))
}

export function createPlaybackQueueDisplayItems(
  tracks: readonly Track[],
  window: PlaybackQueueWindow
): PlaybackQueueDisplayItem[] {
  const items: PlaybackQueueDisplayItem[] = []
  for (let index = window.start; index < window.end; index += 1) {
    const track = tracks[index]
    if (!track) continue
    items.push({
      index,
      id: track.id,
      queueEntryId: track.queueEntryId ?? `queue:${track.id}:${index}`,
      title: track.title,
      artist: track.artist,
      cover: track.cover ?? null
    })
  }
  return items
}
