import { onBeforeUnmount, watch } from 'vue'
import { useCoreConnection } from '../stores/coreConnection.ts'
import type { CoreCollectionSearchQuery } from '../../../shared/coreSearch.ts'
import type { LibrarySearchSnapshot } from '../../../shared/unifiedMusicSearch.ts'

/** Component-owned read cancellation only; matching and search belong to Core. */
export function useLibraryUnifiedSearch(
  onInvalidate?: (revision?: number) => void,
  options?: { listen?: boolean }
) {
  const core = useCoreConnection()
  const lifetime = new AbortController()
  const signalFor = (signal?: AbortSignal) => AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])])
  const stop =
    options?.listen === false
      ? () => {}
      : watch(
          [
            () => core.state.value?.epoch,
            () => core.state.value?.libraryRevision,
            () => core.state.value?.versionsRevision
          ],
          ([, revision], previous) => {
            if (previous[0] !== undefined) onInvalidate?.(revision ?? undefined)
          }
        )
  onBeforeUnmount(() => { lifetime.abort(); stop() })
  const songs = (query: string, limit = 30, offset = 0, signal?: AbortSignal) =>
    core.query('search.songs', { query, scope: 'local', limit, offset }, signalFor(signal))
  async function collections(kind: CoreCollectionSearchQuery['kind'], query: string, limit = 30, offset = 0, signal?: AbortSignal) {
    const page = await core.query('search.collections', { kind, query, scope: 'local', limit, offset }, signalFor(signal))
    return { ...page, items: page.items.map((item) => ({ ...item, cover: item.cover ?? null,
      picUrl: item.picUrl ?? null, trackCount: item.trackCount ?? 0 })) }
  }
  return {
    search: songs, searchLocal: songs,
    async confirm(page: LibrarySearchSnapshot, signal?: AbortSignal) {
      const current = await core.query('library.metadata', {}, signalFor(signal))
      if ((page.libraryRevision !== undefined && page.libraryRevision !== current.revision) ||
        (page.preferenceRevision !== undefined && page.preferenceRevision !== core.state.value?.versionsRevision))
        throw new Error('曲库在搜索期间发生变化，请重新搜索')
    },
    searchAlbums: (query: string, limit: number, offset: number, signal?: AbortSignal) => collections('albums', query, limit, offset, signal),
    searchArtists: (query: string, limit: number, offset: number, signal?: AbortSignal) => collections('artists', query, limit, offset, signal),
    async resolveAlbum(selection: { albumId: string } | { trackId: string }, signal?: AbortSignal) {
      const page = await core.query('library.collections', { kind: 'albums', query: {
        ...('albumId' in selection ? { albumId: selection.albumId } : { ids: [selection.trackId] }), limit: 1
      } }, signalFor(signal))
      if (!page.items[0]) throw new Error('这张专辑已不在本地音乐库中，请重新搜索')
      return { mode: 'sqlite' as const, albumId: page.items[0].id }
    }
  }
}