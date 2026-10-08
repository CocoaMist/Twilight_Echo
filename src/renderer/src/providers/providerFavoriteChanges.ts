import { shallowRef } from 'vue'

export const providerFavoriteChange = shallowRef<{
  providerId: string
  trackId: string | number
  liked: boolean
} | null>(null)

/** Bilibili favorites belong to the video, shared by all of its parts. */
export function providerFavoriteTrackKey(providerId: string, trackId: string | number): string {
  const id = providerId.toLowerCase()
  const rawId = String(trackId)
  const localId = rawId.startsWith(`${id}:`) ? rawId.slice(id.length + 1) : rawId
  return JSON.stringify([id, id === 'bili' ? localId.split(':')[0] : localId])
}

export function notifyProviderFavoriteChange(
  providerId: string,
  trackId: string | number,
  liked: boolean
): void {
  providerFavoriteChange.value = { providerId, trackId, liked }
}
