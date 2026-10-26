import type { TrackIdentityTags } from './trackIdentification.ts'
import type { IdentificationInput } from './musicIdentification.ts'

/** Paired IDs and names declared in a file's NetEase metadata, never a search guess. */
export interface NcmFileIdentity {
  recordingId: string
  releaseId: string
  title: string
  album: string
  artists: Array<{ id: string; name: string }>
  durationSeconds: number
}
const id = (v: unknown): v is string => typeof v === 'string' && /^[1-9]\d{0,15}$/.test(v)
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 2048 && !v.includes('\0')
const norm = (v: string) => v.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
export function normalizeNcmFileIdentity(raw: unknown): NcmFileIdentity | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const v = raw as NcmFileIdentity
  if (!id(v.recordingId) || !id(v.releaseId) || !text(v.title) || !text(v.album) ||
    typeof v.durationSeconds !== 'number' || !Number.isFinite(v.durationSeconds) || v.durationSeconds <= 0 ||
    !Array.isArray(v.artists) || !v.artists.length || v.artists.length > 64 ||
    !v.artists.every(a => a && id(a.id) && text(a.name)) ||
    JSON.stringify(v).length > 16384) return undefined
  return { recordingId: v.recordingId, releaseId: v.releaseId, title: v.title, album: v.album,
    durationSeconds: v.durationSeconds, artists: v.artists.map(a => ({ id: a.id, name: a.name })) }
}

/** A copied/stale comment cannot override disagreeing audio tags or a CUE segment. */
export function ncmFileTagMatches(tags: TrackIdentityTags): boolean {
  const n = normalizeNcmFileIdentity(tags.ncm)
  const observed = (f: { origin: string } | undefined) => f?.origin === 'audio_tag'
  if (!n || tags.scope !== 'audio_file' || tags.truncated || !observed(tags.title) ||
    !observed(tags.album) || !observed(tags.durationSeconds) ||
    norm(tags.title!.value) !== norm(n.title) || norm(tags.album!.value) !== norm(n.album) ||
    Math.abs(tags.durationSeconds!.value - n.durationSeconds) > 2) return false
  const names = tags.artists?.origin === 'audio_tag' ? tags.artists.value :
    tags.artist?.origin === 'audio_tag' ? [tags.artist.value] : []
  return (names.length === n.artists.length && names.every((name, i) => norm(name) === norm(n.artists[i].name))) ||
    (names.length === 1 && norm(names[0]) === norm(n.artists.map(a => a.name).join('/')))
}

export function ncmFileReferences(input: IdentificationInput) {
  const refs = new Map<string, string[]>()
  if (input.sourcesTruncated || input.kind === 'album_project') return refs
  for (const s of input.sources ?? []) {
    if (s.provider !== 'local' || !ncmFileTagMatches(s.tags)) continue
    const n = s.tags.ncm!
    let ids: string[]
    if (input.kind === 'artist') {
      // Match paired names, not parallel-array positions or slash splitting.
      ids = s.artistIndexes.flatMap(index => {
        const name = s.artists[index]?.name
        if (!name || norm(name) !== norm(input.name)) return []
        return n.artists.filter(a => norm(a.name) === norm(name)).map(a => a.id)
      })
    } else ids = [input.kind === 'recording' ? n.recordingId : n.releaseId]
    for (const value of new Set(ids)) refs.set(value, [...(refs.get(value) ?? []), s.sourceId])
  }
  return refs
}
