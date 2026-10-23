import { computed, onMounted, ref } from 'vue'
import { getRecentTracks, waitForListeningStatsReady, useListeningStatsStore } from '../stores/useListeningStatsStore.ts'

export function useLibraryRecentTracks() {
  const statistics = useListeningStatsStore()
  const tracks = computed(() => getRecentTracks(30).flatMap(stat =>
    stat.displayTrack ? [{ ...stat.displayTrack, cover: stat.cover }] : []).slice(0, 6))
  const historyError = ref('')
  function hydrate() {
    void waitForListeningStatsReady()
      .then(() => { historyError.value = '' })
      .catch((error) => {
        historyError.value = error instanceof Error ? error.message : String(error)
      })
  }
  onMounted(hydrate)
  return {
    tracks,
    state: computed(() => ({ loading: !statistics.overview.value && !statistics.error.value })),
    error: computed(() => historyError.value || statistics.error.value),
    retry() {
      historyError.value = ''
      hydrate()
    }
  }
}
