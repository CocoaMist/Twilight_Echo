import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import type { CoreVersionsCatalogQuery, CoreVersionsCatalogPage } from '../../shared/coreVersions.ts'
import type { TrackData } from '../../shared/track.ts'
import { versionSourceKey, getTrackSource } from '../../shared/trackSourceIdentity.ts'
import { getAlbumIdentity } from '../../shared/libraryIdentity.ts'
import { normalizeSearchText, getTrackSearchBlob } from '../../shared/trackSearchText.ts'
import { libraryTrack } from '../playback/libraryTrack.ts'
import { projectCoreTrack } from '../projections.ts'

/** Source keys are computed with complete Core identities, never inferred from display rows. */
export class CoreRecordingCatalog {
  private readonly options: {
    database: Pick<LibraryDatabaseApi, 'queryTracks' | 'getMetadata' | 'queryCollections'>
    playlists: { getRevision(): number; sourceTracks(): Iterable<TrackData> }
    versions: { getRevision(): number }
  }
  constructor(options: CoreRecordingCatalog['options']) { this.options = options }

  async page(query: CoreVersionsCatalogQuery, signal?: AbortSignal): Promise<CoreVersionsCatalogPage> {
    const revision = this.options.versions.getRevision()
    const playlistsRevision = this.options.playlists.getRevision()
    const contentRevision = (await this.options.database.getMetadata()).revision
    const fence = () => {
      signal?.throwIfAborted()
      if (revision !== this.options.versions.getRevision() ||
        playlistsRevision !== this.options.playlists.getRevision() ||
        (query.revision !== undefined && query.revision !== revision) ||
        (query.playlistsRevision !== undefined && query.playlistsRevision !== playlistsRevision) ||
        (query.contentRevision !== undefined && query.contentRevision !== contentRevision))
        throw Object.assign(new Error('版本来源已变化，请重新读取'), { code: 'STALE_REVISION' })
    }
    fence()
    const offset = query.offset ?? 0, limit = query.limit ?? 200
    const search = normalizeSearchText(query.search ?? '')
    const seen = new Set<string>()
    const albums = new Map<string, { track: TrackData; trackCount: number; albumId: string; trackIds: Set<string> }>()
    const items: CoreVersionsCatalogPage['items'] = []
    let total = 0
    const visit = (track: TrackData) => {
      const key = versionSourceKey(track)
      if (seen.has(key)) return
      seen.add(key)
      if (query.scope === 'albums') {
        if (getTrackSource(track) === 'local') return
        const albumId = getAlbumIdentity(track)
        const albumKey = JSON.stringify(['album', getTrackSource(track), albumId])
        if (query.key && query.key !== albumKey) return
        const album = albums.get(albumKey) ?? { track, trackCount: 0, albumId, trackIds: new Set<string>() }
        album.trackCount++
        album.trackIds.add(track.id)
        albums.set(albumKey, album)
        return
      }
      if ((query.key && query.key !== key) || (query.trackId && query.trackId !== track.id)) return
      if (search && !getTrackSearchBlob(track).includes(search)) return
      if (total >= offset && items.length < limit) items.push({ key, track: projectCoreTrack(track) })
      total++
    }
    for (let start = 0; query.scope !== 'albums'; start += 200) {
      const page = await this.options.database.queryTracks({ offset: start, limit: 200, sort: 'playlist', contentRevision })
      fence()
      for (const row of page.tracks) visit(libraryTrack(row))
      if (start + 200 >= page.total) break
    }
    if (query.scope === 'albums') {
      const located = query.trackId
        ? new Set((await this.options.database.queryCollections('albums', {
            ids: [query.trackId], limit: 1, contentRevision
          })).items.map((album) => album.id))
        : null
      fence()
      for (let start = 0; ; start += 200) {
        const page = await this.options.database.queryCollections('albums', { offset: start, limit: 200, contentRevision })
        fence()
        for (const album of page.items) {
          const key = JSON.stringify(['album', 'local', album.id])
          if (located && !located.has(album.id)) continue
          if (query.key && key !== query.key) continue
          if (search && !normalizeSearchText(`${album.name} ${album.artist ?? ''}`).includes(search)) continue
          if (total >= offset && items.length < limit) {
            const rows = await this.options.database.queryTracks({ albumId: album.id, limit: 1, contentRevision })
            fence()
            if (rows.tracks[0]) items.push({ key: JSON.stringify(['album', 'local', album.id]),
              track: projectCoreTrack(libraryTrack(rows.tracks[0])), trackCount: album.trackCount, albumId: album.id })
          }
          total++
        }
        if (start + 200 >= page.total) break
      }
    }
    for (const track of this.options.playlists.sourceTracks()) visit(track)
    if (query.scope === 'albums') {
      for (const [key, album] of albums) {
        if (query.trackId && !album.trackIds.has(query.trackId)) continue
        if (search && !getTrackSearchBlob(album.track).includes(search)) continue
        if (total >= offset && items.length < limit)
          items.push({ key, track: projectCoreTrack(album.track), trackCount: album.trackCount, albumId: album.albumId })
        total++
      }
    }
    if ((await this.options.database.getMetadata()).revision !== contentRevision)
      throw Object.assign(new Error('曲库已变化，请重新读取'), { code: 'STALE_REVISION' })
    fence()
    return { revision, contentRevision, playlistsRevision, offset, total, items }
  }
}
