import type { CoreLibraryQueries } from '../../../../shared/coreLibrary.ts'
import { createRecordingIdentityRules, type RecordingVersion } from '../../../../shared/recordingIdentity.ts'
import type { CoreTrackView } from '../../../../shared/coreViews.ts'
import type { UnifiedRecentStat } from '../../utils/unifiedRecentTracks.ts'
import type { Track } from '../../types/music.ts'
import { libraryTrack } from '../../utils/libraryQueuePlayback.ts'
import { getTrackSource } from '../../utils/trackSourceIdentity.ts'

export interface LibraryRecentHistoryOptions {
  getPreferences(): { revision: number; versions: RecordingVersion[] }
  api: {
    getTracksByIds: (
      ids: string[],
      revision?: number
    ) => Promise<{
      revision: number
      tracks: CoreTrackView[]
    }>
    resolveRecentTracks: (
      entries: CoreLibraryQueries['library.recent.resolve']['input']['entries'],
      revision: number,
      versionsRevision: number
    ) => Promise<{
      ids: Array<string | null>
      revision: number
      versionsRevision: number
    }>
    getArtwork?: (ids: string[], revision: number) => Promise<{
      revision: number
      items: Array<{ id: string; cover: string | null }>
    }>
  }
}

/** Resolve a bounded history shelf at one content/preference version. Local
 * snapshots are matching hints, never evidence that a deleted file exists. */
export async function readLibraryRecentHistory(
  history: readonly UnifiedRecentStat[],
  revision: number,
  options: LibraryRecentHistoryOptions,
  assertLive: () => void
) {
  const changed = () => new Error('曲库在读取最近播放期间发生变化，请重试')
  const preferences = options.getPreferences()
  const entries = history.map((stat) => {
    const snapshot: Track | null | undefined = stat.track ?? stat.displayTrack
    return {
      id: stat.id,
      sourceIds: stat.sourceIds?.map((source) => source.trackId),
      snapshot: snapshot
        ? {
            id: snapshot.id,
            title: snapshot.title,
            artist: snapshot.artist,
            album: snapshot.album,
            source: snapshot.source,
            filePath: snapshot.filePath,
            duration: snapshot.duration,
            subTrack: snapshot.subTrack,
            cueRange: snapshot.cueRange,
            ncmSongId: snapshot.ncmSongId
          }
        : { id: stat.id, title: stat.title, artist: stat.artist }
    }
  })
  const matches = history.length
    ? await options.api.resolveRecentTracks(entries, revision, preferences.revision)
    : null
  assertLive()
  if (
    matches &&
    (matches.revision !== revision ||
      matches.versionsRevision !== preferences.revision ||
      matches.ids.length !== history.length)
  )
    throw changed()
  const ids = [...new Set(matches?.ids.filter((id): id is string => id !== null) ?? [])]
  const page = ids.length ? await options.api.getTracksByIds(ids, revision) : null
  assertLive()
  if (page && (page.revision !== revision || page.tracks.length !== ids.length)) throw changed()
  const artwork = ids.length && options.api.getArtwork ? await options.api.getArtwork(ids, revision) : null
  assertLive()
  if (artwork && artwork.revision !== revision) throw changed()
  const covers = new Map(artwork?.items.map((item) => [item.id, item.cover]) ?? [])
  const tracks = new Map(
    page?.tracks.map((record) => {
      const track = libraryTrack(record)
      return [track.id, { ...track, cover: covers.get(track.id) ?? track.cover ?? null }]
    }) ?? []
  )
  const resolved = new Map<string, Track | null>()
  history.forEach((stat, index) => {
    const id = matches?.ids[index]
    if (id && !tracks.has(id)) throw changed()
    const snapshot: Track | null | undefined = stat.track ?? stat.displayTrack
    const remote = snapshot && getTrackSource(snapshot) !== 'local'
      ? { ...snapshot, cover: stat.cover ?? snapshot.cover ?? null }
      : null
    resolved.set(stat.id, (id ? tracks.get(id) : null) ?? remote)
  })
  if (options.getPreferences().revision !== preferences.revision)
    throw new Error('录音版本偏好已变化，请刷新最近播放')
  return { resolved, preferences, preferenceRevision: preferences.revision }
}

export async function readLibraryRecentHistoryTracks(
  history: readonly UnifiedRecentStat[],
  revision: number,
  options: LibraryRecentHistoryOptions,
  assertLive: () => void
): Promise<Track[]> {
  const result = await readLibraryRecentHistory(history, revision, options, assertLive)
  const bySource = new Map(
    result.preferences.versions.flatMap((version) =>
      version.sources.map((key) => [key, version] as const)
    )
  )
  const identity = createRecordingIdentityRules((key) => bySource.get(key))
  const seen = new Set<string>()
  const tracks: Track[] = []
  for (const stat of history) {
    const track = result.resolved.get(stat.id)
    if (!track) continue
    const key = identity.getRecordingTrackKey(track)
    if (seen.has(key)) continue
    seen.add(key)
    tracks.push(track)
  }
  return tracks
}
