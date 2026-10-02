import { ref, shallowRef } from 'vue'
import type { Track } from '@renderer/types/music'

export function useProviderHistory(fetchTracks: (providerId: string) => Promise<Track[]>) {
  const tracks = shallowRef<Track[]>([])
  const loading = ref(false)
  const error = ref('')
  let request = 0
  let selectedProvider = ''
  function invalidate(clear = true): void {
    request += 1
    if (clear) tracks.value = []
    loading.value = false
    error.value = ''
  }
  async function load(providerId: string): Promise<void> {
    const token = ++request
    if (providerId !== selectedProvider) tracks.value = []
    selectedProvider = providerId
    error.value = ''
    loading.value = true
    try {
      const result = await fetchTracks(providerId)
      if (token === request) tracks.value = result
    } catch (cause) {
      if (token === request) error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (token === request) loading.value = false
    }
  }
  return { tracks, loading, error, load, invalidate }
}
