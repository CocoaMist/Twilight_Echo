import { LIBRARY_PAGE_SIZE } from '../../../../shared/libraryDatabase.ts'
import type {
  LibrarySelectionBridgeApi,
  LibrarySelectionRequest
} from '../../../../shared/librarySelection.ts'
import { normalizeLibraryPath } from '../../../../shared/libraryIdentity.ts'
import { openLibrarySelectionLease } from '../../stores/library/librarySelectionLease.ts'
import type {
  PlaylistMemberPageProducer,
  PlaylistTrackIdPageProducer,
  PlaylistTrackPageProducer
} from '../../stores/library/musicStoreTypes.ts'
import type { Track } from '../../types/music.ts'
import { libraryTrack } from '../../utils/libraryQueuePlayback.ts'
import { getTrackSource } from '../../utils/logicalTrackModel.ts'

export interface SongListActionRow {
  track: Track
  definitionId: string
  version?: number
  instance?: number
}

/** A dialog can retain this intent, not a lease or an accumulated SQL Track[].
 * An intent opens once: a failed/unknown action must be explicitly started anew. */
export function createSongListActionSource(
  input:
    | { api: LibrarySelectionBridgeApi; request: LibrarySelectionRequest }
    | { rows: SongListActionRow[] },
  guard: () => void = () => {}
) {
  const request = 'request' in input ? structuredClone(input.request) : null
  const explicit = 'rows' in input ? input.rows.slice() : null
  const count = request
    ? request.ranges.reduce((n, [start, end]) => n + end - start, 0)
    : explicit!.length
  let opened = false
  return {
    count,
    guard,
    async open(signal?: AbortSignal) {
      if (opened) throw new Error('选择操作已使用，请重新选择')
      opened = true
      guard()
      if (signal?.aborted) throw new Error('选择操作已取消')
      const lease = request
        ? await openLibrarySelectionLease(
            (input as { api: LibrarySelectionBridgeApi }).api,
            request,
            signal
          )
        : null
      let closed = false,
        failed = false,
        consuming = false
      const local = explicit?.filter((row) => getTrackSource(row.track) === 'local')
      const files = local
        ? [...new Map(local.map((row) => [normalizeLibraryPath(row.track.filePath), row])).values()]
        : null
      async function forEachPage(
        visit: (rows: SongListActionRow[]) => void | Promise<void>,
        projection: 'tracks' | 'files' = 'tracks'
      ): Promise<void> {
        if (closed || signal?.aborted) throw new Error('选择操作已取消')
        if (failed || consuming) throw new Error('选择读取已中断或正在进行，请重新操作')
        consuming = true
        try {
          if (lease) {
            await lease.forEachPage(
              (page) =>
                visit(
                  page.rows.map((row) => ({
                    track: libraryTrack(row.track),
                    definitionId: row.definitionId,
                    version: row.version,
                    instance: row.instance
                  }))
                ),
              projection
            )
          } else {
            const rows = projection === 'files' ? files! : explicit!
            for (let offset = 0; offset < rows.length; offset += LIBRARY_PAGE_SIZE) {
              if (closed || signal?.aborted) throw new Error('选择操作已取消')
              await visit(rows.slice(offset, offset + LIBRARY_PAGE_SIZE))
            }
            if (closed || signal?.aborted) throw new Error('选择操作已取消')
          }
        } catch (error) {
          failed = true
          throw error
        } finally {
          consuming = false
        }
      }
      const tracks: PlaylistTrackPageProducer = async (append) => {
        await forEachPage((rows) => {
          guard()
          return append(rows.map((row) => row.track))
        })
        return guard
      }
      const ids: PlaylistTrackIdPageProducer = async (append) => {
        await forEachPage((rows) => {
          guard()
          return append(rows.map((row) => row.definitionId))
        })
        return guard
      }
      const members: PlaylistMemberPageProducer = async (append) => {
        await forEachPage((rows) => {
          guard()
          return append(
            rows.map((row) => ({
              id: row.definitionId,
              ...(row.definitionId === row.track.id ? { track: row.track } : {})
            }))
          )
        })
        return guard
      }
      return {
        count,
        revision: lease?.snapshot.revision,
        localTrackCount: lease?.snapshot.localTrackCount ?? local!.length,
        fileCount: lease?.snapshot.fileCount ?? files!.length,
        forEachPage,
        tracks,
        ids,
        members,
        async close(): Promise<void> {
          closed = true
          await lease?.close()
        }
      }
    }
  }
}

export async function readSongListLoudnessTargets(lease: SongListActionLease): Promise<Track[]> {
  const tracks = new Map<string, Track>()
  await lease.forEachPage((rows) => {
    for (const { track } of rows) {
      if (getTrackSource(track) !== 'local') continue
      tracks.set(track.id, track)
      if (tracks.size > 10_000) throw new Error('单次最多分析 10,000 首，请缩小选择范围')
    }
  })
  return [...tracks.values()]
}

export type SongListActionSource = ReturnType<typeof createSongListActionSource>
export type SongListActionLease = Awaited<ReturnType<SongListActionSource['open']>>

/** The tag editor edits physical files, not an unbounded collection of CUE rows. */
export async function readSongListTagTargets(lease: SongListActionLease): Promise<Track[]> {
  if (lease.fileCount > 1000) throw new Error('每次最多编辑 1000 个文件，请缩小选择范围。')
  // A file projection can choose a different representative of the same file;
  // inspect every selected occurrence before deduplicating editable targets.
  await lease.forEachPage((rows) => {
    if (rows.some(({ track }) => track.cueRange || track.subTrack))
      throw new Error('CUE 或容器子曲目共享源文件，请编辑原文件标签后重新扫描。')
  })
  const tracks: Track[] = []
  await lease.forEachPage((rows) => {
    for (const row of rows) {
      if (row.track.cueRange || row.track.subTrack)
        throw new Error('CUE 或容器子曲目共享源文件，请编辑原文件标签后重新扫描。')
      tracks.push(row.track)
    }
  }, 'files')
  return tracks
}
