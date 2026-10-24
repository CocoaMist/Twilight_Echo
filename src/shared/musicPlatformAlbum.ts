/** Optional provider identity data, not a playback list or a physical pressing.
 * Keep in sync with PlatformAlbumIdentity in @twilight-echo/plugin-api. */
export interface PlatformAlbumIdentity {
  schemaVersion: 1
  provider: string
  id: string
  title: string
  artists: Array<{ name: string; id?: string }>
  /** Independent service-reported total. Never use tracks.length as a fallback. */
  trackCount: number | null
  /** Retrieval completeness only; unknown comparison fields remain unknown. */
  complete: boolean
  tracks: Array<{
    id: string
    title: string
    artists: Array<{ name: string; id?: string }>
    durationSeconds: number | null
    /** Actual service ordinals, never inferred from array order or defaulted to 1. */
    disc: number | null
    position: number | null
    isrcs: string[]
  }>
}

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((k) => allowed.includes(k))
const text = (v: unknown, max = 2048): v is string =>
  typeof v === 'string' && v.length <= max && !v.includes('\0')
const id = (v: unknown) => text(v, 512) && !!v.trim()
const positive = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0
const artists = (v: unknown) =>
  Array.isArray(v) &&
  v.length <= 64 &&
  v.every(
    (a) => object(a) && keys(a, ['name', 'id']) && text(a.name) && (a.id === undefined || id(a.id))
  )

/** Strict bounded wire shape. Empty names/credits and null ordinals are missing
 * evidence, not invented values; the album comparator decides completeness. */
export function validPlatformAlbumIdentity(v: unknown): v is PlatformAlbumIdentity {
  return (
    object(v) &&
    keys(v, [
      'schemaVersion',
      'provider',
      'id',
      'title',
      'artists',
      'trackCount',
      'complete',
      'tracks'
    ]) &&
    v.schemaVersion === 1 &&
    text(v.provider, 128) &&
    /^[a-z0-9][a-z0-9._-]*$/.test(v.provider) &&
    !['local', 'musicbrainz'].includes(v.provider) &&
    id(v.id) &&
    text(v.title) &&
    artists(v.artists) &&
    (v.trackCount === null || (Number.isSafeInteger(v.trackCount) && Number(v.trackCount) >= 0)) &&
    typeof v.complete === 'boolean' &&
    Array.isArray(v.tracks) &&
    v.tracks.length <= 64 &&
    v.tracks.every(
      (t) =>
        object(t) &&
        keys(t, ['id', 'title', 'artists', 'durationSeconds', 'disc', 'position', 'isrcs']) &&
        id(t.id) &&
        text(t.title) &&
        artists(t.artists) &&
        (t.durationSeconds === null ||
          (typeof t.durationSeconds === 'number' &&
            Number.isFinite(t.durationSeconds) &&
            t.durationSeconds > 0)) &&
        (t.disc === null || positive(t.disc)) &&
        (t.position === null || positive(t.position)) &&
        Array.isArray(t.isrcs) &&
        t.isrcs.length <= 64 &&
        t.isrcs.every((s) => text(s, 64) && !!s.trim())
    )
  )
}
