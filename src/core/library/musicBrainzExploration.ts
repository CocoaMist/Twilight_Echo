import type { MetadataAttribution } from '../../shared/entityMetadata.ts'
import { validMusicBrainzArtistId as mbid } from '../../shared/entityMetadata.ts'
import type { MusicCreditTarget } from '../../shared/musicCredits.ts'
import type { MusicExplorationIngest, MusicExplorationReference } from '../../shared/musicExploration.ts'

type Json = Record<string, any>
const text = (v: unknown) => typeof v === 'string' ? v : ''
const ref = (kind: MusicExplorationReference['kind'], value: string): MusicExplorationReference =>
  ({ provider: 'musicbrainz', kind, idType: 'mbid', value: value.toLowerCase() })

/** Recording→work relations prove a recording of a work, not an entire
 * multi-movement performance entity. */
export function musicBrainzExploration(data: Json, root: MusicCreditTarget, attribution: MetadataAttribution): MusicExplorationIngest {
  const nodes: MusicExplorationIngest['nodes'] = []
  const relations: MusicExplorationIngest['relations'] = []
  const seen = new Set<string>(), edges = new Set<string>()
  let truncated = false, projectedBytes = 0
  const add = (reference: MusicExplorationReference, title: unknown) => {
    const key = JSON.stringify(reference)
    if (seen.has(key)) return true
    const node = { reference, title: (text(title) || reference.value).replaceAll('\0', '').slice(0, 1024) || reference.value }
    const bytes = JSON.stringify(node).length + 1
    if (nodes.length >= 500 || projectedBytes + bytes > 900000) { truncated = true; return false }
    seen.add(key); projectedBytes += bytes
    nodes.push(node)
    return true
  }
  add(root, data.title || data.name)
  const recordings = root.kind === 'recording' ? [data] :
    (Array.isArray(data.media) ? data.media : []).flatMap((m: Json) =>
      (Array.isArray(m.tracks) ? m.tracks : []).flatMap((t: Json) => t.recording ? [t.recording] : []))
  recordings.forEach((recording: Json, order: number) => {
    if (!mbid(recording.id)) return
    for (const relation of Array.isArray(recording.relations) ? recording.relations : []) {
      if (relation['target-type'] !== 'work' || relation.type !== 'performance' ||
          relation.direction === 'backward' || !mbid(relation.work?.id)) continue
      const from = ref('work', relation.work.id), to = ref('recording', recording.id)
      const key = JSON.stringify([from, to])
      if (edges.has(key)) continue
      if (relations.length >= 1000) { truncated = true; continue }
      if (!add(from, relation.work.title) || !add(to, recording.title)) continue
      const edge = { from, to, kind: 'work_recording' as const, order, attribution,
        usage: { display: true, cache: true, crossSource: true, export: true } }
      const bytes = JSON.stringify(edge).length + 1
      if (projectedBytes + bytes > 900000) { truncated = true; continue }
      projectedBytes += bytes; edges.add(key)
      relations.push(edge)
    }
  })
  return { owner: root, provider: 'musicbrainz-details', setKey: 'works', nodes, relations, truncated }
}
