import type {
  IdentificationAlbumRelease,
  IdentificationInput,
  IdentificationProposal
} from '../../shared/musicIdentification.ts'
import { localAlbumLayout, validateAlbumTracks } from '../../shared/musicAlbumValidation.ts'
import { validAlbumRelease } from '../../shared/musicIdentificationVerification.ts'
import type { IdentificationResponse } from './identificationResponseCache.ts'

const MAX_RELEASES = 4
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const credits = (v: unknown) =>
  rows(v).map((c) => {
    const credit = obj(c),
      artist = obj(credit.artist)
    return {
      name: str(credit.name) || str(artist.name),
      id: str(artist.id).toLowerCase() || undefined
    }
  })
export function musicBrainzAlbum(raw: Record<string, unknown>): IdentificationAlbumRelease | null {
  const media = rows(raw.media)
  // No slice: a larger/malformed response is incomplete, not a unique subset.
  if (
    !media.length ||
    media.length > 64 ||
    media.some(
      (m, i) =>
        obj(m).position !== i + 1 ||
        obj(m).pregap != null ||
        rows(obj(m)['data-tracks']).length ||
        Number(obj(m)['track-offset'] ?? 0) !== 0
    )
  )
    return null
  const release: IdentificationAlbumRelease = {
    id: str(raw.id).toLowerCase(),
    projectId: str(obj(raw['release-group']).id).toLowerCase(),
    title: str(raw.title),
    artists: credits(raw['artist-credit']),
    barcode: str(raw.barcode),
    catalogNumbers: rows(raw['label-info'])
      .map((l) => str(obj(l)['catalog-number']))
      .filter(Boolean),
    discTrackCounts: media.map((m) => Number(obj(m)['track-count'])),
    tracks: media.flatMap((m) =>
      rows(obj(m).tracks).map((t) => {
        const track = obj(t),
          recording = obj(track.recording)
        return {
          disc: Number(obj(m).position),
          position: Number(track.position),
          title: str(track.title),
          artists: credits(track['artist-credit'] ?? recording['artist-credit']),
          duration: typeof track.length === 'number' ? track.length / 1000 : 0,
          recordingId: str(recording.id).toLowerCase() || undefined,
          releaseTrackId: str(track.id).toLowerCase() || undefined,
          isrcs: rows(recording.isrcs).map(str)
        }
      })
    )
  }
  return validAlbumRelease(release) ? release : null
}

/** Search + at most four project browses + four full releases. A budget hit,
 * unknown count or malformed response prevents every automatic album decision. */
