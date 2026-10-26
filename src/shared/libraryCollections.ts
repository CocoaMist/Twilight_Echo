import { normalizeLibraryPath, parentDirectoryOf } from './libraryIdentity.ts'
import { getPinyinInitial } from './pinyinInitials.ts'
import { fileArtistCredits, type TrackIdentityTags } from './trackIdentification.ts'

export function libraryArtistCredits(track: {
  artists?: readonly { name: string; id?: string | number }[]
  identityTags?: TrackIdentityTags
}): { name: string; id?: string | number }[] {
  const artists = Array.isArray(track.artists)
    ? track.artists.filter(artist => artist && typeof artist.name === 'string' && artist.name.trim())
    : undefined
  return artists?.length ? [...artists] : fileArtistCredits(track.identityTags)
}

/** Structured credits describe members; the joined display credit is not another artist.
 * Only the legacy, whitespace-delimited slash is a separator without structured tags.
 * Punctuation inside a real name (AC/DC, Earth, Wind & Fire) stays literal.
 */
export function libraryArtistNames(track: {
  artist: string
  artists?: readonly { name: string }[]
  identityTags?: TrackIdentityTags
}): string[] {
  const credits = libraryArtistCredits(track).map((artist) => artist.name.trim()).filter(Boolean)
  if (credits?.length) return [...new Set(credits)]
  const names = track.artist.split(/\s+\/\s+/)
  return names.length > 1
    ? [...new Set(names.map((name) => name.trim()).filter(Boolean))]
    : [track.artist || '未知艺术家']
}

export function collectionIndexLetter(name: string): string | null {
  const first = name.trim().normalize('NFKD').replace(/\p{M}/gu, '').charAt(0).toUpperCase()
  if (/^[A-Z]$/.test(first)) return first
  return getPinyinInitial(first).toUpperCase() || null
}

/** Keep full display-name links as well as individual credited artists usable. */
export function isLibraryArtistMember(
  track: { artist: string; artists?: readonly { name: string }[]; identityTags?: TrackIdentityTags },
  name: string
): boolean {
  const artistName = name.trim()
  if (!artistName) return false
  if ((track.artist.trim() || '未知艺术家') === artistName) return true
  return libraryArtistNames(track).some((name) => name.trim() === artistName)
}

export function resolveAlbumArtist(
  tracks: readonly { artist?: string; albumArtist?: string }[]
): string {
  return resolveAlbumArtistNames(
    tracks.map((track) => track.albumArtist ?? ''),
    tracks.map((track) => track.artist ?? '')
  )
}

export function resolveAlbumArtistNames(
  owners: Iterable<string>,
  artists: Iterable<string>
): string {
  const meaningful = (values: Iterable<string>): Set<string> =>
    new Set(
      [...values]
        .map((value) => value.trim())
        .filter((value) => value && !/^(?:unknown(?: artist)?|未知(?:艺术家|歌手))$/i.test(value))
    )
  const ownerNames = meaningful(owners),
    artistNames = meaningful(artists)
  if (ownerNames.size === 1) return [...ownerNames][0]!
  if (artistNames.size === 1) return [...artistNames][0]!
  return artistNames.size > 1 ? '群星' : '未知歌手'
}

const underRoot = (filePath: string, root: string): boolean => {
  const path = normalizeLibraryPath(filePath),
    normalizedRoot = normalizeLibraryPath(root)
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}\\`)
}

/** Untrusted legacy `dir` tags cannot place a file outside its configured roots. */
export function getCollectionDirectory(
  filePath: string,
  metadataDirectory: string | undefined,
  roots: readonly string[]
): string {
  const directory = metadataDirectory?.trim() || parentDirectoryOf(filePath)
  if (!roots.length) return directory
  const matching = roots.filter((root) => underRoot(filePath, root))
  if (!matching.length) return ''
  return matching.every((root) => underRoot(directory, root))
    ? directory
    : parentDirectoryOf(filePath)
}

/** One folder bucket contributes to each ancestor up to all containing scan roots. */
export function getCollectionAncestors(directory: string, roots: readonly string[]): string[] {
  if (!roots.length) return directory ? [directory] : []
  const remaining = new Set(
    roots.filter((root) => underRoot(directory, root)).map(normalizeLibraryPath)
  )
  if (!remaining.size) return []
  const result: string[] = []
  let current = directory
  while (current) {
    result.push(current)
    remaining.delete(normalizeLibraryPath(current))
    if (!remaining.size) break
    const parent = parentDirectoryOf(current)
    if (parent === current) break
    current = parent
  }
  return result
}
