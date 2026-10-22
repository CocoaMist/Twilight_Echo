import type {
  LibraryCollectionSummary,
  LibraryDatabaseApi,
  LibraryTrackRecord
} from '../../../shared/libraryDatabase.ts'
import { getAlbumIdentity, type AlbumIdentityTrack } from '../../../shared/libraryIdentity.ts'
import type { RecordingVersion } from '../../../shared/recordingIdentity.ts'
import type { Track } from '../types/music.ts'
import { readLibraryPlaylistTracks } from '../stores/library/libraryPlaylistResolution.ts'

export interface ExperienceLibraryAlbum extends LibraryCollectionSummary {
  extensionId: string
  tracks?: LibraryTrackRecord[]
}

export async function readExperiencePlaylistTrackDtos<T>(
  playlist: { trackIds: string[]; trackSnapshots?: Record<string, Track> },
  api: Pick<LibraryDatabaseApi, 'lookupPlaylistTracks' | 'getTracksByIds' | 'getMetadata'>,
  reader: Pick<ReturnType<typeof createExperienceLibraryReader>, 'rememberTrackAlbums'>,
  revision: number,
  getPreferences: () => { revision: number; versions: RecordingVersion[] },
  toDto: (track: Track) => T
): Promise<T[]> {
  const result: T[] = []
  await readLibraryPlaylistTracks(playlist, api, {
    expectedRevision: revision,
    getVersions: getPreferences,
    consume: async (tracks) => {
      await reader.rememberTrackAlbums(tracks, revision)
      result.push(...tracks.map(toDto))
    }
  })
  return result
}

/** SQLite-backed adapter for the extension library protocol. IDs exposed to
 * experiences keep the existing stable hash while SQL retains its own key. */
export function createExperienceLibraryReader(
  api: Pick<LibraryDatabaseApi, 'queryTracks' | 'queryCollections'>
) {
  const databaseIds = new Map<string, string>()
  const trackAlbumIds = new Map<string, string>()

  async function extensionId(databaseId: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(databaseId))
    return `album-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
  }

  async function remember(summary: LibraryCollectionSummary): Promise<ExperienceLibraryAlbum> {
    const id = await extensionId(summary.id)
    databaseIds.set(id, summary.id)
    return { ...summary, extensionId: id }
  }

  async function albumPage(offset: number, limit: number, revision?: number) {
    const page = await api.queryCollections('albums', { offset, limit, contentRevision: revision })
    return {
      albums: await Promise.all(page.items.map(remember)),
      total: page.total,
      revision: page.revision
    }
  }

  async function albumTracks(albumId: string, revision: number) {
    const tracks: LibraryTrackRecord[] = []
    let offset = 0
    for (;;) {
      const page = await api.queryTracks({
        albumId,
        sort: 'trackNumber',
        offset,
        limit: 1000,
        contentRevision: revision
      })
      if (page.revision !== revision) throw new Error('曲库在读取专辑期间发生变化，请重试')
      tracks.push(...page.tracks)
      offset += page.tracks.length
      if (offset >= page.total) return tracks
      if (!page.tracks.length) throw new Error('专辑曲目分页中断')
    }
  }

  async function rememberTrackAlbums(
    tracks: readonly (AlbumIdentityTrack & { id: string })[],
    revision: number
  ) {
    if (!tracks.length) return
    const page = await api.queryCollections('albums', {
      ids: tracks.map((track) => track.id),
      limit: 1000,
      contentRevision: revision
    })
    if (page.revision !== revision) throw new Error('曲库在读取专辑期间发生变化，请重试')
    const byId = new Map<string, string>()
    for (const album of page.items) {
      const externalId = await extensionId(album.id)
      databaseIds.set(externalId, album.id)
      byId.set(album.id, externalId)
    }
    for (const track of tracks) {
      const rawId = getAlbumIdentity(track as unknown as AlbumIdentityTrack)
      const externalId = byId.get(rawId)
      if (externalId) trackAlbumIds.set(track.id, externalId)
    }
  }

  async function search(query: string) {
    const [albums, tracks] = await Promise.all([
      api.queryCollections('albums', {
        search: query,
        collectionNamesOnly: true,
        limit: 80
      }),
      api.queryTracks({ search: query, sort: 'playlist', limit: 100 })
    ])
    if (albums.revision !== tracks.revision) throw new Error('曲库在搜索期间发生变化，请重试')
    await rememberTrackAlbums(tracks.tracks, tracks.revision)
    return {
      albums: await Promise.all(albums.items.map(remember)),
      tracks: tracks.tracks,
      revision: tracks.revision
    }
  }

  async function detailedAlbum(externalId: unknown, revision?: number) {
    if (typeof externalId !== 'string') return null
    const databaseId = databaseIds.get(externalId)
    if (!databaseId) return null
    const page = await api.queryCollections('albums', {
      albumId: databaseId,
      limit: 1,
      contentRevision: revision
    })
    const summary = page.items.find((item) => item.id === databaseId)
    if (!summary) return null
    const album = await remember(summary)
    album.tracks = await albumTracks(databaseId, page.revision)
    for (const track of album.tracks) trackAlbumIds.set(track.id, album.extensionId)
    return { album, revision: page.revision }
  }

  async function detailedPage(offset: number, limit: number, revision?: number) {
    const page = await albumPage(offset, limit, revision)
    for (const album of page.albums) {
      album.tracks = await albumTracks(album.id, page.revision)
      for (const track of album.tracks) trackAlbumIds.set(track.id, album.extensionId)
    }
    return page
  }

  async function allGenres(revision: number) {
    const names: string[] = []
    let offset = 0
    for (;;) {
      const page = await api.queryCollections('genres', {
        offset,
        limit: 500,
        contentRevision: revision
      })
      if (page.revision !== revision) throw new Error('曲库在读取流派期间发生变化，请重试')
      names.push(...page.items.map((item) => item.name))
      offset += page.items.length
      if (offset >= page.total) return names
      if (!page.items.length) throw new Error('曲库流派分页中断')
    }
  }

  return {
    albumPage,
    detailedPage,
    detailedAlbum,
    allGenres,
    search,
    rememberTrackAlbums,
    databaseId(externalId: unknown) {
      return typeof externalId === 'string' ? databaseIds.get(externalId) : undefined
    },
    trackAlbumId(trackId: string) {
      return trackAlbumIds.get(trackId) ?? ''
    }
  }
}
