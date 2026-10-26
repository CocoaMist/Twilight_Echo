import type { IdentificationInput } from './musicIdentification.ts'
import type { PlatformAlbumIdentity } from './musicPlatformAlbum.ts'
import { validPlatformAlbumIdentity } from './musicPlatformAlbum.ts'
import { albumSourceArtists, localAlbumLayout } from './musicAlbumValidation.ts'

const norm = (v: string) => v.normalize('NFKC').trim().toLocaleLowerCase('en')
const same = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => norm(v) === norm(b[i]))
const raw = <T>(v: { value: T; origin: string } | undefined) =>
  v && ['audio_tag', 'cue', 'manual'].includes(v.origin) ? v.value : undefined

/** Establishes only a native platform album, not MB IDs or a specific pressing.
 * Disc counts are derived only after an independent total proves retrieval. */
export function validatePlatformAlbum(input: IdentificationInput, album: PlatformAlbumIdentity) {
  const layout = localAlbumLayout(input),
    missing = [...layout.missing],
    conflicts = [...layout.conflicts]
  if (!validPlatformAlbumIdentity(album)) return { missing: ['invalid_platform_album'], conflicts }
  if (input.kind !== 'release') missing.push('platform_release_layer')
  if (
    !album.complete ||
    album.trackCount === null ||
    album.trackCount <= 0 ||
    album.trackCount !== album.tracks.length ||
    !album.tracks.length
  )
    missing.push('complete_remote_tracks')
  if (new Set(album.tracks.map((t) => t.id)).size !== album.tracks.length)
    conflicts.push('duplicate_remote_track_id')
  if (!album.title.trim()) missing.push('remote_album_title')
  else if (norm(album.title) !== norm(input.name)) conflicts.push('album_title')
  if (!album.artists.length || album.artists.some((a) => !a.name.trim()))
    missing.push('remote_album_artists')
  const discs = new Map<number, Set<number>>()
  for (const t of album.tracks) {
    if (t.disc === null || t.position === null) {
      missing.push('remote_positions')
      continue
    }
    const positions = discs.get(t.disc) ?? new Set<number>()
    if (positions.has(t.position)) conflicts.push('duplicate_remote_position')
    positions.add(t.position)
    discs.set(t.disc, positions)
    if (!t.title.trim()) missing.push('remote_track_title')
    if (!t.artists.length || t.artists.some((a) => !a.name.trim()))
      missing.push('remote_track_artists')
    if (t.durationSeconds === null) missing.push('remote_duration')
  }
  if (
    [...discs].some(
      ([disc, positions]) => disc > discs.size || [...positions].some((p) => p > positions.size)
    )
  )
    conflicts.push('remote_position_gaps')
  const sources = input.sources ?? []
  if (album.trackCount !== null && album.trackCount !== sources.length)
    conflicts.push('track_count')
  // Do not attempt positional comparison until the local layout is established.
  if (!layout.missing.length && !layout.conflicts.length)
    for (const s of sources) {
      const tags = s.tags,
        disc = raw(tags.discNumber)!,
        position = raw(tags.trackNumber)!,
        t = album.tracks.find((t) => t.disc === disc && t.position === position)
      if (raw(tags.discTotal) !== discs.size || raw(tags.trackTotal) !== discs.get(disc)?.size)
        conflicts.push('disc_track_totals')
      if (!t) {
        conflicts.push('track_position')
        continue
      }
      if (norm(raw(tags.title)!) !== norm(t.title)) conflicts.push('track_title')
      if (
        !same(
          albumSourceArtists(s),
          t.artists.map((a) => a.name)
        )
      )
        conflicts.push('track_artists')
      if (
        t.durationSeconds !== null &&
        Math.abs(raw(tags.durationSeconds)! - t.durationSeconds) > 2
      )
        conflicts.push('track_duration')
      const albumArtists =
        raw(tags.albumArtists) ?? (raw(tags.albumArtist) ? [raw(tags.albumArtist)!] : [])
      if (
        albumArtists.length &&
        !same(
          albumArtists,
          album.artists.map((a) => a.name)
        )
      )
        conflicts.push('album_artists')
      if (tags.isrcs?.length) {
        if (!t.isrcs.length) missing.push('track_isrcs')
        else if (!tags.isrcs.every((v) => t.isrcs.some((r) => norm(v) === norm(r))))
          conflicts.push('track_isrcs')
      }
    }
  return { missing: [...new Set(missing)], conflicts: [...new Set(conflicts)] }
}
