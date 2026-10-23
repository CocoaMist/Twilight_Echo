import type { CoreSnapshot } from '../../../shared/coreProtocol.ts'
import type { CoreLibraryPage } from '../../../shared/coreViews.ts'
import type { LibraryPage } from '../../../shared/libraryDatabase.ts'
import { projectCoreTrack } from '../../../core/projections.ts'
import { createLogicalTrackModel } from '../../../shared/logicalTrackModel.ts'
import type { PlaylistRuntime } from '../../../core/playlists/ports.ts'
import type { RecordingVersion } from '../../../shared/recordingIdentity.ts'

export function coreSnapshot(patch: Partial<CoreSnapshot> = {}): CoreSnapshot {
  return {
    protocolVersion: 1,
    epoch: 'fixture-core',
    sequence: 0,
    phase: 'ready',
    loading: false,
    isStreamBuffering: false,
    playback: null,
    track: null,
    queue: null,
    error: null,
    migrationRequired: false,
    cast: null,
    scan: null,
    libraryRevision: 0,
    presentationRevision: null,
    pluginsRevision: null,
    statisticsRevision: null,
    playlistsRevision: null,
    versionsRevision: null,
    audioRevision: null,
    settingsRevision: null,
    sleepTimer: null,
    bookmarksRevision: null,
    lyricsRevision: null,
    lyricsContentRevision: null,
    workspaceRevision: null,
    workspaceContentRevision: null,
    streams: null,
    network: null,
    downloads: null,
    personalized: null,
    heart: null,
    abLoop: null,
    mute: null,
    inbox: null,
    cloudTransfers: null,
    modelPack: null,
    libraryLoudness: null,
    loudness: null,
    ...patch
  }
}

export function coreLibraryPage(page: LibraryPage): CoreLibraryPage {
  return { ...page, tracks: page.tracks.map((track) => projectCoreTrack(track)) }
}

export function playlistRuntime(versions: RecordingVersion[] = []): PlaylistRuntime {
  return {
    now: Date.now,
    newId: () => crypto.randomUUID(),
    clone: structuredClone,
    notify() {},
    identity: createLogicalTrackModel((key) =>
      versions.find((version) => version.sources.includes(key))
    ),
    versions: { ensure() {}, revision: () => 1 },
    repository: {
      load: async () => [],
      save: async () => {
        throw new Error('unused repository')
      }
    }
  }
}
