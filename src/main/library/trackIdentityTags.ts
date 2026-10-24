import type { ICommonTagsResult } from 'music-metadata'
import type { TrackIdentityTags } from '../../shared/trackIdentification.ts'

/** Read alongside the existing parser. No extra file pass or metadata-version bump. */
export function collectTrackIdentityTags(
  common: Partial<ICommonTagsResult>,
  duration: number | undefined,
  fallback: { title: string; artist: string },
  wave?: { title?: string; artist?: string; album?: string; genre?: string; trackNumber?: number } | null
): TrackIdentityTags {
  const tags: TrackIdentityTags = { version: 1, scope: 'audio_file' }
  const text = (v: unknown): string | undefined => {
    if (typeof v !== 'string' || !v.trim()) return undefined
    if (v.trim().length > 2048) tags.truncated = true
    return v.trim().slice(0, 2048)
  }
  const list = (v: unknown): string[] => {
    if (!Array.isArray(v)) return []
    if (v.length > 64) tags.truncated = true
    return v.slice(0, 64).flatMap((item) => {
      const value = text(item)
      return value ? [value] : []
    })
  }
  for (const key of ['title', 'artist', 'album', 'albumArtist'] as const) {
    const value = text(key === 'albumArtist' ? common.albumartist : wave?.[key] ?? common[key])
    if (value) tags[key] = { value, origin: 'audio_tag' }
    else if (key === 'title' || key === 'artist')
      tags[key] = { value: fallback[key], origin: 'filename' }
  }
  for (const [field, value] of [
    ['artists', common.artists],
    ['albumArtists', common.albumartists],
    ['genres', wave?.genre ? [wave.genre] : common.genre]
  ] as const) {
    const values = list(value)
    if (values.length) tags[field] = { value: values, origin: 'audio_tag' }
  }
  if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0)
    tags.durationSeconds = { value: duration, origin: 'audio_tag' }
  for (const [field, value] of [
    ['trackNumber', wave?.trackNumber ?? common.track?.no],
    ['trackTotal', common.track?.of],
    ['discNumber', common.disk?.no],
    ['discTotal', common.disk?.of]
  ] as const)
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
      tags[field] = { value, origin: 'audio_tag' }
  tags.musicbrainz = {
    artistIds: list(common.musicbrainz_artistid),
    albumArtistIds: list(common.musicbrainz_albumartistid),
    recordingId: text(common.musicbrainz_recordingid),
    releaseTrackId: text(common.musicbrainz_trackid),
    releaseId: text(common.musicbrainz_albumid),
    releaseGroupId: text(common.musicbrainz_releasegroupid)
  }
  tags.isrcs = list(common.isrc)
  tags.barcode = text(common.barcode)
  tags.catalogNumbers = list(common.catalognumber)
  return tags
}
