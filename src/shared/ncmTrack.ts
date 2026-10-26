import type { TrackData as Track } from './track.ts'

export function getNcmSongId(track: Pick<Track, 'id' | 'ncmSongId'>): number | null {
  if (track.ncmSongId != null) return track.ncmSongId
  if (!track.id.startsWith('ncm:')) return null
  const localId = track.id.slice('ncm:'.length)
  const songId = Number(localId)
  return Number.isFinite(songId) && songId > 0 ? songId : null
}
