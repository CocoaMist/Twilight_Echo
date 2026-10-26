import type { IdentificationInput } from './musicIdentification.ts'

/** Search identity only. No playback URLs, images, account data or rounded time. */
export interface PlatformRecordingIdentity {
  id: string
  title: string
  artists: Array<{ id: string | null; name: string; aliases?: string[] }>
  durationSeconds: number | null
  album: { id: string; title: string } | null
}
export interface PlatformRecordingPage { items: PlatformRecordingIdentity[]; total: number | null }
export interface PlatformArtistIdentity { id: string; name: string; aliases: string[] }
export const MAX_RECORDING_IDENTITY_RESULTS = 40
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 2048 && !v.includes('\0')
const id = (v: unknown): v is string => typeof v === 'string' && /^[1-9]\d{0,15}$/.test(v)
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const keys = (v: object, names: string[]) => Object.keys(v).every(k => names.includes(k))
const norm = (v: string) => v.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
const aliases = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 32 && v.every(text)
export function validPlatformArtistIdentity(v: unknown): v is PlatformArtistIdentity {
  return obj(v) && keys(v, ['id', 'name', 'aliases']) && id(v.id) && text(v.name) && aliases(v.aliases)
}
export const platformArtistMatches = (name: string, artist: PlatformRecordingIdentity['artists'][number]) =>
  [artist.name, ...(artist.id ? artist.aliases ?? [] : [])].some(value => norm(value) === norm(name))
