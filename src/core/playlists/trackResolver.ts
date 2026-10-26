import type { Cell, PlaylistRuntime } from './ports.ts'
import type { TrackData as Track } from '../../shared/track.ts'
import type { Playlist } from '../../shared/playlists.ts'
import type { LogicalTrack } from '../../shared/logicalTrackModel.ts'
import { getTrackSource } from '../../shared/trackSourceIdentity.ts'
import { versionSourceKey } from '../../shared/trackSourceIdentity.ts'
import { importedPlayableTracks } from './externalController.ts'

/** Cache recording identity against library and music-version revisions. */
export function createPlaylistTrackResolver({
  tracks,
  trackById,
  getTracksRevision,
  runtime
}: {
  runtime: PlaylistRuntime
  tracks: Cell<Track[]>
  trackById: ReadonlyMap<string, Track>
  getTracksRevision: () => number
}) {
  const {
    buildLogicalTracks,
    canShareTrackIdentity,
    preferredSourceKey,
    getRecordingTrackKey: getLogicalTrackKey
  } = runtime.identity
  let localLogicalTrackMapRevision = -1
  let localLogicalVersionRevision = -1
  let localLogicalTrackMapCache = new Map<string, LogicalTrack>()
  let playlistIdentityCache: {
    playlist: Playlist
    trackIds: string[]
    snapshots: Record<string, Track> | undefined
    tracksRevision: number
    versionRevision: number
    ids: Set<string>
    snapshotsByLogicalKey: Map<string, Track[]>
  } | null = null

  function getPlaylistTrackSnapshot(playlist: Playlist, trackId: string): Track | undefined {
    return trackById.get(trackId) ?? playlist.trackSnapshots?.[trackId]
  }

  function getPlaylistIdentity(playlist: Playlist): {
    ids: Set<string>
    snapshotsByLogicalKey: Map<string, Track[]>
  } {
    if (
      playlistIdentityCache &&
      playlistIdentityCache.playlist === playlist &&
      playlistIdentityCache.trackIds === playlist.trackIds &&
      playlistIdentityCache.snapshots === playlist.trackSnapshots &&
      playlistIdentityCache.tracksRevision === getTracksRevision() &&
      playlistIdentityCache.versionRevision === runtime.versions.revision()
    ) {
      return playlistIdentityCache
    }

    // Keyed by title+artist, but the bucket keeps every snapshot: two different
    // recordings can share that key, so callers compare the candidates instead
    // of treating the key itself as the identity.
    const ids = new Set<string>()
    const snapshotsByLogicalKey = new Map<string, Track[]>()
    for (const trackId of playlist.trackIds) {
      ids.add(trackId)
      const snapshot = getPlaylistTrackSnapshot(playlist, trackId)
      if (!snapshot) continue
      const key = getLogicalTrackKey(snapshot)
      const bucket = snapshotsByLogicalKey.get(key)
      if (bucket) bucket.push(snapshot)
      else snapshotsByLogicalKey.set(key, [snapshot])
    }
    playlistIdentityCache = {
      playlist,
      trackIds: playlist.trackIds,
      snapshots: playlist.trackSnapshots,
      tracksRevision: getTracksRevision(),
      versionRevision: runtime.versions.revision(),
      ids,
      snapshotsByLogicalKey
    }
    return playlistIdentityCache
  }

  function getLocalLogicalTrackMap(): Map<string, LogicalTrack> {
    runtime.versions.ensure()
    if (
      localLogicalTrackMapRevision === getTracksRevision() &&
      localLogicalVersionRevision === runtime.versions.revision()
    ) {
      return localLogicalTrackMapCache
    }

    const result = new Map<string, LogicalTrack>()
    const localInputs = (function* () {
      for (const track of tracks.value) {
        if (getTrackSource(track) !== 'local') continue
        yield {
          track,
          source: 'local' as const,
          sourceName: '本地音乐',
          providerAvailable: true
        }
      }
    })()

    for (const logicalTrack of buildLogicalTracks(localInputs)) {
      const key = getLogicalTrackKey(logicalTrack.preferredTrack)
      const existing = result.get(key)
      if (existing) existing.variants.push(...logicalTrack.variants)
      else result.set(key, { ...logicalTrack, variants: [...logicalTrack.variants] })
    }
    localLogicalTrackMapCache = result
    localLogicalTrackMapRevision = getTracksRevision()
    localLogicalVersionRevision = runtime.versions.revision()
    return result
  }

  // Ordinary playlists prefer a playable local recording. Aggregate playlists
  // preserve provider snapshots so users can still choose between sources.
  function resolvePlaylistTracks(playlist: Playlist, preserveSources = false): Track[] {
    if (playlist.imported) return importedPlayableTracks(playlist.imported.entries)
    let localLogicalTracks: Map<string, LogicalTrack> | null = null
    return playlist.trackIds
      .map((trackId): Track | undefined => {
        const exact = trackById.get(trackId)
        if (exact) return exact
        const snapshot = playlist.trackSnapshots?.[trackId]
        if (!snapshot) return undefined
        const local = getTrackSource(snapshot) === 'local'
        if (preserveSources && !local) return snapshot
        localLogicalTracks ??= getLocalLogicalTrackMap()
        const source = preferredSourceKey(snapshot)
        const replacement = localLogicalTracks
          .get(getLogicalTrackKey(snapshot))
          ?.variants.find(
            (variant) =>
              canShareTrackIdentity(snapshot, variant.track) &&
              (!source || versionSourceKey(variant.track) === source)
          )?.track
        return replacement ?? (local ? undefined : snapshot)
      })
      .filter((track): track is Track => !!track)
  }
  return {
    getPlaylistTrackSnapshot,
    getPlaylistIdentity,
    resolvePlaylistTracks,
    invalidate: () => {
      playlistIdentityCache = null
    }
  }
}
