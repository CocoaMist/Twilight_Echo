import type { Track } from '../../types/music'
import type { DerivedTrackGroup, LibraryItem } from './musicStoreTypes.ts'
import { splitGenreValues } from '../../../../shared/genreSeparators.ts'
import {
  compareAlbumTrackOrder,
  deduplicateLibraryPaths,
  getAlbumIdentity,
  isTrackUnderLibraryRoot,
  mergeAlbumGroupsByReleaseEvidence,
  normalizeLibraryPath,
  parentDirectoryOf
} from './musicStoreData.ts'

/** Build one consistent library projection without reading or mutating store state. */
export function buildDerivedCollections(
  tracks: readonly Track[],
  folderPaths: readonly string[],
  genreSeparators: string
): {
  artists: LibraryItem[]
  albums: LibraryItem[]
  genres: LibraryItem[]
  folders: LibraryItem[]
} {
  const artistMap = new Map<string, DerivedTrackGroup>()
  const albumMap = new Map<string, DerivedTrackGroup>()
  const genreMap = new Map<string, DerivedTrackGroup>()

  function addToGroup(
    map: Map<string, DerivedTrackGroup>,
    key: string,
    track: Track,
    artist?: string
  ): void {
    let group = map.get(key)
    if (!group) {
      group = { tracks: [], cover: null, artist }
      map.set(key, group)
    }
    group.tracks.push(track)
    if (!group.cover && track.cover) group.cover = track.cover
  }

  for (const track of tracks) {
    const artistName = track.artist || '未知艺术家'
    addToGroup(artistMap, artistName, track)

    addToGroup(albumMap, getAlbumIdentity(track), track, track.albumArtist || track.artist)

    const genreNames = splitGenreValues(track.genre, genreSeparators)
    if (genreNames.length === 0) {
      addToGroup(genreMap, '未知流派', track)
    } else {
      for (const genreName of genreNames) addToGroup(genreMap, genreName, track)
    }
  }

  function toNamedCollections(groups: Map<string, DerivedTrackGroup>): LibraryItem[] {
    return Array.from(groups.entries())
      .map(([name, group]) => ({
        name,
        trackCount: group.tracks.length,
        tracks: group.tracks,
        cover: group.cover
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  }
  const artists = toNamedCollections(artistMap)

  const mergedAlbumMap = mergeAlbumGroupsByReleaseEvidence(albumMap)
  const albums = Array.from(mergedAlbumMap.entries())
    .map(([id, group]) => {
      const ordered = [...group.tracks].sort(compareAlbumTrackOrder)
      return {
        id,
        name: ordered[0]?.album || '未知专辑',
        trackCount: ordered.length,
        tracks: ordered,
        cover: group.cover,
        artist: group.artist || ordered[0]?.artist || '未知艺术家'
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh') || (a.id ?? '').localeCompare(b.id ?? ''))

  const genres = toNamedCollections(genreMap)

  const configuredFolderPaths = deduplicateLibraryPaths([...folderPaths])
  const configuredFolderRoots = configuredFolderPaths.map((folderPath) => ({
    folderPath,
    normalized: normalizeLibraryPath(folderPath)
  }))
  type FolderGroup = {
    folderPath: string
    normalized: string
    tracks: Track[]
    cover: string | null
  }
  const folderGroups = new Map<string, FolderGroup>()
  const ensureFolderGroup = (folderPath: string): void => {
    const normalized = normalizeLibraryPath(folderPath)
    if (!normalized || folderGroups.has(normalized)) return
    folderGroups.set(normalized, {
      folderPath,
      normalized,
      tracks: [],
      cover: null
    })
  }
  const addTrackToFolderGroup = (group: FolderGroup | undefined, track: Track): void => {
    if (!group) return
    group.tracks.push(track)
    if (!group.cover && track.cover) group.cover = track.cover
  }

  for (const root of configuredFolderRoots) ensureFolderGroup(root.folderPath)

  if (configuredFolderRoots.length === 0) {
    for (const track of tracks) {
      ensureFolderGroup(track.dir?.trim() || parentDirectoryOf(track.filePath))
    }
  }

  for (const track of tracks) {
    if (configuredFolderRoots.length === 0) {
      const trackDirectory = track.dir?.trim() || parentDirectoryOf(track.filePath)
      addTrackToFolderGroup(folderGroups.get(normalizeLibraryPath(trackDirectory)), track)
      continue
    }

    const matchingRoots = configuredFolderRoots.filter((root) =>
      isTrackUnderLibraryRoot(track.filePath, root.normalized)
    )
    if (matchingRoots.length === 0) continue
    const metadataDirectory = track.dir?.trim() || parentDirectoryOf(track.filePath)
    const currentDirectoryIsBounded = matchingRoots.some((root) =>
      isTrackUnderLibraryRoot(metadataDirectory, root.normalized)
    )
    let currentDirectory = currentDirectoryIsBounded
      ? metadataDirectory
      : parentDirectoryOf(track.filePath)
    const remainingRootPaths = new Set(matchingRoots.map((root) => root.normalized))
    while (currentDirectory) {
      const normalizedCurrent = normalizeLibraryPath(currentDirectory)
      const group = folderGroups.get(normalizedCurrent)
      if (!group) {
        ensureFolderGroup(currentDirectory)
      }
      addTrackToFolderGroup(folderGroups.get(normalizedCurrent), track)
      remainingRootPaths.delete(normalizedCurrent)
      if (remainingRootPaths.size === 0) break
      const parent = parentDirectoryOf(currentDirectory)
      if (!parent || parent === currentDirectory) break
      currentDirectory = parent
    }
  }

  const folders = [...folderGroups.values()]
    .map(({ folderPath, normalized, tracks: folderTracks, cover }) => {
      const name = normalized.split(/[\\/]/).pop() || folderPath
      return {
        name,
        path: folderPath,
        trackCount: folderTracks.length,
        tracks: folderTracks,
        cover
      }
    })
    .filter((f) => f.trackCount > 0)
    .sort(
      (a, b) => a.name.localeCompare(b.name, 'zh') || (a.path ?? '').localeCompare(b.path ?? '')
    )
  return { artists, albums, genres, folders }
}
