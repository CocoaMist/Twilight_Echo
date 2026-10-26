import { onBeforeUnmount, onMounted } from 'vue'
import { usePlayerStore } from '../stores/usePlayerStore.ts'
import { useCoreConnection } from '../stores/coreConnection.ts'
import { getRecentTracks, waitForListeningStatsReady } from '../stores/useListeningStatsStore.ts'
import { getMusicVersions, musicVersionRevision } from '../stores/musicVersions.ts'
import {
  createLibraryThemeDashboard,
  THEME_DASHBOARD_SHELVES,
  type LibraryDashboardTheme
} from '../stores/library/libraryThemeDashboard.ts'

export function useLibraryThemeDashboard(theme: LibraryDashboardTheme) {
  const player = usePlayerStore(),
    core = useCoreConnection()
  const dashboard = createLibraryThemeDashboard({
    theme,
    getStorageMode: async () => 'sqlite',
    getHistory: () => getRecentTracks(THEME_DASHBOARD_SHELVES[theme].history),
    getPreferences: () => {
      const document = getMusicVersions()
      return { revision: musicVersionRevision.value, versions: document.tracks.versions }
    },
    api: {
      queryTracks: (query) => core.query('library.tracks', query ?? {}),
      queryCollections: (kind, query) => core.query('library.collections', { kind, query }),
      resolveRecentTracks: (entries, revision, versionsRevision) =>
        core.query('library.recent.resolve', { entries, revision, versionsRevision }),
      getTracksByIds: (ids, revision) => core.query('library.byIds', { ids, revision }),
      getArtwork: (ids, revision) => core.query('library.artwork', { ids, revision }),
      getMetadata: () => core.query('library.metadata', {})
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
    unsubscribe = core.subscribe((message) => {
      if (message.kind !== 'state') return
      const snapshot = message.snapshot
      const current = core.state.value
      if (current?.phase === 'ready' && current.epoch === snapshot.epoch)
        dashboard.invalidate(snapshot.libraryRevision ?? undefined)
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
