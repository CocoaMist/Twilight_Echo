import type { IdentificationInput, IdentificationVerification } from './musicIdentification.ts'
import { albumSourceArtists, localAlbumLayout } from './musicAlbumValidation.ts'

type Proof = Extract<IdentificationVerification, { method: 'album_subset' }>
const norm = (s: string) => s.normalize('NFKC').trim().toLocaleLowerCase('en')
const raw = (v: { origin: string } | undefined) =>
  !!v && ['audio_tag', 'cue', 'manual'].includes(v.origin)
const same = (a: string[], b: string[]) =>
  a.length === b.length && a.every((name, i) => norm(name) === norm(b[i]))

export function albumSubsetSourcesUsable(input: IdentificationInput): boolean {
  return (
    input.kind === 'album_project' &&
    !input.sourcesTruncated &&
    !localAlbumLayout(input).conflicts.length &&
    !!input.sources?.length &&
    input.sources.length <= 64 &&
    input.sources.every((s) => {
      const tags = s.tags
      return (
        s.provider === 'local' &&
        !tags.truncated &&
        raw(tags.title) &&
        raw(tags.album) &&
        raw(tags.artists ?? tags.artist) &&
        raw(tags.durationSeconds) &&
        !!tags.title?.value.trim() &&
        !!tags.album?.value.trim() &&
        albumSourceArtists(s).length > 0 &&
        Number.isFinite(tags.durationSeconds?.value) &&
        tags.durationSeconds!.value > 0 &&
        norm(tags.album.value) === norm(input.name)
      )
    })
  )
}

/** Positive membership in a fully loaded release of one unambiguous project.
 * No completeness, pressing, track-position or child-identity claim is made. */
export function verifyAlbumSubset(input: IdentificationInput, proof: Proof): boolean {
  const sources = input.sources ?? [],
    release = proof.release,
    ref = proof.reference
  if (
    !albumSubsetSourcesUsable(input) ||
    sources.length > 64 ||
    sources.length !== proof.sourceIds.length ||
    sources.some((s, i) => s.sourceId !== proof.sourceIds[i]) ||
    ref.provider !== 'musicbrainz' ||
    ref.kind !== 'album_project' ||
    ref.idType !== 'mbid' ||
    ref.value !== release.projectId ||
    proof.toleranceSeconds !== 2 ||
    norm(input.name) !== norm(release.title) ||
    norm(input.artist) !== norm(release.artists.map((a) => a.name).join(' / '))
  )
    return false
  // A release with omitted/duplicate positions is not a complete remote witness.
  if (
    release.discTrackCounts.reduce((n, count) => n + count, 0) !== release.tracks.length ||
    new Set(release.tracks.map((t) => `${t.disc}:${t.position}`)).size !== release.tracks.length ||
    release.tracks.some(
      (t) => t.disc < 1 || t.position < 1 || t.position > (release.discTrackCounts[t.disc - 1] ?? 0)
    )
  )
    return false
  return sources.every((s) => {
    const tags = s.tags,
      artists = albumSourceArtists(s)
    const albumArtists =
      tags.albumArtists ??
      (tags.albumArtist && {
        value: [tags.albumArtist.value],
        origin: tags.albumArtist.origin
      })
    if (
      albumArtists &&
      (!raw(albumArtists) ||
        !same(
          albumArtists.value,
          release.artists.map((a) => a.name)
        ))
    )
      return false
    const mb = tags.musicbrainz
    if (mb?.releaseGroupId && norm(mb.releaseGroupId) !== ref.value) return false
    if (mb?.releaseId && mb.releaseId.toLowerCase() !== release.id) return false
    if (
      mb?.albumArtistIds.length &&
      !same([...mb.albumArtistIds].sort(), release.artists.map((a) => a.id ?? '').sort())
    )
      return false
    if (tags.barcode && tags.barcode !== release.barcode) return false
    if (tags.catalogNumbers?.some((n) => !release.catalogNumbers.some((r) => norm(r) === norm(n))))
      return false
    return release.tracks.some(
      (t) =>
        norm(t.title) === norm(tags.title!.value) &&
        same(
          artists,
          t.artists.map((a) => a.name)
        ) &&
        t.duration > 0 &&
        Math.abs(t.duration - tags.durationSeconds!.value) <= 2 &&
        (!mb?.recordingId || mb.recordingId.toLowerCase() === t.recordingId) &&
        (!mb?.releaseTrackId || mb.releaseTrackId.toLowerCase() === t.releaseTrackId) &&
        (!mb?.artistIds.length ||
          same([...mb.artistIds].sort(), t.artists.map((a) => a.id ?? '').sort())) &&
        (!tags.isrcs?.length || tags.isrcs.every((id) => t.isrcs.some((r) => norm(r) === norm(id))))
    )
  })
}
