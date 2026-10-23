import type { ImportSong } from '../../shared/externalPlaylist.ts'
import type { TrackData } from '../../shared/track.ts'
import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import {
  chooseStrictImportCandidate,
  strictImportCandidate
} from '../../shared/playlistImportMatching.ts'
import { normalizePortableLibraryPath } from '../../shared/playlistPaths.ts'
import { libraryTrack } from '../playback/libraryTrack.ts'

/** Existing exact-path and strict-recording policy, with bounded SQL hydration. */
export function createImportLocalCandidates(options: {
  database: Pick<LibraryDatabaseApi, 'lookupTracksByPaths' | 'getTracksByIds' | 'queryTracks'>
  loadJsonLibrary?: () => Promise<{ revision: number; tracks: TrackData[] }>
  authorizeLocal(track: TrackData): Promise<boolean>
}) {
  return async (song: ImportSong, signal: AbortSignal) => {
    if (options.loadJsonLibrary) {
      const { tracks } = await options.loadJsonLibrary()
      const paths = new Set(song.locations?.map(normalizePortableLibraryPath))
      signal.throwIfAborted()
      return {
        exactPath: tracks.find(
          (t) =>
            (!t.source || t.source === 'local') &&
            paths.has(normalizePortableLibraryPath(t.filePath))
        ),
        candidates: tracks.filter(
          (t) => (!t.source || t.source === 'local') && chooseStrictImportCandidate(song, [t]).track
        )
      }
    }
    let exactPath: TrackData | undefined, revision: number | undefined
    const paths = (song.locations ?? []).filter((p) => !/^https?:/i.test(p)).slice(0, 200)
    if (paths.length) {
      const lookup = await options.database.lookupTracksByPaths(paths)
      revision = lookup.revision
      const ids = lookup.ids.filter((id): id is string => id !== null)
      if (ids.length) {
        const page = await options.database.getTracksByIds(ids, revision)
        if (page.revision !== revision || page.tracks.length !== ids.length)
          throw new Error('曲库在按路径读取期间发生变化，请重试')
        exactPath = page.tracks[0] ? libraryTrack(page.tracks[0]) : undefined
      }
    }
    const candidates = new Map<string, TrackData>()
    let ambiguous = false
    if (song.title)
      for (let offset = 0; ; ) {
        signal.throwIfAborted()
        const page = await options.database.queryTracks({
          search: song.title,
          sort: 'title',
          offset,
          limit: 200,
          contentRevision: revision
        })
        revision = page.revision
        for (const record of page.tracks) {
          const track = libraryTrack(record)
          if (!strictImportCandidate(song, track) || !(await options.authorizeLocal(track)))
            continue
          candidates.set(`${track.source ?? 'local'}:${track.id}`, track)
          if (candidates.size > 1) {
            ambiguous = true
            break
          }
        }
        if (ambiguous) break
        offset += page.tracks.length
        if (offset >= page.total) break
        if (!page.tracks.length) throw new Error('本地曲库匹配分页中断')
      }
    return { exactPath, candidates: [...candidates.values()], ambiguous }
  }
}
