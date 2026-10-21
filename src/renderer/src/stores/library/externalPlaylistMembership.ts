import type { Track } from '../../types/music.ts'
import {
  EXTERNAL_PLAYLIST_MAX_ENTRIES,
  externalRefreshGeneration,
  type ImportedPlaylistData,
  type ImportedPlaylistEntry
} from '../../../../shared/externalPlaylist.ts'
import { clonePlaylist, toPlaylistTrackSnapshot } from './musicStoreData.ts'
import { getTrackSource } from '../../utils/trackSourceIdentity.ts'

/** Local membership edits invalidate matching jobs, not the source-refresh
 * lineage. Keep these identities separate in both staging and CAS replay. */
export function withExternalMembership(
  data: ImportedPlaylistData,
  entries: readonly ImportedPlaylistEntry[]
): ImportedPlaylistData {
  if (entries.length > EXTERNAL_PLAYLIST_MAX_ENTRIES) throw new Error('歌单超过 20,000 条上限')
  return {
    ...data,
    entries: entries.map((entry, position) => ({ ...entry, position })),
    refreshGeneration: externalRefreshGeneration(data),
    generation: crypto.randomUUID(),
    membershipRevision: data.membershipRevision + 1,
    locallyEdited: true
  }
}

export function externalEntryForTrack(track: Track, position: number): ImportedPlaylistEntry {
  const snapshot = toPlaylistTrackSnapshot(track)
  return {
    entryId: crypto.randomUUID(),
    position,
    revision: 0,
    original: {
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      ...(track.isrc ? { isrc: track.isrc } : {})
    },
    manualBinding: snapshot,
    resolution: {
      state: getTrackSource(track) === 'local' ? 'local' : 'streaming',
      track: snapshot
    }
  }
}

export function copyExternalEntry(
  entry: ImportedPlaylistEntry,
  position: number
): ImportedPlaylistEntry {
  return clonePlaylist({
    ...entry,
    entryId: crypto.randomUUID(),
    position,
    ...(entry.manualBinding ? { manualBinding: toPlaylistTrackSnapshot(entry.manualBinding) } : {}),
    resolution: {
      ...entry.resolution,
      ...(entry.resolution.track ? { track: toPlaylistTrackSnapshot(entry.resolution.track) } : {})
    }
  })
}
