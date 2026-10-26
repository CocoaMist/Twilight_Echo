import type { DatabaseSync } from 'node:sqlite'
import type { TrackArtistRef } from '../../shared/track.ts'

/** A positional, ID-less credit cannot change person when tags are expanded.
 * Adopt its old entity only when the saved name still agrees; keep its manual
 * metadata and identity links on that entity. Named aliases survive reordering.
 */
export function catalogArtistAlias(
  sql: DatabaseSync, provider: string, recording: string, index: number, artist: TrackArtistRef
): { key: string; entityId?: string } {
  const key = JSON.stringify(artist.id !== undefined
    ? [provider, String(artist.id)] : [provider, recording, 'name', artist.name.trim()])
  const find = (key: string) => sql.prepare(`SELECT a.entity_id,e.title FROM catalog_aliases a
    JOIN catalog_entities e ON e.id=a.entity_id WHERE a.namespace='source.artist' AND a.key=?`).get(key)
  const current = find(key)
  if (current) return { key, entityId: String(current.entity_id) }
  if (artist.id === undefined) {
    const legacy = find(JSON.stringify([provider, recording, index]))
    if (legacy && String(legacy.title).trim() === artist.name.trim())
      return { key, entityId: String(legacy.entity_id) }
  }
  return { key }
}