export function validPlatformRecordingPage(v: unknown): v is PlatformRecordingPage {
  return obj(v) && keys(v, ['items', 'total']) && Array.isArray(v.items) && v.items.length <= MAX_RECORDING_IDENTITY_RESULTS &&
    (v.total === null || Number.isSafeInteger(v.total) && Number(v.total) >= v.items.length) &&
    new Set(v.items.map(r => r?.id)).size === v.items.length && v.items.every(r => obj(r) &&
      keys(r, ['id', 'title', 'artists', 'durationSeconds', 'album']) && id(r.id) && text(r.title) &&
      (r.durationSeconds === null || typeof r.durationSeconds === 'number' && Number.isFinite(r.durationSeconds) && r.durationSeconds > 0) &&
      Array.isArray(r.artists) && r.artists.length > 0 && r.artists.length <= 64 &&
      r.artists.every(a => obj(a) && keys(a, ['id', 'name', 'aliases']) && (a.id === null || id(a.id)) && text(a.name) &&
        (a.aliases === undefined || id(a.id) && aliases(a.aliases))) &&
      (r.album === null || obj(r.album) && keys(r.album, ['id', 'title']) && id(r.album.id) && text(r.album.title)))
}
const observed = (v: { origin: string } | undefined) => v && ['audio_tag', 'cue', 'manual'].includes(v.origin)
export function platformRecordingSources(input: IdentificationInput) {
  const seen = new Set<string>()
  return input.sourcesTruncated || input.kind === 'album_project' ? [] : (input.sources ?? []).filter(s => {
    const t = s.tags
    if (s.provider !== 'local' || t.truncated || !observed(t.title) || !observed(t.durationSeconds) ||
      !observed(t.artists ?? t.artist) || !t.title?.value || !t.durationSeconds?.value) return false
    const key = norm(t.title.value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, input.kind === 'recording' ? 1 : 2)
}
// Feature credits may live in the title or artist list. Version qualifiers are kept.
function titleCredit(value: string) {
  const match = /^(.*?)\s*(?:\(|\[)\s*(?:feat\.?|ft\.?|featuring)\s+(.+?)\s*[)\]]\s*$/i.exec(value)
  return { title: norm(match ? match[1] : value), featured: match ? [match[2]] : [] }
}
const joiners = ['/', ' / ', ' & ', ' feat. ', ' feat ', ' ft. ', ' featuring ']
function joinedCredit(name: string, artists: PlatformRecordingIdentity['artists']): boolean {
  let positions = new Set([0])
  const value = norm(name)
  for (const [index, artist] of artists.entries()) {
    const next = new Set<number>()
    for (const start of positions) for (const alias of [artist.name, ...(artist.id ? artist.aliases ?? [] : [])])
      for (const joiner of index ? joiners : ['']) {
        const part = joiner + norm(alias)
        if (value.startsWith(part, start)) next.add(start + part.length)
      }
    positions = next
  }
  return positions.has(value.length)
}
function allCredits(names: string[], artists: PlatformRecordingIdentity['artists']): boolean {
  if (names.length === artists.length) {
    const used = new Set<number>()
    if (names.every(name => {
      const index = artists.findIndex((artist, index) => !used.has(index) && platformArtistMatches(name, artist))
      if (index < 0) return false
      used.add(index);return true
    })) return true
  }
  let positions = new Set([0])
  for (const name of names) {
    const next = new Set<number>()
    for (const start of positions) for (let end = start + 1; end <= artists.length; end++)
      if (joinedCredit(name, artists.slice(start, end))) next.add(end)
    positions = next
  }
  return positions.has(artists.length)
}
export function platformRecordingShapeMatches(input: IdentificationInput, sourceId: string, row: PlatformRecordingIdentity) {
  const s = platformRecordingSources(input).find(s => s.sourceId === sourceId)
  if (!s) return false
  const t = s.tags
  // iTunes adds a display-only release type to a single/EP title.
  const album = (v: string) => norm(v).replace(/\s+-\s+(single|ep)$/i, '')
  return titleCredit(row.title).title === titleCredit(t.title!.value).title && row.durationSeconds !== null &&
    Math.abs(row.durationSeconds - t.durationSeconds!.value) <= 2 &&
    (!observed(t.album) || !t.album?.value || !!row.album && album(row.album.title) === album(t.album.value))
}
export function matchedPlatformRecordings(input: IdentificationInput, sourceId: string, page: PlatformRecordingPage) {
  const s = platformRecordingSources(input).find(s => s.sourceId === sourceId)
  if (!s || !validPlatformRecordingPage(page) || page.total === null || page.total > page.items.length) return []
  const names = s.tags.artists?.value ?? [s.tags.artist!.value], local = titleCredit(s.tags.title!.value)
  return page.items.filter(row => {
    if (!platformRecordingShapeMatches(input, sourceId, row)) return false
    const remote = titleCredit(row.title)
    const features = [...local.featured, ...remote.featured]
    if (features.some(name => !row.artists.some((_, start) => row.artists.some((_, end) => end >= start && joinedCredit(name, row.artists.slice(start, end + 1)))))) return false
    return allCredits(names, row.artists) || !!local.featured.length && allCredits([...names, ...local.featured], row.artists)
  })
}
/** One song needs the album as an independent check; otherwise two songs.
 * Never infer an individual ID by splitting a composite performer string. */
export function platformRecordingReferences(input: IdentificationInput, samples: Array<{ sourceId: string; page: PlatformRecordingPage }>) {
  const sources = platformRecordingSources(input)
  if (!sources.length || sources.length !== samples.length || sources.some((s, i) => s.sourceId !== samples[i].sourceId)) return []
  if (sources.length === 1 && (!observed(sources[0].tags.album) || !sources[0].tags.album?.value)) return []
  let common: Set<string> | undefined
  const used = new Set<string>()
  for (const sample of samples) {
    const rows = matchedPlatformRecordings(input, sample.sourceId, sample.page)
    if (!rows.length || rows.some(r => used.has(r.id))) return []
    rows.forEach(r => used.add(r.id))
    const ids = new Set(rows.flatMap(r => input.kind === 'artist'
      ? r.artists.flatMap(a => a.id && platformArtistMatches(input.name, a) ? [a.id] : [])
      : input.kind === 'release' ? r.album ? [r.album.id] : [] : [r.id]))
    common = common ? new Set([...common].filter(id => ids.has(id))) : ids
  }
  return [...common ?? []]
}
