import { onBeforeUnmount, onMounted } from 'vue'
import { useMusicStore } from '../stores/useMusicStore.ts'
import { usePlayerStore } from '../stores/usePlayerStore.ts'
import { getRecentTracks, waitForListeningStatsReady } from '../stores/useListeningStatsStore.ts'
import { getMusicVersions, musicVersionRevision } from '../stores/musicVersions.ts'
import {
  createLibraryThemeDashboard,
  THEME_DASHBOARD_SHELVES,
  type LibraryDashboardTheme
} from '../stores/library/libraryThemeDashboard.ts'

export function useLibraryThemeDashboard(theme: LibraryDashboardTheme) {
  const music = useMusicStore(),
    player = usePlayerStore()
  const dashboard = createLibraryThemeDashboard({
    theme,
    getStorageMode: () => window.api.library.getStorageMode(),
    getTracks: () => music.tracks.value,
    getAlbums: () => music.albums.value,
    getArtistCount: () => music.artists.value.length,
    getHistory: () => getRecentTracks(THEME_DASHBOARD_SHELVES[theme].history),
    getPreferences: () => {
      const document = getMusicVersions()
      return { revision: musicVersionRevision.value, versions: document.tracks.versions }
    },
    api: {
      queryTracks: (query) => window.api.library.database.queryTracks(query),
      queryCollections: (kind, query) => window.api.library.database.queryCollections(kind, query),
      lookupPlaylistTracks: (request, revision) =>
        window.api.library.database.lookupPlaylistTracks(request, revision),
      getTracksByIds: (ids, revision) => window.api.library.database.getTracksByIds(ids, revision),
      getMetadata: () => window.api.library.database.getMetadata()
    },
    player: {
      getCurrentTrack: () => player.currentTrack.value,
      getIsPlaying: () => player.isPlaying.value,
      togglePlay: player.togglePlay,
      setPlayMode: player.setPlayMode,
      playTrack: player.playTrack,
      playLibraryQuery: player.playLibraryQuery
    }
  })
  let mounted = false,
    unsubscribe: (() => void) | undefined
  function readHistory() {
    void waitForListeningStatsReady()
      .then(() => {
        if (mounted) dashboard.refreshHistory()
      })
      .catch((error) => {
        if (mounted) dashboard.report(error)
      })
  }
  onMounted(() => {
    mounted = true
    unsubscribe = window.api.library.onChanged((change) => {
      dashboard.invalidate(
        change?.kind === 'scan' ? change.update.libraryRevision : change?.revision
      )
    })
    dashboard.start()
    readHistory()
  })
  onBeforeUnmount(() => {
    mounted = false
    unsubscribe?.()
    dashboard.dispose()
  })
  return {
    ...dashboard,
    retry() {
      dashboard.retry()
      readHistory()
    }
  }
}
