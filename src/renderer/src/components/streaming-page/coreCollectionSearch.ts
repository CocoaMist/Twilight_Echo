import type { CoreCollectionSearchQuery, CoreCollectionSearchPage } from '../../../../shared/coreSearch.ts'
import type { AlbumSearchItem } from './albumSearch.ts'
import type { ArtistSearchItem } from './artistSearch.ts'

/** Only adapts display fields; Core owns provider fan-out, ordering and pagination. */
export function createCoreCollectionSearch(options: {
  read(query: CoreCollectionSearchQuery, signal?: AbortSignal): Promise<CoreCollectionSearchPage>
  warning(message: string): void
}) {
  async function read(kind: CoreCollectionSearchQuery['kind'], source: string, query: string, limit = 30, offset = 0, call?: { signal?: AbortSignal }) {
    const page = await options.read({ kind, query, limit, offset,
      ...(source === 'all' || source === 'local' ? { scope: source } : { providerId: source })
    }, call?.signal)
    if (page.warning) options.warning(page.warning)
    return page
  }
  async function albums(source: string, query: string, limit?: number, offset?: number, call?: { signal?: AbortSignal }) {
    const page = await read('albums', source, query, limit, offset, call)
    return { albums: page.items.map((item): AlbumSearchItem => ({ ...item, cover: item.cover ?? null, trackCount: item.trackCount ?? 0 })), total: page.total }
  }
  async function artists(source: string, query: string, limit?: number, offset?: number, call?: { signal?: AbortSignal }) {
    const page = await read('artists', source, query, limit, offset, call)
    return { artists: page.items.map((item): ArtistSearchItem => ({ ...item, picUrl: item.picUrl ?? null })), total: page.total }
  }
  async function playlists(source: string, query: string, limit?: number, offset?: number, call?: { signal?: AbortSignal }) {
    const page = await read('playlists', source, query, limit, offset, call)
    return { playlists: page.items.map((item) => ({ ...item, cover: item.cover ?? null, trackCount: item.trackCount ?? 0 })), total: page.total }
  }
  return { albums, artists, playlists }
}
