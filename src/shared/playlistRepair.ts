import type { LibraryTrackRecord } from './libraryDatabase.ts'

export const PLAYLIST_REPAIR_BATCH_SIZE = 200

export interface LibraryPlaylistRelocations {
  relocations: Array<{ trackId: string; fromPath: string; toTrack: LibraryTrackRecord }>
  unresolvedTrackIds: string[]
  ambiguousTrackIds: string[]
}

export type LibraryPlaylistRepairRequest =
  | { kind: 'open'; folder: string }
  | { kind: 'resolve'; id: string; sequence: number; missing: LibraryTrackRecord[] }
  | { kind: 'close'; id: string }

export type LibraryPlaylistRepairResponse =
  | { kind: 'ready'; id: string; candidateCount: number }
  | { kind: 'resolved'; id: string; sequence: number; result: LibraryPlaylistRelocations }
  | { kind: 'closed'; id: string }

export interface LibraryPlaylistRepairApi {
  repairPlaylist(request: LibraryPlaylistRepairRequest): Promise<LibraryPlaylistRepairResponse>
}

/** Internal derived index commands; never exposed directly over renderer IPC. */
export type LibraryRepairCandidateCommand =
  | { kind: 'begin'; id: string }
  | { kind: 'append'; id: string; sequence: number; tracks: LibraryTrackRecord[] }
  | { kind: 'seal'; id: string; sequence: number }
  | { kind: 'resolve'; id: string; sequence: number; missing: LibraryTrackRecord[] }
  | { kind: 'close'; id: string }

export interface LibraryRepairCandidateReply {
  count: number
  result?: LibraryPlaylistRelocations
}

export function validatePlaylistRepairRequest(
  value: unknown
): asserts value is LibraryPlaylistRepairRequest {
  if (!value || typeof value !== 'object') throw new Error('无效的歌单修复请求')
  const input = value as Record<string, unknown>
  const validText = (text: unknown) =>
    typeof text === 'string' && text.length > 0 && text.length <= 32_768 && !text.includes('\0')
  if (input.kind === 'open' && validText(input.folder)) return
  if (!validText(input.id)) throw new Error('无效的歌单修复会话')
  if (input.kind === 'close') return
  if (
    input.kind !== 'resolve' ||
    !Number.isSafeInteger(input.sequence) ||
    Number(input.sequence) < 1
  )
    throw new Error('无效的歌单修复批次')
  validateRepairTracks(input.missing)
}

export function validateRepairTracks(value: unknown): asserts value is LibraryTrackRecord[] {
  if (!Array.isArray(value) || value.length > PLAYLIST_REPAIR_BATCH_SIZE)
    throw new Error('歌单修复批次超过上限')
  for (const track of value) {
    if (
      !track ||
      typeof track !== 'object' ||
      !['id', 'filePath', 'title', 'artist'].every(
        (key) =>
          typeof track[key] === 'string' &&
          track[key].length <= 32_768 &&
          !track[key].includes('\0')
      ) ||
      !track.id ||
      typeof track.duration !== 'number' ||
      !Number.isFinite(track.duration)
    )
      throw new Error('无效的歌单修复曲目')
  }
}
