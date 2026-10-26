import type { TrackData } from './track.ts'
type Track = Pick<TrackData, 'title' | 'artist' | 'album'>
import { getPinyinInitials } from './pinyinInitials.ts'

export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

const searchBlobByTrack = new WeakMap<Track, string>()

/**
 * Per-track normalized search blob (`title\0artist\0album`), cached by track
 * identity. Tracks are immutable snapshots replaced wholesale by the store, so
 * identity-keyed caching stays valid for the track's lifetime. The \u0000
 * separator cannot appear in a normalized query, which blocks cross-field
 * substring matches.
 */
export function getTrackSearchBlob(track: Track): string {
  let blob = searchBlobByTrack.get(track)
  if (blob === undefined) {
    const title = normalizeSearchText(track.title)
    const artist = normalizeSearchText(track.artist)
    const album = normalizeSearchText(track.album)
    const titleInitials = getPinyinInitials(track.title)
    const artistInitials = getPinyinInitials(track.artist)
    const albumInitials = getPinyinInitials(track.album)
    blob = [title, artist, album, titleInitials, artistInitials, albumInitials].join('\u0000')
    searchBlobByTrack.set(track, blob)
  }
  return blob
}
