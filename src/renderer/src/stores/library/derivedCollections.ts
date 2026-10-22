import type { Track } from '../../types/music'
import type { DerivedTrackGroup, LibraryItem } from './musicStoreTypes.ts'
import { splitGenreValues } from '../../../../shared/genreSeparators.ts'
import { resolveAlbumReleaseDate } from '../../../../shared/releaseDate.ts'
import { compareChineseText } from '../../utils/chineseCollation.ts'
import {
  getCollectionAncestors,
  getCollectionDirectory,
  resolveAlbumArtist
} from '../../../../shared/libraryCollections.ts'
import {
  compareAlbumTrackOrder,
  deduplicateLibraryPaths,
  getAlbumIdentity,
  mergeAlbumGroupsByReleaseEvidence,
  normalizeLibraryPath
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
      .sort((a, b) => compareChineseText(a.name, b.name))
  }
  const artists = toNamedCollections(artistMap)

  const mergedAlbumMap = mergeAlbumGroupsByReleaseEvidence(albumMap)
  const albums = Array.from(mergedAlbumMap.entries())
    .map(([id, group]) => {
      const ordered = [...group.tracks].sort(compareAlbumTrackOrder)
      const coverTrack =
        ordered.find((track) => track.cover) ?? ordered.find((track) => track.coverSource)
      return {
        id,
        name: ordered[0]?.album || '未知专辑',
        trackCount: ordered.length,
        tracks: ordered,
        cover: coverTrack?.cover ?? null,
        coverSource: coverTrack?.coverSource,
        releaseDate: resolveAlbumReleaseDate(ordered),
        artist: resolveAlbumArtist(ordered)
      }
    })
    .sort((a, b) => compareChineseText(a.name, b.name) || (a.id ?? '').localeCompare(b.id ?? ''))

  const genres = toNamedCollections(genreMap)

  const configuredFolderPaths = deduplicateLibraryPaths([...folderPaths])
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

  for (const root of configuredFolderPaths) ensureFolderGroup(root)

  for (const track of tracks) {
    const directory = getCollectionDirectory(track.filePath, track.dir, configuredFolderPaths)
    for (const ancestor of getCollectionAncestors(directory, configuredFolderPaths)) {
      ensureFolderGroup(ancestor)
      addTrackToFolderGroup(folderGroups.get(normalizeLibraryPath(ancestor)), track)
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
      (a, b) => compareChineseText(a.name, b.name) || (a.path ?? '').localeCompare(b.path ?? '')
    )
  return { artists, albums, genres, folders }
}
