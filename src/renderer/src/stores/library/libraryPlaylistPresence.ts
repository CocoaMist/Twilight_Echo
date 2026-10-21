import { LIBRARY_PAGE_SIZE, type LibraryDatabaseApi } from '../../../../shared/libraryDatabase.ts'

/** Exact library membership, not presence in a renderer page. Retain only IDs
 * between reads; at most one RPC and 200 complete records are live per batch. */
export async function readLibraryPlaylistTrackPresence(
  ids: readonly string[],
  api: Pick<LibraryDatabaseApi, 'getTracksByIds' | 'getMetadata'>
): Promise<Set<string>> {
  const requested = [...new Set(ids)],
    present = new Set<string>()
  let revision: number | undefined
  for (let offset = 0; offset < requested.length; offset += LIBRARY_PAGE_SIZE) {
    const batch = requested.slice(offset, offset + LIBRARY_PAGE_SIZE)
    const page = await api.getTracksByIds(batch, revision)
    if (revision !== undefined && page.revision !== revision)
      throw new Error('曲库在检查歌单期间发生变化，请重试')
    revision = page.revision
    const allowed = new Set(batch)
    for (const track of page.tracks) {
      if (!allowed.delete(track.id)) throw new Error('曲库返回了无效的歌单检查结果')
      present.add(track.id)
    }
  }
  if (revision !== undefined && (await api.getMetadata()).revision !== revision)
    throw new Error('曲库在检查歌单期间发生变化，请重试')
  return present
}
