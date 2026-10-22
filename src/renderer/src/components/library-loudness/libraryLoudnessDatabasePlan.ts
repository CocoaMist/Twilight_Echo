import type { LibraryDatabaseApi } from '../../../../shared/libraryDatabase.ts'
import { LIBRARY_PAGE_SIZE } from '../../../../shared/libraryDatabase.ts'
import {
  MAX_LOUDNESS_ALBUM_TRACKS,
  MAX_LOUDNESS_BATCH_TRACKS
} from '../../../../shared/libraryLoudness.ts'
import type { Track } from '../../types/music.ts'
import { libraryTrack } from '../../utils/libraryQueuePlayback.ts'
import { buildLibraryLoudnessPlan, type LoudnessAlbum } from './libraryLoudnessPlan.ts'

/** Expand through authoritative album identities, never a filtered renderer
 * album or a queryCollections(ids) member count. All detail state is bounded by
 * the analysis limits, independently of total library/selection size. */
export async function buildLibraryLoudnessDatabasePlan(
  api: Pick<LibraryDatabaseApi, 'queryCollections' | 'queryTracks'>,
  selection: readonly Track[],
  revision: number,
  mode: 'track' | 'album',
  signal?: AbortSignal
): Promise<ReturnType<typeof buildLibraryLoudnessPlan>> {
  const check = () => {
    if (signal?.aborted) throw new Error('响度范围读取已取消')
  }
  check()
  if (selection.length > MAX_LOUDNESS_BATCH_TRACKS)
    throw new Error('单次最多分析 10,000 首，请缩小选择范围')
  if (mode === 'track') return buildLibraryLoudnessPlan(selection, [], mode)
  const albums: LoudnessAlbum[] = []
  const seen = new Set<string>()
  let expanded = 0
  for (let start = 0; start < selection.length; start += LIBRARY_PAGE_SIZE) {
    const ids = selection.slice(start, start + LIBRARY_PAGE_SIZE).map((track) => track.id)
    let total = 0
    for (let offset = 0; offset === 0 || offset < total; offset += LIBRARY_PAGE_SIZE) {
      check()
      const page = await api.queryCollections('albums', {
        ids,
        contentRevision: revision,
        offset,
        limit: LIBRARY_PAGE_SIZE
      })
      check()
      if (
        page.revision !== revision ||
        page.offset !== offset ||
        page.items.length > LIBRARY_PAGE_SIZE ||
        (offset > 0 && page.total !== total) ||
        (page.items.length === 0 && offset < page.total)
      )
        throw new Error('专辑范围已变化，请重新选择')
      total = page.total
      for (const album of page.items) {
        if (seen.has(album.id)) continue
        seen.add(album.id)
        const members: Track[] = []
        let memberCount = 0
        for (
          let memberOffset = 0;
          memberOffset === 0 || memberOffset < memberCount;
          memberOffset += LIBRARY_PAGE_SIZE
        ) {
          check()
          const memberPage = await api.queryTracks({
            albumId: album.id,
            sort: 'trackNumber',
            contentRevision: revision,
            offset: memberOffset,
            limit: LIBRARY_PAGE_SIZE
          })
          check()
          if (memberPage.total > MAX_LOUDNESS_ALBUM_TRACKS)
            throw new Error(`「${album.name}」超过单张专辑 256 首的上限，请改用曲目模式`)
          if (expanded + memberPage.total > MAX_LOUDNESS_BATCH_TRACKS)
            throw new Error('单次最多分析 10,000 首，请缩小选择范围')
          if (
            memberPage.revision !== revision ||
            memberPage.offset !== memberOffset ||
            memberPage.tracks.length > LIBRARY_PAGE_SIZE ||
            (memberOffset > 0 && memberPage.total !== memberCount) ||
            (memberPage.tracks.length === 0 && memberOffset < memberPage.total)
          )
            throw new Error('专辑成员已变化，请重新选择')
          memberCount = memberPage.total
          members.push(...memberPage.tracks.map(libraryTrack))
        }
        if (members.length !== memberCount) throw new Error('专辑成员读取不完整，请重试')
        expanded += memberCount
        albums.push({ ...album, trackCount: memberCount, tracks: members })
      }
    }
  }
  return buildLibraryLoudnessPlan(selection, albums, mode)
}
