import type { Track } from '../types/music'
import {
  buildMetadataMatchCandidates,
  buildMetadataSearchQueries
} from './musicMetadataMatching.ts'

type SearchSongs = (
  query: string,
  limit: number,
  offset: number,
  signal?: AbortSignal
) => Promise<{ items: Track[] }>

/** Shared by manual rematching and the background queue; broaden only when no match is usable. */
export async function searchMetadataTracks(
  tracks: Track[],
  searchSongs: SearchSongs,
  options: { limit?: number; signal?: AbortSignal } = {}
): Promise<Track[]> {
  const queries = [...new Set(tracks.flatMap(buildMetadataSearchQueries))]
  const candidates = new Map<string, Track>()
  for (const query of queries) {
    options.signal?.throwIfAborted()
    const result = await searchSongs(query, options.limit ?? 30, 0, options.signal)
    options.signal?.throwIfAborted()
    for (const candidate of result.items) {
      if (candidate.source === 'local' || candidate.id.startsWith('local:')) continue
      const key = `${candidate.source ?? ''}:${candidate.id}`
      if (!candidates.has(key)) candidates.set(key, candidate)
    }
    const items = [...candidates.values()]
    if (tracks.every((track) => buildMetadataMatchCandidates(track, items).length > 0)) return items
  }
  return [...candidates.values()]
}
