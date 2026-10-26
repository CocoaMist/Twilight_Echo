import type {
  IdentificationArtistRecording,
  IdentificationInput,
  IdentificationSourceInput,
  IdentificationVerification
} from './musicIdentification.ts'

type Proof = Extract<IdentificationVerification, { method: 'artist_recordings' }>
const norm = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en')
const mbid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
const text = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim() && value.length <= 2048
const observed = (field: { origin: string } | undefined) =>
  !!field && ['audio_tag', 'cue', 'manual'].includes(field.origin)
const names = (source: IdentificationSourceInput) =>
  source.tags.artists?.value ?? (source.tags.artist ? [source.tags.artist.value] : [])

/** Raw observations only: an old display cache or a filename is not identity evidence. */
export function artistRecordingSources(input: IdentificationInput): IdentificationSourceInput[] {
  if (input.kind !== 'artist' || input.sourcesTruncated) return []
  const titles = new Set<string>()
  return (input.sources ?? [])
    .filter((source) => {
      const tags = source.tags,
        artists = names(source)
      if (
        source.provider !== 'local' ||
        tags.truncated ||
        !observed(tags.title) ||
        !observed(tags.durationSeconds) ||
        !observed(tags.artists ?? tags.artist) ||
        !text(tags.title?.value) ||
        !tags.durationSeconds ||
        tags.durationSeconds.value <= 0 ||
        artists.length !== source.artists.length ||
        source.artistIndexes.length !== 1 ||
        !Number.isSafeInteger(source.artistIndexes[0]) ||
        source.artistIndexes[0] < 0 ||
        source.artistIndexes[0] >= artists.length ||
        artists.some((name, i) => norm(name) !== norm(source.artists[i].name))
      )
        return false
      const title = norm(tags.title.value)
      if (titles.has(title)) return false
      titles.add(title)
      return true
    })
    .slice(0, 2)
}

export function validArtistRecordingProof(proof: Proof): boolean {
  return (
    proof.toleranceSeconds === 2 &&
    proof.reference.provider === 'musicbrainz' &&
    proof.reference.kind === 'artist' &&
    proof.reference.idType === 'mbid' &&
    mbid(proof.reference.value) &&
    Array.isArray(proof.samples) &&
    proof.samples.length >= 1 &&
    proof.samples.length <= 2 &&
    proof.samples.length === proof.sourceIds.length &&
    proof.samples.every(
      (sample, i) =>
        sample &&
        sample.sourceId === proof.sourceIds[i] &&
        Array.isArray(sample.recordings) &&
        sample.recordings.length <= 10 &&
        new Set(sample.recordings.map((r) => r?.id)).size === sample.recordings.length &&
        sample.recordings.every(
          (r: IdentificationArtistRecording) =>
            r &&
            mbid(r.id) &&
            text(r.title) &&
            typeof r.duration === 'number' &&
            Number.isFinite(r.duration) &&
            r.duration > 0 &&
            Array.isArray(r.artists) &&
            r.artists.length >= 1 &&
            r.artists.length <= 64 &&
            r.artists.every((a) => a && mbid(a.id) && text(a.name)) &&
            Array.isArray(r.albums) &&
            r.albums.length <= 64 &&
            r.albums.every(text)
        )
    )
  )
}

/** Rechecked by the database inside the existing input/generation-fenced commit.
 * One song needs album + title + duration + every credit; otherwise two distinct songs.
 * A name-search score, or the first same-name result, never authorizes adoption. */
export function verifyArtistRecordings(input: IdentificationInput, proof: Proof): boolean {
  if (!validArtistRecordingProof(proof)) return false
  const sources = artistRecordingSources(input)
  if (
    sources.length !== proof.samples.length ||
    sources.some((s, i) => s.sourceId !== proof.sourceIds[i])
  )
    return false
  let common: Set<string> | null = null
  const used = new Set<string>()
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i],
      expectedNames = names(source),
      tags = source.tags
    if (
      sources.length === 1 &&
      (!observed(tags.album) ||
        !text(tags.album?.value) ||
        /^(unknown(?: album)?|未知专辑)$/i.test(tags.album.value))
    )
      return false
    const recordings = proof.samples[i].recordings.filter(
      (r) =>
        norm(r.title) === norm(tags.title!.value) &&
        (!tags.musicbrainz?.recordingId || tags.musicbrainz.recordingId.toLowerCase() === r.id) &&
        Math.abs(r.duration - tags.durationSeconds!.value) <= 2 &&
        r.artists.length === expectedNames.length &&
        r.artists.every((a, index) => norm(a.name) === norm(expectedNames[index])) &&
        (sources.length > 1 || r.albums.some((album) => norm(album) === norm(tags.album!.value)))
    )
    if (!recordings.length || recordings.some((r) => used.has(r.id))) return false
    recordings.forEach((r) => used.add(r.id))
    const ids = new Set(recordings.map((r) => r.artists[source.artistIndexes[0]].id))
    if (common === null) common = ids
    else {
      const intersection = new Set<string>()
      for (const id of common) if (ids.has(id)) intersection.add(id)
      common = intersection
    }
  }
  return common?.size === 1 && common.has(proof.reference.value)
}