export async function verifyMusicBrainzAlbums(
  input: IdentificationInput,
  proposals: IdentificationProposal[],
  load: (url: URL, signal: AbortSignal) => Promise<IdentificationResponse<Record<string, unknown> | null>>,
  signal: AbortSignal
) {
  const reasons: string[] = [],
    layout = localAlbumLayout(input)
  if (layout.missing.length || layout.conflicts.length) {
    for (const p of proposals) {
      p.evidence.missing.push(...layout.missing)
      p.evidence.conflicts.push(...layout.conflicts)
    }
    return { incomplete: false, reasons }
  }
  const candidates = proposals.filter((p) => !p.evidence.conflicts.length)
  let incomplete = candidates.length > MAX_RELEASES,
    remaining = MAX_RELEASES
  if (incomplete) reasons.push('album_candidate_limit')
  const cache = new Map<string, IdentificationAlbumRelease | null>()
  const outcomes: Array<{
    p: IdentificationProposal
    matches: IdentificationAlbumRelease[]
    pressing: boolean
  }> = []
  for (const p of candidates.slice(0, MAX_RELEASES)) {
    signal.throwIfAborted()
    const ref = p.references[0],
      receipts: Array<{ url: string; retrievedAt: number }> = []
    let ids = [ref.value]
    if (input.kind === 'album_project') {
      const url = new URL('https://musicbrainz.org/ws/2/release')
      url.search = new URLSearchParams({
        'release-group': ref.value,
        limit: String(MAX_RELEASES),
        offset: '0',
        fmt: 'json'
      }).toString()
      const response = await load(url, signal), data = response.value,
        releases = data?.releases
      receipts.push({ url: url.href, retrievedAt: response.retrievedAt })
      if (
        !Array.isArray(releases) ||
        !Number.isSafeInteger(data?.['release-count']) ||
        Number(data?.['release-count']) !== releases.length ||
        releases.length > MAX_RELEASES
      ) {
        incomplete = true
        reasons.push('incomplete_project_releases')
      }
      ids = rows(releases).map((r) => str(obj(r).id).toLowerCase())
      if (new Set(ids).size !== ids.length) {
        incomplete = true
        reasons.push('duplicate_release_identity')
      }
    }
    const matches: IdentificationAlbumRelease[] = [],
      failures: string[] = [],
      missing: string[] = []
    let pressing = false
    for (const id of ids.slice(0, MAX_RELEASES)) {
      if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) {
        incomplete = true
        reasons.push('invalid_release_identity')
        continue
      }
      if (!cache.has(id)) {
        if (remaining <= 0) {
          incomplete = true
          reasons.push('album_release_lookup_limit')
          break
        }
        remaining--
        const url = new URL(`https://musicbrainz.org/ws/2/release/${id}`)
        url.search = new URLSearchParams({
          fmt: 'json',
          inc: 'recordings+artist-credits+release-groups+labels+isrcs'
        }).toString()
        const response = await load(url, signal), data = response.value
        receipts.push({ url: url.href, retrievedAt: response.retrievedAt })
        cache.set(id, data ? musicBrainzAlbum(data) : null)
      }
      const release = cache.get(id)
      if (
        !release ||
        release.id !== id ||
        (input.kind === 'album_project' && release.projectId !== ref.value)
      ) {
        incomplete = true
        reasons.push('invalid_or_incomplete_release_tracks')
        continue
      }
      const v = validateAlbumTracks(input, release)
      if (v.missing.length) {
        incomplete = true
        reasons.push('incomplete_track_comparison')
      }
      if (!v.missing.length && !v.conflicts.length) {
        matches.push(release)
        pressing ||= v.pressing
      } else {
        failures.push(...v.conflicts)
        missing.push(...v.missing)
      }
    }
    if (!matches.length) {
      p.evidence.conflicts.push(...new Set(failures))
      p.evidence.missing.push(...new Set(missing))
    } else {
      p.evidence.origin = 'album_tracks'
      p.evidence.matches.push(
        'complete_album_tracks',
        'track_positions',
        'full_titles',
        'all_track_artists',
        'raw_duration_2s'
      )
      p.evidence.missing = p.evidence.missing.filter(
        (m) => !['verified_identity', 'complete_track_validation'].includes(m)
      )
      if (pressing)
        p.evidence.missing = p.evidence.missing.filter((m) => m !== 'pressing_disambiguation')
    }
    p.evidence.provenance = JSON.stringify({
      recall: JSON.parse(p.evidence.provenance),
      albumValidation: receipts
    })
    outcomes.push({ p, matches, pressing })
  }
  for (const { p, matches, pressing } of outcomes) {
    p.evidence.incomplete ||= incomplete
    if (
      matches.length &&
      !p.evidence.incomplete &&
      !p.evidence.conflicts.length &&
      (input.kind === 'album_project' || pressing)
    )
      p.evidence.verification = {
        method: 'album_tracks',
        reference: p.references[0],
        sourceIds: (input.sources ?? []).map((s) => s.sourceId),
        release: matches[0],
        matchedReleaseIds: matches.map((r) => r.id),
        matchedReleases: matches,
        toleranceSeconds: 2
      }
  }
  return { incomplete, reasons: [...new Set(reasons)] }
}
