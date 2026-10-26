import { normalizeNcmFileIdentity } from './ncmFileIdentity.ts'

/** Observations, not confirmed identities. Parallel name/ID arrays are never zipped. */
export type TrackTagOrigin = 'audio_tag' | 'cue' | 'filename' | 'manual' | 'legacy'
export interface TrackTagValue<T> {
  value: T
  origin: TrackTagOrigin
}
export interface TrackIdentityTags {
  version: 1
  scope: 'audio_file' | 'cue_track'
  ncm?: import('./ncmFileIdentity.ts').NcmFileIdentity
  title?: TrackTagValue<string>
  artist?: TrackTagValue<string>
  artists?: TrackTagValue<string[]>
  album?: TrackTagValue<string>
  albumArtist?: TrackTagValue<string>
  albumArtists?: TrackTagValue<string[]>
  genres?: TrackTagValue<string[]>
  /** Original precision; CUE source interval excludes synthetic PREGAP silence. */
  durationSeconds?: TrackTagValue<number>
  trackNumber?: TrackTagValue<number>
  trackTotal?: TrackTagValue<number>
  discNumber?: TrackTagValue<number>
  discTotal?: TrackTagValue<number>
  musicbrainz?: {
    artistIds: string[]
    albumArtistIds: string[]
    recordingId?: string
    /** MusicBrainz release-track ID, not a recording ID. */
    releaseTrackId?: string
    releaseId?: string
    releaseGroupId?: string
  }
  isrcs?: string[]
  barcode?: string
  catalogNumbers?: string[]
  /** Collection limits were reached; never interpret this as complete credits. */
  truncated?: boolean
}

/** File credits are names, not provider identities. Never zip MusicBrainz ID arrays.
 * CUE performers belong to their logical track, not the containing audio file.
 */
export function fileArtistCredits(tags: TrackIdentityTags | undefined): { name: string }[] {
  tags = normalizeTrackIdentityTags(tags)
  if (!tags || tags.scope !== 'audio_file') return []
  const values = tags.ncm?.artists.map(artist => artist.name) ??
    (tags.artists?.origin === 'audio_tag' ? tags.artists.value : [])
  return [...new Set(values.map(name => name.trim()).filter(Boolean))].map(name => ({ name }))
}

/** Keep the catalog's private snapshot data-only and bounded, including plugin input. */
export function normalizeTrackIdentityTags(raw: unknown): TrackIdentityTags | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const input = raw as Record<string, unknown>
  if (input.version !== 1 || !['audio_file', 'cue_track'].includes(String(input.scope)))
    return undefined
  const result: TrackIdentityTags = { version: 1, scope: input.scope as TrackIdentityTags['scope'] }
  const ncm = normalizeNcmFileIdentity(input.ncm)
  if (ncm) result.ncm = ncm
  let remaining = 16384
  const text = (v: unknown): string | undefined => {
    if (typeof v !== 'string' || !v.trim()) return undefined
    const limit = Math.min(2048, remaining)
    if (v.length > limit) result.truncated = true
    const value = v.trim().slice(0, limit)
    remaining -= value.length
    return value || undefined
  }
  const list = (v: unknown): string[] => {
    if (!Array.isArray(v)) return []
    if (v.length > 64) result.truncated = true
    return v.slice(0, 64).flatMap((item) => {
      const value = text(item)
      return value ? [value] : []
    })
  }
  for (const key of [
    'title', 'artist', 'artists', 'album', 'albumArtist', 'albumArtists', 'genres',
    'durationSeconds', 'trackNumber', 'trackTotal', 'discNumber', 'discTotal'
  ] as const) {
    const field = input[key] as TrackTagValue<unknown> | undefined
    if (!field || !['audio_tag', 'cue', 'filename', 'manual', 'legacy'].includes(field.origin))
      continue
    if (['artists', 'albumArtists', 'genres'].includes(key)) {
      const value = list(field.value)
      if (value.length) Object.assign(result, { [key]: { value, origin: field.origin } })
    } else if (['title', 'artist', 'album', 'albumArtist'].includes(key)) {
      const value = text(field.value)
      if (value) Object.assign(result, { [key]: { value, origin: field.origin } })
    } else if (typeof field.value === 'number' && Number.isFinite(field.value) && field.value > 0 &&
      (key === 'durationSeconds' || Number.isSafeInteger(field.value)))
      Object.assign(result, { [key]: { value: field.value, origin: field.origin } })
  }
  if (input.musicbrainz && typeof input.musicbrainz === 'object') {
    const mb = input.musicbrainz as Record<string, unknown>
    result.musicbrainz = { artistIds: list(mb.artistIds), albumArtistIds: list(mb.albumArtistIds) }
    for (const key of ['recordingId', 'releaseTrackId', 'releaseId', 'releaseGroupId'] as const)
      result.musicbrainz[key] = text(mb[key])
  }
  result.isrcs = list(input.isrcs)
  result.barcode = text(input.barcode)
  result.catalogNumbers = list(input.catalogNumbers)
  if (input.truncated === true) result.truncated = true
  return result
}

/** Old cached/display values have unknown history; they cannot become raw tags. */
export function legacyTrackIdentityTags(track: Record<string, unknown>): TrackIdentityTags {
  const tags: TrackIdentityTags = {
    version: 1,
    scope: track.cueRange ? 'cue_track' : 'audio_file'
  }
  for (const key of ['title', 'artist', 'album', 'albumArtist'] as const)
    if (typeof track[key] === 'string' && track[key])
      tags[key] = { value: track[key], origin: 'legacy' }
  for (const key of ['duration', 'trackNumber', 'discNumber'] as const) {
    const value = track[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0)
      tags[key === 'duration' ? 'durationSeconds' : key] = { value, origin: 'legacy' }
  }
  return tags
}
