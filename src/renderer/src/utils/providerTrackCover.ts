import type { MediaProvider } from '../providers/mediaProvider.ts'
import type { Track } from '../types/music.ts'

export type ProviderTrackCover = Pick<Track, 'cover' | 'coverSource' | 'coverSmall' | 'coverSmallSource'>

/** Only borrow artwork from the same provider track identity, never a title-only hit. */
export async function findExactProviderTrackCover(
  track: Track,
  provider: MediaProvider,
  signal?: AbortSignal
): Promise<ProviderTrackCover | null> {
  if (!provider.searchSongs || !track.title.trim()) return null
  const query = [track.title, track.artist].filter(Boolean).join(' ')
  const page = await provider.searchSongs(query, 20, 0, { signal })
  signal?.throwIfAborted()
  const match = page.items.find(
    (candidate) =>
      candidate.id === track.id &&
      (candidate.source === provider.id || !candidate.source) &&
      Boolean(candidate.cover || candidate.coverSource || candidate.coverSmall || candidate.coverSmallSource)
  )
  if (!match) return null
  return {
    cover: match.cover ?? match.coverSmall ?? null,
    coverSource: match.coverSource ?? match.cover ?? match.coverSmallSource ?? match.coverSmall ?? null,
    coverSmall: match.coverSmall ?? null,
    coverSmallSource: match.coverSmallSource ?? match.coverSource ?? match.cover ?? match.coverSmall ?? null
  }
}
