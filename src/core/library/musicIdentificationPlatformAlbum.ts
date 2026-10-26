import type {
  IdentificationInput,
  IdentificationProposal
} from '../../shared/musicIdentification.ts'
import { localAlbumLayout } from '../../shared/musicAlbumValidation.ts'
import { validPlatformAlbumIdentity } from '../../shared/musicPlatformAlbum.ts'
import type { PlatformAlbumIdentity } from '../../shared/musicPlatformAlbum.ts'
import { validatePlatformAlbum } from '../../shared/musicPlatformAlbumValidation.ts'
import type { IdentificationResponse } from './identificationResponseCache.ts'

/** One complete search page plus at most four detailed lookups. Unknown or
 * incomplete comparisons keep the entire candidate set reviewable. */
export async function verifyPlatformAlbums(
  input: IdentificationInput,
  proposals: IdentificationProposal[],
  provider: string,
  load: (id: string, signal: AbortSignal) => Promise<IdentificationResponse<unknown>>,
  signal: AbortSignal
) {
  const layout = localAlbumLayout(input),
    reasons: string[] = []
  if (layout.missing.length || layout.conflicts.length) {
    for (const p of proposals) {
      p.evidence.missing.push(...layout.missing)
      p.evidence.conflicts.push(...layout.conflicts)
    }
    return { incomplete: false, reasons }
  }
  // Search display credits may be abbreviated. Full structured credits below
  // decide the comparison; the exact album title still limits recall.
  const candidates = proposals.filter((p) => !p.evidence.conflicts.includes('name'))
  let incomplete = candidates.length > 4
  if (incomplete) reasons.push('album_candidate_limit')
  const matches: Array<{ p: IdentificationProposal; album: PlatformAlbumIdentity }> = []
  for (const p of candidates.slice(0, 4)) {
    signal.throwIfAborted()
    const id = p.references[0].value,
      response = await load(id, signal), album = response.value
    signal.throwIfAborted()
    if (!validPlatformAlbumIdentity(album) || album.provider !== provider || album.id !== id) {
      incomplete = true
      p.evidence.missing.push('valid_platform_album_identity')
      reasons.push('invalid_platform_album_identity')
      continue
    }
    const validation = validatePlatformAlbum(input, album)
    p.evidence.matches = p.evidence.matches.filter((c) => c !== 'artist_credit')
    p.evidence.conflicts = p.evidence.conflicts.filter((c) => c !== 'artist_credit')
    p.evidence.missing = p.evidence.missing.filter((c) => c !== 'artist_credit')
    p.evidence.missing.push(...validation.missing)
    p.evidence.conflicts.push(...validation.conflicts)
    if (validation.missing.length) {
      incomplete = true
      reasons.push('incomplete_platform_album_comparison')
    }
    if (!validation.missing.length && !validation.conflicts.length) {
      p.evidence.origin = 'album_tracks'
      p.evidence.matches.push(
        'complete_album_tracks',
        'track_positions',
        'full_titles',
        'all_track_artists',
        'raw_duration_2s'
      )
      p.evidence.missing = p.evidence.missing.filter(
        (m) =>
          !['verified_identity', 'complete_track_validation', 'pressing_disambiguation'].includes(m)
      )
      matches.push({ p, album })
    }
    p.evidence.provenance = JSON.stringify({
      recall: JSON.parse(p.evidence.provenance),
      albumValidation: {
        provider,
        method: 'fetchAlbumIdentity',
        id,
        trackCount: album.trackCount,
        complete: album.complete,
        retrievedAt: response.retrievedAt
      }
    })
  }
  if (matches.length > 1)
    for (const { p } of matches) p.evidence.missing.push('unique_platform_album')
  if (matches.length === 1 && !incomplete && !matches[0].p.evidence.incomplete) {
    const { p, album } = matches[0]
    p.evidence.verification = {
      method: 'platform_album_tracks',
      reference: p.references[0],
      sourceIds: (input.sources ?? []).map((s) => s.sourceId),
      album,
      matchedAlbumIds: [album.id],
      toleranceSeconds: 2
    }
  }
  for (const p of proposals) {
    p.evidence.incomplete ||= incomplete
    p.evidence.missing = [...new Set(p.evidence.missing)]
    p.evidence.conflicts = [...new Set(p.evidence.conflicts)]
  }
  return { incomplete, reasons }
}
