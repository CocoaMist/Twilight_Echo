import { shallowRef } from 'vue'
import type {
  LibraryCollectionSummary,
  LibraryDatabaseApi
} from '../../../../shared/libraryDatabase.ts'
import type { RecordingVersion } from '../../../../shared/recordingIdentity.ts'
import type { Track } from '../../types/music.ts'
import type { UnifiedRecentStat } from '../../utils/unifiedRecentTracks.ts'
import { libraryTrack } from '../../utils/libraryQueuePlayback.ts'
import { readLibraryRecentHistory } from './libraryRecentHistory.ts'

export const DASHBOARD_SHELF_SIZE = 6
export const DASHBOARD_ALBUM_COUNT = 5

export interface LibraryDashboardData {
  revision: number
  total: number
  duration: number
  albumCount: number
  artistCount: number
  first: Track[]
  recent: Track[]
  albums: LibraryCollectionSummary[]
}
export interface LibraryDashboardState {
  mode: 'json' | 'sqlite' | null
  loading: boolean
  error: string
  data: LibraryDashboardData | null
  history: ReadonlyMap<string, Track | null>
}

/** Home keeps small shelves, not a miniature copy of the library. One read
 * pipeline runs at a time; ticks and scan storms retain only the latest demand. */
export function createLibraryDashboard(options: {
  getStorageMode(): Promise<'json' | 'sqlite'>
  getHistory(): readonly UnifiedRecentStat[]
  getPreferences(): { revision: number; versions: RecordingVersion[] }
  shelves?: {
    tracks: number
    history: number
    albums: number
    recentSort: 'insertion' | 'recentlyAdded'
    albumSort: 'trackCount' | 'name'
  }
  api: Pick<
    LibraryDatabaseApi,
    'queryTracks' | 'queryCollections' | 'lookupPlaylistTracks' | 'getTracksByIds' | 'getMetadata'
  >
}) {
  const shelves: NonNullable<typeof options.shelves> = options.shelves ?? {
    tracks: DASHBOARD_SHELF_SIZE,
    history: DASHBOARD_SHELF_SIZE + 1,
    albums: DASHBOARD_ALBUM_COUNT,
    recentSort: 'insertion',
    albumSort: 'trackCount'
  }
  const state = shallowRef<LibraryDashboardState>({
    mode: null,
    loading: false,
    error: '',
    data: null,
    history: new Map()
  })
  let generation = 0,
    minimumRevision = 0,
    disposed = false,
    active = false,
    pending = false,
    libraryDirty = true
  let cached: LibraryDashboardData | null = null
  const changed = () => new Error('曲库在读取首页期间发生变化，请重试')
  function assertLive(): void {
    if (disposed) throw new DOMException('Dashboard was closed', 'AbortError')
  }

  async function readLibrary(): Promise<LibraryDashboardData> {
    const first = await options.api.queryTracks({ sort: 'playlist', limit: shelves.tracks })
    assertLive()
    if (first.revision < minimumRevision) throw changed()
    const contentRevision = first.revision
    // Seek directly from the tail rather than walking 300k rows with OFFSET.
    // The compatibility playlist sort still intentionally ignores direction.
    const recent = await options.api.queryTracks({
      sort: shelves.recentSort,
      direction: 'desc',
      limit: shelves.tracks,
      contentRevision
    })
    assertLive()
    const albums = await options.api.queryCollections('albums', {
      ...(shelves.albumSort === 'trackCount'
        ? { collectionSort: 'trackCount' as const, direction: 'desc' as const }
        : { collectionSort: 'label' as const }),
      limit: shelves.albums,
      contentRevision
    })
    assertLive()
    const artists = await options.api.queryCollections('artists', {
      collectionCountOnly: true,
      contentRevision
    })
    assertLive()
    if (
      [recent.revision, albums.revision, artists.revision].some(
        (revision) => revision !== contentRevision
      )
    )
      throw changed()
    return {
      revision: contentRevision,
      total: first.total,
      duration: first.totalDuration ?? 0,
      albumCount: albums.total,
      artistCount: artists.total,
      first: first.tracks.map(libraryTrack),
      recent: recent.tracks.map(libraryTrack),
      albums: albums.items
    }
  }

  async function readHistory(data: LibraryDashboardData) {
    // Copy just this layout's bounded shelf, never the 10k history table or
    // full local library. Themes retain at most thirty activity entries.
    return readLibraryRecentHistory(
      options.getHistory().slice(0, shelves.history),
      data.revision,
      options,
      assertLive
    )
  }

  function pump(): void {
    if (disposed || active || !pending) return
    pending = false
    active = true
    const request = generation
    void (async () => {
      try {
        const mode = state.value.mode ?? (await options.getStorageMode())
        if (mode !== 'json' && mode !== 'sqlite') throw new Error('无法确认曲库存储，未读取首页')
        if (disposed) return
        state.value = { ...state.value, mode }
        if (mode === 'json') {
          if (request === generation) state.value = { ...state.value, loading: false }
          return
        }
        if (libraryDirty || !cached) {
          libraryDirty = false
          cached = await readLibrary()
        }
        const data = cached
        const history = await readHistory(data)
        assertLive()
        if (
          (await options.api.getMetadata()).revision !== data.revision ||
          data.revision < minimumRevision
        )
          throw changed()
        if (options.getPreferences().revision !== history.preferenceRevision)
          throw new Error('录音版本偏好已变化，请刷新首页')
        if (!disposed && request === generation)
          state.value = { mode, loading: false, error: '', data, history: history.resolved }
      } catch (error) {
        libraryDirty = true
        if (!disposed && request === generation)
          state.value = {
            ...state.value,
            loading: false,
            error: error instanceof Error ? error.message : String(error)
          }
      } finally {
        active = false
        pump()
      }
    })()
  }
  function refresh(reloadLibrary = false): void {
    if (disposed) return
    libraryDirty ||= reloadLibrary
    generation++
    pending = true
    state.value = { ...state.value, loading: true, error: '' }
    pump()
  }
  return {
    state,
    refresh,
    invalidate(revision?: number) {
      if (revision !== undefined) {
        if (revision <= Math.max(minimumRevision, cached?.revision ?? 0)) return
        minimumRevision = revision
      }
      refresh(true)
    },
    retry: () => refresh(true),
    dispose() {
      disposed = true
      pending = false
      generation++
    },
    get requests() {
      return { active: Number(active), pending: Number(pending) }
    }
  }
}
