import type { Track } from '../../types/music.ts'
import type { PlaylistRelocationResult } from '../../utils/playlistLifecycle.ts'
import {
  PLAYLIST_REPAIR_BATCH_SIZE,
  type LibraryPlaylistRepairApi
} from '../../../../shared/playlistRepair.ts'
import type { LibraryTrackRecord } from '../../../../shared/libraryDatabase.ts'

/** Only explicit missing snapshots and matched replacements cross the bridge.
 * Resolution is stateful: no batch is retried after an unknown reply. */
export async function findLibraryPlaylistRelocations(
  missing: readonly Track[],
  folder: string,
  api: LibraryPlaylistRepairApi
): Promise<PlaylistRelocationResult> {
  const result: PlaylistRelocationResult = {
    relocations: [],
    unresolvedTrackIds: [],
    ambiguousTrackIds: []
  }
  if (!missing.length) return result
  const opened = await api.repairPlaylist({ kind: 'open', folder })
  if (opened.kind !== 'ready' || !opened.id) throw new Error('未收到有效的歌单修复会话')
  let sequence = 0
  try {
    for (let offset = 0; offset < missing.length; offset += PLAYLIST_REPAIR_BATCH_SIZE) {
      const reply = await api.repairPlaylist({
        kind: 'resolve',
        id: opened.id,
        sequence: ++sequence,
        missing: missing.slice(offset, offset + PLAYLIST_REPAIR_BATCH_SIZE).map((track) => ({
          id: track.id,
          filePath: track.filePath,
          fileName: track.fileName,
          title: track.title,
          artist: track.artist,
          duration: track.duration
        })) as LibraryTrackRecord[]
      })
      if (reply.kind !== 'resolved' || reply.id !== opened.id || reply.sequence !== sequence)
        throw new Error('歌单修复结果已失效，请重新修复')
      result.relocations.push(
        ...(reply.result.relocations as unknown as PlaylistRelocationResult['relocations'])
      )
      result.unresolvedTrackIds.push(...reply.result.unresolvedTrackIds)
      result.ambiguousTrackIds.push(...reply.result.ambiguousTrackIds)
    }
  } catch (error) {
    await api.repairPlaylist({ kind: 'close', id: opened.id }).catch(() => {})
    throw error
  }
  await api.repairPlaylist({ kind: 'close', id: opened.id })
  return result
}
