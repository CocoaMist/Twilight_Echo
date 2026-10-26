import type { LibraryCollectionSummary } from '../../../shared/libraryDatabase.ts'
import type { CoreTrackView } from '../../../shared/coreViews.ts'
import type { CorePlayerClient } from '../stores/player/corePlayerTypes.ts'

export interface ExperienceLibraryAlbum extends LibraryCollectionSummary {
  extensionId: string
  tracks?: CoreTrackView[]
}

/** A plugin receives bounded Core projections; member resolution stays in Core. */
export async function readExperiencePlaylistTrackDtos<T>(
  core: Pick<CorePlayerClient, 'query'>,
  id: string,
  revision: number,
  reader: Pick<ReturnType<typeof createExperienceLibraryReader>, 'rememberTrackAlbums'>,
  toDto: (track: CoreTrackView) => T
): Promise<T[]> {
  const result: T[] = []
  let offset = 0
  for (;;) {
    const page = await core.query('playlists.members', { id, revision, offset, limit: 200 })
    const tracks = page.items.flatMap(item => item.track ? [item.track] : [])
    await reader.rememberTrackAlbums(tracks)
    result.push(...tracks.map(toDto))
    offset += page.items.length
    if (offset >= page.total) return result
    if (!page.items.length) throw new Error('歌单曲目分页中断')
  }
}

/** Core-backed adapter. Keep the established extension release IDs across upgrades. */
export function createExperienceLibraryReader(
  core: Pick<CorePlayerClient, 'query'>
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
    const albums: ExperienceLibraryAlbum[] = []
    let total = offset + limit, currentRevision = revision
    do {
      const page = await core.query('library.collections', { kind: 'albums', query: {
        offset: offset + albums.length, limit: Math.min(200, limit - albums.length), contentRevision: currentRevision
      } })
      currentRevision = page.revision
      total = page.total
      albums.push(...await Promise.all(page.items.map(remember)))
      if (!page.items.length && offset + albums.length < total) throw new Error('曲库专辑分页中断')
    } while (albums.length < limit && offset + albums.length < total)
    return { albums, total, revision: currentRevision! }
  }

  async function albumTracks(albumId: string, revision: number) {
    const tracks: CoreTrackView[] = []
    let offset = 0
    for (;;) {
      const page = await core.query('library.tracks', {
        albumId,
        sort: 'trackNumber',
        offset,
        limit: 200,
        contentRevision: revision
      })
      if (page.revision !== revision) throw new Error('曲库在读取专辑期间发生变化，请重试')
      tracks.push(...page.tracks)
      offset += page.tracks.length
      if (offset >= page.total) return tracks
      if (!page.tracks.length) throw new Error('专辑曲目分页中断')
    }
  }

  async function rememberTrackAlbums(tracks: readonly CoreTrackView[], revision?: number) {
    let libraryRevision = revision
    for (const track of tracks) {
      if (track.source && track.source !== 'local') continue
      const page = await core.query('library.collections', {
        kind: 'albums',
        query: { ids: [track.id], limit: 1, contentRevision: libraryRevision }
      })
      libraryRevision = page.revision
      const album = page.items[0]
      if (!album) {
        trackAlbumIds.delete(track.id)
        continue
      }
      const id = await extensionId(album.id)
      databaseIds.set(id, album.id)
      trackAlbumIds.set(track.id, id)
    }
  }

  async function search(query: string) {
    const [albums, tracks] = await Promise.all([
      core.query('library.collections', { kind: 'albums', query: {
        search: query,
        collectionNamesOnly: true,
        limit: 80
      } }),
      core.query('library.tracks', { search: query, sort: 'playlist', limit: 100 })
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
    const page = await core.query('library.collections', { kind: 'albums', query: {
      albumId: databaseId,
      limit: 1,
      contentRevision: revision
    } })
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
      const page = await core.query('library.collections', { kind: 'genres', query: {
        offset,
        limit: 200,
        contentRevision: revision
      } })
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
