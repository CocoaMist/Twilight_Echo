/** Release identity rules shared by the database and legacy renderer consumers. */
export interface AlbumIdentityTrack {
  filePath: string
  album?: string
  albumId?: string
  albumArtist?: string
  artist?: string
  dir?: string
  cover?: string | null
  coverSource?: string | null
}

export function getAlbumIdentity(track: AlbumIdentityTrack): string {
  const albumId = track.albumId?.trim()
  if (albumId) return `id:${albumId}`

  const album = normalizeAlbumIdentityText(track.album || '未知专辑')
  const albumArtist = track.albumArtist?.trim()
  const artist = track.artist?.trim()
  // Older scans copied track artist into albumArtist whenever ALBUMARTIST was
  // missing. Treat that pollution as "no album artist" so guest/feat tracks
  // from the same release still land on one album card.
  const hasDistinctAlbumArtist =
    !!albumArtist && (!artist || albumArtist.toLocaleLowerCase() !== artist.toLocaleLowerCase())

  if (hasDistinctAlbumArtist) {
    return `name:${albumArtist.toLocaleLowerCase()}\u001f${album}`
  }

  // Prefer the exact release directory so multi-artist albums without
  // ALBUMARTIST merge, while same-titled albums in unrelated folders stay separate.
  const dir = track.dir?.trim() || parentDirectoryOf(track.filePath)
  if (dir) {
    return `dir:${normalizeLibraryPath(dir)}\u001f${album}`
  }

  return `name:${(albumArtist || artist || '未知艺术家').trim().toLocaleLowerCase()}\u001f${album}`
}

export function normalizeAlbumIdentityText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

export function getAlbumCoverIdentity(track: AlbumIdentityTrack): string {
  const cover = track.cover?.trim()
  if (!cover) return ''
  const durableSource = track.coverSource?.trim()
  if (/^twilight-media:\/\/image\//i.test(cover) && durableSource) {
    return durableSource.toLocaleLowerCase()
  }
  return cover.toLocaleLowerCase()
}

export function albumOrderIndex(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : Number.MAX_SAFE_INTEGER
}

export function parentDirectoryOf(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+/g, '\\').replace(/\\+$/, '')
  const separator = normalized.lastIndexOf('\\')
  if (separator <= 0) return ''
  return normalized.slice(0, separator)
}

export function normalizeLibraryPath(path: string): string {
  return path
    .replace(/[\\/]+/g, '\\')
    .replace(/\\+$/, '')
    .toLocaleLowerCase()
}
