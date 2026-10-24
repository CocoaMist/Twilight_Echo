import type { MusicCredit, MusicCreditTarget, MusicCreditSet } from '../../shared/musicCredits.ts'
import { musicCreditRole } from '../../shared/musicCredits.ts'
import type { MetadataAttribution } from '../../shared/entityMetadata.ts'
import { validMusicBrainzArtistId as mbid } from '../../shared/entityMetadata.ts'

type Json = Record<string, any>
const string = (v: unknown) => (typeof v === 'string' ? v : '')
const target = (kind: MusicCreditTarget['kind'], value: string): MusicCreditTarget => ({
  provider: 'musicbrainz',
  kind,
  idType: 'mbid',
  value: value.toLowerCase()
})

/** Collect only explicitly related IDs. A title or a participant name is never
 * used to attach a credit to a catalog recording/person. */
export function musicBrainzCredits(
  data: Json,
  root: MusicCreditTarget,
  attribution: MetadataAttribution
): MusicCreditSet {
  const items: MusicCredit[] = []
  let truncated = false
  const seen = new Set<string>()
  const add = (credit: MusicCredit) => {
    const key = JSON.stringify(credit)
    if (seen.has(key)) return
    seen.add(key)
    if (items.length === 2048) {
      truncated = true
      return
    }
    items.push(credit)
  }
  const collect = (node: Json, ref: MusicCreditTarget) => {
    if (!mbid(ref.value)) return
    if (Array.isArray(node['artist-credit']))
      node['artist-credit'].forEach((credit: Json, order: number) => {
        if (!mbid(credit.artist?.id) || !string(credit.name || credit.artist?.name)) return
        add({
          personRef: { ...target('artist', credit.artist.id), kind: 'artist' },
          name: string(credit.name || credit.artist.name),
          targetRef: ref,
          role: 'primary_artist',
          rawRole: 'artist-credit',
          relationTypeId: '',
          direction: '',
          order,
          joinphrase: string(credit.joinphrase),
          attributes: [],
          begin: '',
          end: '',
          attribution
        })
      })
    if (!Array.isArray(node.relations)) return
    node.relations.forEach((relation: Json, order: number) => {
      if (
        relation['target-type'] !== 'artist' ||
        !mbid(relation.artist?.id) ||
        !string(relation.type)
      )
        return
      const rawRole = string(relation.type)
      if (Array.isArray(relation.attributes) && relation.attributes.length > 64) truncated = true
      // Artist relations on an entity point backwards to the contributing
      // artist. A forward relation (e.g. an artist being dedicated to a work)
      // retains its original role rather than being silently inverted.
      add({
        personRef: { ...target('artist', relation.artist.id), kind: 'artist' },
        name: string(relation['target-credit'] || relation.artist.name),
        targetRef: ref,
        rawRole,
        role: musicCreditRole(rawRole),
        relationTypeId: string(relation['type-id']),
        order,
        direction:
          relation.direction === 'forward' || relation.direction === 'backward'
            ? relation.direction
            : '',
        joinphrase: '',
        attributes: Array.isArray(relation.attributes)
          ? relation.attributes.slice(0, 64).map((name: unknown) => ({
              name: string(name),
              ...(string(relation['attribute-values']?.[String(name)])
                ? { value: string(relation['attribute-values'][String(name)]) }
                : {})
            }))
          : [],
        begin: string(relation.begin),
        end: string(relation.end),
        attribution
      })
    })
  }
  collect(data, root)
  if (data['release-group'] && mbid(data['release-group'].id))
    collect(data['release-group'], target('album_project', data['release-group'].id))
  const recordings =
    root.kind === 'recording'
      ? [data]
      : (data.media ?? []).flatMap((medium: Json) =>
          (medium.tracks ?? []).flatMap((track: Json) => (track.recording ? [track.recording] : []))
        )
  for (const recording of recordings) {
    if (!mbid(recording.id)) continue
    if (recording !== data) collect(recording, target('recording', recording.id))
    for (const relation of recording.relations ?? []) {
      if (relation['target-type'] === 'work' && relation.work && mbid(relation.work.id))
        collect(relation.work, target('work', relation.work.id))
    }
  }
  return { items, truncated }
}
