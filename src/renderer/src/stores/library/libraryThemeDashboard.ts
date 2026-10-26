import { computed, ref, watch } from 'vue'
import type { LibraryQuery } from '../../../../shared/libraryDatabase.ts'
import type { Track } from '../../types/music.ts'
import type { LibraryItem } from './musicStoreTypes.ts'
import { createLibraryDashboard } from './libraryDashboard.ts'
import { getTrackSource } from '../../utils/trackSourceIdentity.ts'

export type LibraryDashboardTheme = 'archive' | 'nightHarbor' | 'soundField'
export const THEME_DASHBOARD_SHELVES = {
  archive: { history: 30, albums: 4 },
  nightHarbor: { history: 6, albums: 4 },
  soundField: { history: 30, albums: 8 }
} as const
type DashboardOptions = Parameters<typeof createLibraryDashboard>[0]
type QueryPlayOptions = {
  randomStart?: boolean
  playMode?: 'shuffle'
  onQueryFailure?: (error: unknown) => void
}

/** The three themed homes share bounded Core shelves and playback. */
export function createLibraryThemeDashboard(
  options: Pick<DashboardOptions, 'getStorageMode' | 'getPreferences' | 'getHistory' | 'api'> & {
    theme: LibraryDashboardTheme
    getTracks?(): Track[]
    getAlbums?(): LibraryItem[]
    getArtistCount?(): number
    player: {
      getCurrentTrack(): Pick<Track, 'id'> | null
      getIsPlaying(): boolean
      togglePlay(): void
      setPlayMode(mode: 'shuffle'): void
      playTrack(track: Track, queue: Track[]): void
      playLibraryQuery(
        query: LibraryQuery,
        selectedId?: string,
        options?: QueryPlayOptions
      ): Promise<void>
    }
  }
) {
  const shelf = THEME_DASHBOARD_SHELVES[options.theme]
  const history = computed(options.getHistory)
  const source = createLibraryDashboard({
    ...options,
    getHistory: () => history.value,
    shelves: {
      tracks: 30,
      history: shelf.history,
      albums: shelf.albums,
      recentSort: 'recentlyAdded',
      albumSort: 'name'
    }
  })
  const state = source.state
  const database = computed(() => state.value.mode !== 'json')
  const ready = computed(() => state.value.data !== null)
  const recentlyAdded = computed(() => state.value.data?.recent ?? [])
  const recent = computed(() => {
    const tracks: Track[] = [],
      seen = new Set<string>()
    for (const stat of history.value.slice(0, shelf.history)) {
      const track = state.value.history.get(stat.id)
      if (!track || seen.has(track.id)) continue
      seen.add(track.id)
      tracks.push(track)
    }
    return tracks
  })
  const hero = computed(
    () => recent.value.find((track) => track.id === options.player.getCurrentTrack()?.id)
      ?? recentlyAdded.value.find((track) => track.id === options.player.getCurrentTrack()?.id)
      ?? recent.value[0] ?? recentlyAdded.value[0] ?? null
  )
  const heroIsCurrent = computed(
    () =>
      !!options.player.getCurrentTrack() && hero.value?.id === options.player.getCurrentTrack()?.id
  )
  const albumCards = computed(() => {
    return (state.value.data?.albums ?? []).map((album) => ({
        key: album.id,
        name: album.name,
        artist: album.artist || '未知艺术家',
        cover: album.cover,
        coverSource: album.coverSource,
        identity: album.id,
        trackCount: album.trackCount
      }))
  })
  const summary = computed(() => {
    const totalSeconds = state.value.data?.duration ?? 0
    const hours = totalSeconds / 3600,
      minutes = Math.round(totalSeconds / 60)
    return {
      tracks: state.value.data?.total ?? 0,
      albums: state.value.data?.albumCount ?? 0,
      artists: state.value.data?.artistCount ?? 0,
      totalSeconds,
      hours: Math.floor(minutes / 60),
      minutes: minutes % 60,
      duration:
        hours >= 1
          ? Math.round(hours).toLocaleString('zh-CN')
          : Math.round(totalSeconds / 60).toString(),
      durationUnit: hours >= 1 ? '小时音乐' : '分钟音乐'
    }
  })
  const actionError = ref('')
  const error = computed(() => actionError.value || state.value.error)
  const loading = computed(() => database.value && !state.value.data && !error.value)
  let started = false,
    disposed = false,
    intent = 0,
    reading = false
  let pending: { track: Track; revision: number; intent: number } | null = null
  function cancelPlay() {
    intent++
    pending = null
  }
  function report(error: unknown) {
    if (!disposed) actionError.value = error instanceof Error ? error.message : String(error)
  }
  function playQuery(query: LibraryQuery, id?: string, options_?: QueryPlayOptions) {
    void options.player
      .playLibraryQuery(query, id, { ...options_, onQueryFailure: report })
      .catch(report)
  }
  function pumpPlay() {
    if (disposed || reading || !pending) return
    const request = pending
    pending = null
    reading = true
    void (async () => {
      try {
        const page = await options.api.getTracksByIds([request.track.id], request.revision)
        if (disposed || request.intent !== intent) return
        if (page.revision !== request.revision || state.value.data?.revision !== request.revision)
          throw new Error('曲库已变化，请刷新首页后重试')
        actionError.value = ''
        if (page.tracks.some((track) => track.id === request.track.id))
          playQuery({ sort: 'playlist', contentRevision: request.revision }, request.track.id)
        else if (getTrackSource(request.track) !== 'local')
          options.player.playTrack(request.track, [request.track])
        else throw new Error('这首本地歌曲已不在曲库中，请刷新首页')
      } catch (error) {
        if (!disposed && request.intent === intent) report(error)
      } finally {
        reading = false
        pumpPlay()
      }
    })()
  }
  function play(track: Track) {
    if (disposed) return
    cancelPlay()
    actionError.value = ''
    if (options.player.getCurrentTrack()?.id === track.id) {
      options.player.togglePlay()
      return
    }
    if (state.value.mode === 'sqlite' && state.value.data) {
      pending = { track, revision: state.value.data.revision, intent }
      pumpPlay()
    } else report(new Error('首页尚未载入，请稍后重试'))
  }
  function shuffle() {
    if (disposed) return
    cancelPlay()
    actionError.value = ''
    const data = state.value.data
    if (state.value.mode === 'sqlite' && data?.total)
      playQuery({ sort: 'playlist', contentRevision: data.revision }, undefined, {
        randomStart: true,
        playMode: 'shuffle'
      })
  }
  const stops = [
    watch([history, () => options.getPreferences().revision], () => {
      if (started && database.value) source.refresh()
    }),
    watch([options.player.getCurrentTrack, options.player.getIsPlaying], cancelPlay, {
      flush: 'sync'
    })
  ]
  return {
    state,
    database,
    ready,
    summary,
    recent,
    recentlyAdded,
    hero,
    heroIsCurrent,
    albumCards,
    loading,
    error,
    play,
    shuffle,
    start() {
      if (disposed || started) return
      started = true
      source.refresh(true)
    },
    invalidate: source.invalidate,
    refreshHistory: () => source.refresh(),
    report,
    retry() {
      actionError.value = ''
      source.retry()
    },
    dispose() {
      disposed = true
      cancelPlay()
      stops.forEach((stop) => stop())
      source.dispose()
    },
    get requests() {
      return { ...source.requests, playback: Number(reading), pendingPlayback: Number(!!pending) }
    }
  }
}
