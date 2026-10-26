import type {
  IdentificationInput,
  IdentificationProposal
} from '../../shared/musicIdentification.ts'
import {
  albumSubsetSourcesUsable,
  verifyAlbumSubset
} from '../../shared/musicAlbumSubsetVerification.ts'
import { musicBrainzAlbum } from './musicIdentificationAlbum.ts'
import type { IdentificationResponse } from './identificationResponseCache.ts'

/** A positive release witness suffices for one unique project. We need not
 * enumerate every pressing, and cannot use this proof to identify any pressing. */
export async function verifyMusicBrainzAlbumSubset(
  input: IdentificationInput,
  proposals: IdentificationProposal[],
  load: (
    url: URL,
    signal: AbortSignal
  ) => Promise<IdentificationResponse<Record<string, unknown> | null>>,
  signal: AbortSignal
) {
  if (!albumSubsetSourcesUsable(input) || proposals.length !== 1) return
  const p = proposals[0]
  if (p.evidence.incomplete || p.evidence.conflicts.length) return
  const ref = p.references[0]
  const browse = new URL('https://musicbrainz.org/ws/2/release')
  browse.search = new URLSearchParams({
    'release-group': ref.value,
    fmt: 'json',
    limit: '4',
    offset: '0'
  }).toString()
  const response = await load(browse, signal)
  const releases = response.value?.releases
  if (
    !Array.isArray(releases) ||
    releases.length > 4 ||
    !Number.isSafeInteger(response.value?.['release-count']) ||
    Number(response.value?.['release-count']) < releases.length
  )
    return
  const receipts = [{ url: browse.href, retrievedAt: response.retrievedAt }]
  for (const row of releases) {
    const id = row?.id
    if (typeof id !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) continue
    signal.throwIfAborted()
    const url = new URL(`https://musicbrainz.org/ws/2/release/${id}`)
    url.search = new URLSearchParams({
      fmt: 'json',
      inc: 'recordings+artist-credits+release-groups+labels+isrcs'
    }).toString()
    const result = await load(url, signal)
    receipts.push({ url: url.href, retrievedAt: result.retrievedAt })
    const release = result.value && musicBrainzAlbum(result.value)
    if (!release || release.id !== id.toLowerCase()) continue
    const proof = {
      method: 'album_subset' as const,
      reference: ref,
      release,
      sourceIds: input.sources!.map((s) => s.sourceId),
      toleranceSeconds: 2 as const
    }
    if (!verifyAlbumSubset(input, proof)) continue
    p.evidence.origin = 'cross_reference'
    p.evidence.verification = proof
    p.evidence.matches.push(
      'partial_album_project',
      'full_titles',
      'all_track_artists',
      'raw_duration_2s'
    )
    p.evidence.missing = p.evidence.missing.filter(
      (m) => !['verified_identity', 'complete_track_validation'].includes(m)
    )
    p.evidence.provenance = JSON.stringify({
      recall: JSON.parse(p.evidence.provenance),
      projectWitness: receipts
    })
    return
  }
  p.evidence.missing.push('project_track_witness')
}
