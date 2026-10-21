import type { LibraryDatabaseApi } from '../../../../shared/libraryDatabase.ts'
import {
  createRecordingIdentityRules,
  type RecordingIdentity,
  type RecordingVersion
} from '../../../../shared/recordingIdentity.ts'
import type { UnifiedRecentStat } from '../../utils/unifiedRecentTracks.ts'
import type { Track } from '../../types/music.ts'
import { libraryTrack } from '../../utils/libraryQueuePlayback.ts'
import { getTrackSource } from '../../utils/trackSourceIdentity.ts'
import { playlistRecordingIdentity } from './libraryPlaylistResolution.ts'

export type LibraryRecentHistoryOptions = {
  getPreferences(): { revision: number; versions: RecordingVersion[] }
  api: Pick<LibraryDatabaseApi, 'lookupPlaylistTracks' | 'getTracksByIds'>
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
  const matches = history.length
    ? await options.api.lookupPlaylistTracks(
        {
          entries: history.map((stat) => ({
            id: stat.id,
            sourceIds: stat.sourceIds?.map((source) => source.trackId),
            snapshot: stat.track
              ? playlistRecordingIdentity(stat.track)
              : ({
                  id: stat.id,
                  title: stat.title,
                  artist: stat.artist
                } satisfies RecordingIdentity)
          })),
          versions: preferences.versions,
          resolution: 'recent'
        },
        revision
      )
    : null
  assertLive()
  if (matches && (matches.revision !== revision || matches.ids.length !== history.length))
    throw changed()
  const ids = [...new Set(matches?.ids.filter((id): id is string => id !== null) ?? [])]
  const page = ids.length ? await options.api.getTracksByIds(ids, revision) : null
  assertLive()
  if (page && (page.revision !== revision || page.tracks.length !== ids.length)) throw changed()
  const tracks = new Map(page?.tracks.map((record) => [record.id, libraryTrack(record)]) ?? [])
  const resolved = new Map<string, Track | null>()
  history.forEach((stat, index) => {
    const id = matches?.ids[index]
    if (id && !tracks.has(id)) throw changed()
    const remote = stat.track && getTrackSource(stat.track) !== 'local' ? stat.track : null
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
