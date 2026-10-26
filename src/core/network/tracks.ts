import type { NetworkEntry } from '../../shared/networkSources.ts'
import type { TrackData } from '../../shared/track.ts'

/** The logical source stays durable; short-lived playback URLs never enter the queue. */
export function networkEntryToTrack(entry: NetworkEntry, profileName: string): TrackData {
  const metadata = entry.metadata
  return {
    id: entry.id,
    title: metadata?.title ?? entry.name.replace(/\.[^.]+$/, ''),
    artist: metadata?.artist ?? profileName,
    album: metadata?.album ?? profileName,
    filePath: '',
    fileName: entry.name,
    duration: metadata?.duration ?? 0,
    size: entry.sizeBytes ?? 0,
    cover: null,
    lyrics: null,
    source: 'network',
    format: metadata?.format ?? entry.name.split('.').pop(),
    sampleRate: metadata?.sampleRate,
    bitrate: metadata?.bitrate,
    bitDepth: metadata?.bitDepth,
    networkSource: {
      profileId: entry.profileId,
      entry: {
        id: entry.id,
        profileId: entry.profileId,
        name: entry.name,
        path: entry.path,
        kind: entry.kind,
        ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {}),
        ...(entry.mtimeMs !== undefined ? { mtimeMs: entry.mtimeMs } : {})
      }
    }
  }
}
