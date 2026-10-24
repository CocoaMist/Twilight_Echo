import type {
  IdentificationInput,
  IdentificationSourceInput,
  IdentificationVerification,
  MusicExternalReference,
  IdentificationAlbumRelease
} from './musicIdentification.ts'
import { validMusicExternalReference } from './musicIdentification.ts'
import { validPlatformAlbumIdentity } from './musicPlatformAlbum.ts'

export function explicitMusicBrainzIds(input: IdentificationInput) {
  const ids = new Map<string, boolean>()
  for (const s of input.sources ?? []) {
    const mb = s.tags.musicbrainz
    if (!mb) continue
    const values =
      input.kind === 'artist'
        ? mb.artistIds
        : [
            input.kind === 'recording'
              ? mb.recordingId
              : input.kind === 'release'
                ? mb.releaseId
                : mb.releaseGroupId
          ]
    const aligned =
      input.kind !== 'artist' ||
      (s.artists.length === 1 &&
        s.artistIndexes.length === 1 &&
        s.artistIndexes[0] === 0 &&
        mb.artistIds.length === 1 &&
        (s.tags.artists?.value.length ?? 1) === 1)
    for (const value of values)
      if (value) {
        const id = value.toLowerCase()
        ids.set(id, (ids.get(id) ?? true) && aligned)
      }
  }
  return ids
}
export const nativeIdentificationId = (value: unknown): string => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return typeof value === 'string' && value.trim() && value.length <= 512 && !value.includes('\0')
    ? value
    : ''
}
export function sourceNativeIds(
  input: IdentificationInput,
  s: IdentificationSourceInput
): string[] {
  return input.kind === 'artist'
    ? s.artistIndexes.map((i) => nativeIdentificationId(s.artists[i]?.id)).filter(Boolean)
    : input.kind === 'recording'
      ? [nativeIdentificationId(s.trackId)].filter(Boolean)
      : input.kind === 'release'
        ? [nativeIdentificationId(s.albumId)].filter(Boolean)
        : []
}
export function identityProofSources(input: IdentificationInput, ref: MusicExternalReference) {
  return (input.sources ?? [])
    .filter((s) => {
      if (ref.provider === 'musicbrainz')
        return explicitMusicBrainzIds({ ...input, sources: [s] }).get(ref.value) === true
      return s.provider === ref.provider && sourceNativeIds(input, s).includes(ref.value)
    })
    .map((s) => s.sourceId)
}
export function validIdentificationVerification(
  v: IdentificationVerification | undefined
): boolean {
  if (v === undefined) return true
  if (
    !v ||
    !validMusicExternalReference(v.reference) ||
    !Array.isArray(v.sourceIds) ||
    !v.sourceIds.length ||
    v.sourceIds.length > 64 ||
    v.sourceIds.some((s) => typeof s !== 'string' || !s || s.length > 128) ||
    new Set(v.sourceIds).size !== v.sourceIds.length
  )
    return false
  if (v.method === 'typed_id' || v.method === 'provider_native') return true
  if (v.method === 'album_member') return !!v.parent &&
    ['artist', 'recording'].includes(v.reference.kind) &&
    [v.parent.entityId, v.parent.candidateId].every(s => typeof s === 'string' && !!s && s.length <= 128) &&
    Number.isSafeInteger(v.parent.historySeq) && v.parent.historySeq > 0 &&
    Number.isSafeInteger(v.parent.linkRevision) && v.parent.linkRevision > 0
  if (v.method === 'platform_album_tracks') return v.toleranceSeconds === 2 &&
    validPlatformAlbumIdentity(v.album) && v.reference.kind === 'release' &&
    v.reference.idType === 'native' && v.reference.provider === v.album.provider &&
    v.reference.value === v.album.id && Array.isArray(v.matchedAlbumIds) &&
    v.matchedAlbumIds.length === 1 && v.matchedAlbumIds[0] === v.album.id
  if (
    v.method !== 'album_tracks' ||
    v.toleranceSeconds !== 2 ||
    !Array.isArray(v.matchedReleaseIds) ||
    !v.matchedReleaseIds.length ||
    v.matchedReleaseIds.length > 4 ||
    !v.matchedReleaseIds.every(mbid) ||
    !validAlbumRelease(v.release) ||
    !v.matchedReleaseIds.includes(v.release.id)
  )
    return false
  if (v.matchedReleases !== undefined && (!Array.isArray(v.matchedReleases) ||
    v.matchedReleases.length !== v.matchedReleaseIds.length ||
    !v.matchedReleases.every(validAlbumRelease) ||
    new Set(v.matchedReleases.map(r => r.id)).size !== v.matchedReleases.length ||
    !v.matchedReleases.every(r => v.matchedReleaseIds.includes(r.id)) ||
    JSON.stringify(v.matchedReleases.find(r => r.id === v.release.id)) !== JSON.stringify(v.release))) return false
  return true
}
const mbid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v)
const text = (v: unknown) => typeof v === 'string' && v.length <= 2048
const artists = (v: IdentificationAlbumRelease['artists']) =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.length <= 64 &&
  v.every((a) => a && text(a.name) && !!a.name && (a.id === undefined || mbid(a.id)))
export function validAlbumRelease(r: IdentificationAlbumRelease): boolean {
  return (
    !!r &&
    mbid(r.id) &&
    mbid(r.projectId) &&
    text(r.title) &&
    !!r.title &&
    artists(r.artists) &&
    text(r.barcode) &&
    Array.isArray(r.catalogNumbers) &&
    r.catalogNumbers.length <= 64 &&
    r.catalogNumbers.every(text) &&
    Array.isArray(r.discTrackCounts) &&
    r.discTrackCounts.length > 0 &&
    r.discTrackCounts.length <= 64 &&
    r.discTrackCounts.every((n) => Number.isSafeInteger(n) && n > 0 && n <= 64) &&
    Array.isArray(r.tracks) &&
    r.tracks.length > 0 &&
    r.tracks.length <= 64 &&
    r.tracks.every(
      (t) =>
        t &&
        Number.isSafeInteger(t.disc) &&
        Number.isSafeInteger(t.position) &&
        text(t.title) &&
        !!t.title &&
        artists(t.artists) &&
        typeof t.duration === 'number' &&
        Number.isFinite(t.duration) &&
        t.duration >= 0 &&
        Array.isArray(t.isrcs) &&
        t.isrcs.length <= 64 &&
        t.isrcs.every(text) &&
        (t.recordingId === undefined || mbid(t.recordingId)) &&
        (t.releaseTrackId === undefined || mbid(t.releaseTrackId))
    )
  )
}
