import type {
  IdentificationInput,
  IdentificationProposal,
  IdentificationVerification,
  MusicExternalReference
} from './musicIdentification.ts'
import { validMusicExternalReference } from './musicIdentification.ts'
import { albumSourceArtists } from './musicAlbumValidation.ts'

export type AlbumMemberProof = Extract<IdentificationVerification, { method: 'album_member' }>
export interface AlbumMemberView {
  id: string
  tracks: Array<{
    disc: number | null
    position: number | null
    id?: string
    title: string
    artists: Array<{ name: string; id?: string }>
  }>
}
const norm = (s: string) => s.normalize('NFKC').trim().toLocaleLowerCase('en')
const same = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => norm(v) === norm(b[i]))

/** Called only after the parent album proof is validated by the database. Track
 * ordinals establish recording correspondence; full structured credits establish
 * performers. Parallel tag ID arrays and album artists never supply that mapping. */
export function albumMemberProposals(
  child: IdentificationInput,
  parent: IdentificationInput,
  albums: AlbumMemberView[],
  namespace: { provider: string; idType: string },
  receipt: AlbumMemberProof['parent']
): { proposals: IdentificationProposal[]; reason: string | null } {
  const missing = new Set<string>(),
    conflicts = new Set<string>(),
    targets = new Map<string, string>(),
    covered = new Set<string>()
  if (child.sourcesTruncated || child.sources?.some((s) => s.tags.truncated))
    missing.add('complete_member_sources')
  for (const source of child.sources ?? []) {
    const local = parent.sources?.find((s) => s.sourceId === source.sourceId)
    if (!local) {
      missing.add('member_sources_outside_album')
      continue
    }
    covered.add(source.sourceId)
    for (const album of albums) {
      const track = album.tracks.find(
        (t) =>
          t.disc === local.tags.discNumber?.value && t.position === local.tags.trackNumber?.value
      )
      if (!track) {
        missing.add('member_track_position')
        continue
      }
      if (child.kind === 'recording') {
        if (!track.id) {
          missing.add('recording_identity')
          continue
        }
        targets.set(track.id, track.title)
        if (norm(child.name) !== norm(track.title)) conflicts.add('member_name')
      } else if (child.kind === 'artist') {
        const names = albumSourceArtists(source)
        if (
          !source.artistIndexes.length ||
          !same(
            source.artists.map((a) => a.name),
            names
          )
        ) {
          missing.add('artist_credit_alignment')
          continue
        }
        for (const index of source.artistIndexes) {
          const name = names[index]
          if (!name || !track.artists[index] || norm(track.artists[index].name) !== norm(name)) {
            missing.add('artist_credit_alignment')
            continue
          }
          // Two different people can have the same credit name. Equal strings do
          // not establish which of their IDs belongs to a local credit position.
          const credits = track.artists.filter((a) => norm(a.name) === norm(name))
          if (credits.length !== 1) missing.add('ambiguous_artist_credit')
          for (const artist of credits) {
            if (!artist.id) {
              missing.add('artist_identity')
              continue
            }
            targets.set(artist.id, artist.name)
            if (norm(child.name) !== norm(artist.name)) conflicts.add('member_name')
          }
        }
      }
    }
  }
  if (targets.size > 1) missing.add('unique_album_member_identity')
  if (targets.size > 4) missing.add('member_candidate_limit')
  const entries = [...targets]
    .slice(0, 4)
    .map(([id, name]) => {
      // Existing indexed recording identities use the provider-qualified Track.id;
      // the new album capability returns service IDs. Preserve that established key.
      const value =
        child.kind === 'recording' &&
        namespace.provider !== 'musicbrainz' &&
        !id.startsWith(namespace.provider + ':')
          ? `${namespace.provider}:${id}`
          : id
      const reference: MusicExternalReference = { ...namespace, kind: child.kind, value }
      return { name, reference }
    })
    .filter(({ reference }) => {
      // A valid service ID can exceed the established reference bound once it is
      // provider-qualified. Skip that child identity, not the verified parent.
      if (validMusicExternalReference(reference)) return true
      missing.add('member_reference_limit')
      return false
    })
  const proposals = entries.map(({ name, reference }): IdentificationProposal => {
    return {
      provider: namespace.provider,
      name,
      summary: parent.name,
      references: [reference],
      matcherVersion: 'album-members-v1',
      evidence: {
        origin: 'cross_reference',
        matches: ['validated_album_member', 'explicit_track_position'],
        missing: [...missing],
        conflicts: [...conflicts],
        incomplete: missing.size > 0,
        provenance: JSON.stringify({
          method: 'album-members-v1',
          parent: receipt,
          albums: albums.map((a) => a.id)
        }),
        verification: {
          method: 'album_member',
          reference,
          sourceIds: [...covered],
          parent: receipt
        }
      }
    }
  })
  return {
    proposals,
    reason: [...missing, ...conflicts][0] ?? (targets.size ? null : 'missing_member_identity')
  }
}
