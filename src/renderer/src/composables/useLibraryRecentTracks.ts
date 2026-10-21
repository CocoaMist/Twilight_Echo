import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useMusicStore } from '../stores/useMusicStore.ts'
import { getRecentTracks, waitForListeningStatsReady } from '../stores/useListeningStatsStore.ts'
import { getMusicVersions, musicVersionRevision } from '../stores/musicVersions.ts'
import { createLibraryRecentTracks } from '../stores/library/libraryRecentTracks.ts'

export function useLibraryRecentTracks() {
  const music = useMusicStore()
  const recent = createLibraryRecentTracks({
    getStorageMode: () => window.api.library.getStorageMode(),
    getTracks: () => music.tracks.value,
    getHistory: () => getRecentTracks(30),
    getPreferences: () => {
      const document = getMusicVersions()
      return { revision: musicVersionRevision.value, versions: document.tracks.versions }
    },
    api: {
      lookupPlaylistTracks: (request, revision) =>
        window.api.library.database.lookupPlaylistTracks(request, revision),
      getTracksByIds: (ids, revision) => window.api.library.database.getTracksByIds(ids, revision)
    }
  })
  const historyError = ref('')
  let mounted = false,
    unsubscribe: (() => void) | undefined
  function hydrate() {
    void waitForListeningStatsReady()
      .then(() => {
        if (mounted) recent.refresh()
      })
      .catch((error) => {
        if (mounted) historyError.value = error instanceof Error ? error.message : String(error)
      })
  }
  onMounted(() => {
    mounted = true
    unsubscribe = window.api.library.onChanged((change) => {
      recent.invalidate(change?.kind === 'scan' ? change.update.libraryRevision : change?.revision)
    })
    recent.start()
    hydrate()
  })
  onBeforeUnmount(() => {
    mounted = false
    unsubscribe?.()
    recent.dispose()
  })
  return {
    tracks: recent.tracks,
    state: recent.state,
    error: computed(() => historyError.value || recent.state.value.error),
    capture: recent.capture,
    confirm: recent.confirm,
    retry() {
      historyError.value = ''
      recent.refresh()
      hydrate()
    }
  }
}
