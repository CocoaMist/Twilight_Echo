import type {
  IdentificationAlbumRelease,
  IdentificationInput,
  IdentificationSourceInput
} from './musicIdentification.ts'
import type { TrackTagValue } from './trackIdentification.ts'

const norm = (v: string) => v.normalize('NFKC').trim().toLocaleLowerCase('en')
const raw = <T>(v: TrackTagValue<T> | undefined): T | undefined =>
  v && ['audio_tag', 'cue', 'manual'].includes(v.origin) ? v.value : undefined
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0
const same = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => norm(v) === norm(b[i]))
export function albumSourceArtists(s: IdentificationSourceInput): string[] {
  return raw(s.tags.artists) ?? (raw(s.tags.artist) ? [raw(s.tags.artist)!] : [])
}

/** A source grouping is context only. Totals, every position and a single directory
 * must independently establish completeness; display/legacy guesses cannot do so. */
export function localAlbumLayout(input: IdentificationInput) {
  const sources = input.sources ?? [],
    missing: string[] = [],
    conflicts: string[] = []
  if (
    !['album_project', 'release'].includes(input.kind) ||
    !sources.length ||
    sources.length > 64 ||
    input.sourcesTruncated ||
    sources.some((s) => s.tags.truncated)
  )
    missing.push('complete_local_album')
  if (
    sources.some((s) => s.provider !== 'local' || !s.albumCohort) ||
    new Set(sources.map((s) => s.albumCohort)).size !== 1
  )
    missing.push('single_album_cohort')
  const discs = new Map<number, { total: number; positions: Set<number> }>()
  const discTotals = new Set<number>()
  for (const s of sources) {
    const t = s.tags,
      disc = raw(t.discNumber),
      position = raw(t.trackNumber),
      total = raw(t.trackTotal),
      discTotal = raw(t.discTotal)
    if (![disc, position, total, discTotal].every(positive)) {
      missing.push('explicit_track_disc_totals')
      continue
    }
    discTotals.add(discTotal!)
    const d = discs.get(disc!) ?? { total: total!, positions: new Set<number>() }
    if (d.total !== total || d.positions.has(position!) || position! > total! || disc! > discTotal!)
      conflicts.push('duplicate_or_inconsistent_position')
    d.positions.add(position!)
    discs.set(disc!, d)
    if (
      !raw(t.title) ||
      !raw(t.album) ||
      !albumSourceArtists(s).length ||
      !(Number(raw(t.durationSeconds)) > 0)
    )
      missing.push('raw_track_metadata')
    if (raw(t.album) && norm(raw(t.album)!) !== norm(input.name)) conflicts.push('album_title')
  }
  const count = [...discTotals][0]
  if (
    discTotals.size !== 1 ||
    discs.size !== count ||
    [...discs].some(([disc, d]) => disc > count || d.positions.size !== d.total)
  )
    missing.push('complete_local_positions')
  return { missing: [...new Set(missing)], conflicts: [...new Set(conflicts)] }
}

/** Exact full titles and ordered credits retain live/remaster/guest distinctions.
 * IDs are compared as complete sets, never zipped to parallel name arrays. */
export function validateAlbumTracks(
  input: IdentificationInput,
  release: IdentificationAlbumRelease
) {
  const layout = localAlbumLayout(input),
    missing = [...layout.missing],
    conflicts = [...layout.conflicts]
  const sources = input.sources ?? []
  if (missing.length || conflicts.length) return { missing, conflicts, pressing: false }
  if (
    !release.discTrackCounts.length ||
    !release.discTrackCounts.every(positive) ||
    release.discTrackCounts.reduce((a, b) => a + b, 0) !== release.tracks.length ||
    release.tracks.length > 64
  )
    missing.push('complete_remote_tracks')
  if (release.tracks.length !== sources.length) conflicts.push('track_count')
  if (norm(release.title) !== norm(input.name)) conflicts.push('album_title')
  const positions = new Set<string>()
  for (const t of release.tracks) {
    const key = `${t.disc}:${t.position}`
    if (
      !positive(t.disc) ||
      !positive(t.position) ||
      t.position > (release.discTrackCounts[t.disc - 1] ?? 0) ||
      positions.has(key)
    )
      conflicts.push('remote_positions')
    positions.add(key)
  }
  let pressing = false
  for (const s of sources) {
    const tags = s.tags,
      disc = raw(tags.discNumber)!,
      position = raw(tags.trackNumber)!,
      t = release.tracks.find((t) => t.disc === disc && t.position === position)
    if (
      raw(tags.discTotal) !== release.discTrackCounts.length ||
      raw(tags.trackTotal) !== release.discTrackCounts[disc - 1]
    )
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
    if (!Number.isFinite(t.duration) || t.duration <= 0) missing.push('remote_duration')
    else if (Math.abs(raw(tags.durationSeconds)! - t.duration) > 2) conflicts.push('track_duration')
    const mb = tags.musicbrainz
    for (const [expected, actual, field] of [
      [mb?.recordingId, t.recordingId, 'recording_mbid'],
      [mb?.releaseTrackId, t.releaseTrackId, 'release_track_mbid'],
      [mb?.releaseId, release.id, 'release_mbid'],
      [mb?.releaseGroupId, release.projectId, 'release_group_mbid']
    ])
      if (expected) {
        if (!actual) missing.push(field!)
        else if (norm(expected) !== norm(actual)) conflicts.push(field!)
      }
    if (
      mb?.artistIds.length &&
      !same([...mb.artistIds].sort(), t.artists.map((a) => a.id ?? '').sort())
    )
      conflicts.push('track_artist_mbids')
    if (tags.isrcs?.length) {
      if (!t.isrcs.length) missing.push('track_isrcs')
      else if (!tags.isrcs.every((v) => t.isrcs.some((r) => norm(v) === norm(r))))
        conflicts.push('track_isrcs')
    }
    const albumArtists =
      raw(tags.albumArtists) ?? (raw(tags.albumArtist) ? [raw(tags.albumArtist)!] : [])
    if (
      albumArtists.length &&
      !same(
        albumArtists,
        release.artists.map((a) => a.name)
      )
    )
      conflicts.push('album_artists')
    if (
      mb?.albumArtistIds.length &&
      !same([...mb.albumArtistIds].sort(), release.artists.map((a) => a.id ?? '').sort())
    )
      conflicts.push('album_artist_mbids')
    if (tags.barcode) {
      if (!release.barcode) missing.push('barcode')
      else if (tags.barcode !== release.barcode) conflicts.push('barcode')
      else pressing = true
    }
    if (tags.catalogNumbers?.length) {
      if (!release.catalogNumbers.length) missing.push('catalog_number')
      else if (
        !tags.catalogNumbers.every((v) => release.catalogNumbers.some((n) => norm(v) === norm(n)))
      )
        conflicts.push('catalog_number')
      else pressing = true
    }
  }
  return { missing: [...new Set(missing)], conflicts: [...new Set(conflicts)], pressing }
}
