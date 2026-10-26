import type { TrackData } from './track.ts'
export interface MediaProviderLyrics {
  lyrics: string | null
  translatedLyrics: string | null
  wordLyrics?: string | null
}
export interface LyricProvider {
  id: string
  name: string
  isEnabled?(): boolean | Promise<boolean>
  getLyrics?(track: TrackData, options?: { signal?: AbortSignal }): Promise<MediaProviderLyrics>
  searchSongs?(
    query: string,
    limit?: number,
    offset?: number,
    options?: { signal?: AbortSignal }
  ): Promise<{ items: TrackData[]; total: number }>
}
