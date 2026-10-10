import { ref, watch } from 'vue'
import type { Track } from '../../types/music.ts'
import {
  resolveProviderTrackId,
  type MediaProviderRegistry
} from '../../providers/mediaProvider.ts'
import {
  notifyProviderFavoriteChange,
  providerFavoriteChange,
  providerFavoriteTrackKey
} from '../../providers/providerFavoriteChanges.ts'

export function useBilibiliFavorites(
  providers: Pick<MediaProviderRegistry, 'get'>,
  accountScope: () => string
) {
  const states = ref(new Map<string, boolean>())
  const pending = ref(new Set<string>())
  const key = (track: Track): string => providerFavoriteTrackKey('bili', track.id)

  watch(accountScope, () => {
    states.value = new Map()
    pending.value = new Set()
  })
  watch(
    providerFavoriteChange,
    (change) => {
      if (change?.providerId !== 'bili') return
      states.value = new Map(states.value).set(
        providerFavoriteTrackKey('bili', change.trackId),
        change.liked
      )
    },
    { flush: 'sync' }
  )

  // This controller is used for songs loaded from the account's favorites.
  const isLiked = (track: Track): boolean => states.value.get(key(track)) ?? true
  const isLoading = (track: Track): boolean => pending.value.has(key(track))

  async function toggle(track: Track): Promise<void> {
    if (isLoading(track)) return
    const provider = providers.get('bili')
    const trackId = resolveProviderTrackId(track, 'bili')
    if (!provider?.likeTrack || trackId == null) throw new Error('Bilibili 音源不支持修改收藏')
    const scope = accountScope()
    const nextLiked = !isLiked(track)
    const trackKey = key(track)
    pending.value = new Set([...pending.value, trackKey])
    try {
      await provider.likeTrack(trackId, nextLiked)
      if (accountScope() === scope) notifyProviderFavoriteChange('bili', trackId, nextLiked)
    } finally {
      if (accountScope() === scope) {
        const next = new Set(pending.value)
        next.delete(trackKey)
        pending.value = next
      }
    }
  }

  return { isLiked, isLoading, toggle }
}
