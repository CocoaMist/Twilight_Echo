import type { LibraryTrackRecord } from './libraryDatabase.ts'
import { getTrackSource } from './trackSourceIdentity.ts'

// Same display/playback fields as the existing playlist snapshot. Transient
// provider URLs, lyrics, analysis and arbitrary extensions are not view input.
const fields = [
  'externalEntry',
  'isrc',
  'title',
  'artist',
  'artists',
  'album',
  'releaseDate',
  'genre',
  'albumArtist',
  'albumId',
  'discNumber',
  'trackNumber',
  'fileName',
  'dir',
  'subTrack',
  'cueRange',
  'cueSheetPath',
  'cueEncoding',
  'duration',
  'size',
  'cover',
  'coverSmall',
  'coverSmallSource',
  'coverSource',
  'source',
  'sourceSelection',
  'ncmSongId',
  'networkSource',
  'audioFingerprint',
  'streamQuality',
  'format',
  'sampleRate',
  'bitrate',
  'bitDepth',
  'bpm',
  'addedAt',
  'replayGainTrackGainDb',
  'replayGainAlbumGainDb',
  'replayGainTrackPeak',
  'replayGainAlbumPeak',
  'r128TrackGainDb',
  'r128AlbumGainDb'
] as const

export function compactPlaylistRecord(track: LibraryTrackRecord): LibraryTrackRecord {
  const result: LibraryTrackRecord = { id: track.id, filePath: track.filePath, lyrics: null }
  for (const field of fields) if (track[field] !== undefined) result[field] = track[field]
  result.source = getTrackSource({
    id: track.id,
    source: typeof track.source === 'string' ? track.source : undefined
  })
  if (
    getTrackSource({
      id: track.id,
      source: typeof track.source === 'string' ? track.source : undefined
    }) === 'local' &&
    track.streamUrl !== undefined
  )
    result.streamUrl = track.streamUrl
  return result
}
