import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { Track } from '../../types/music.ts'
import { syncPluginProviders } from '../../providers/index.ts'
import {
  getTrackProviderId,
  resolveProviderTrackId,
  type MediaProviderRegistry
} from '../../providers/mediaProvider.ts'

const DEFAULT_FAVORITE_PLAYLIST_NAME = '我收藏的音乐'

type FavoritePlaylist = {
  id: string
  name: string
  trackIds: string[]
  isDefault?: boolean
}

type UseFavoriteButtonOptions = {
  currentTrack: ComputedRef<Track | null> | Ref<Track | null>
  playlists: ComputedRef<FavoritePlaylist[]> | Ref<FavoritePlaylist[]>
  mediaProviders: MediaProviderRegistry
  addToPlaylist: (playlistName: string, trackId: string) => void
  removeFromPlaylist: (playlistName: string, trackId: string) => void
  createPlaylist: (name: string) => void
  isFavoriteTrack?: (track: Track) => boolean
  addFavoriteTrack?: (track: Track) => void
  removeFavoriteTrack?: (track: Track) => void
}

function isLocalTrack(track: Pick<Track, 'id' | 'source'>): boolean {
  const providerId = getTrackProviderId(track)
  return providerId == null || providerId === 'local'
}

export function useFavoriteButton({
  currentTrack,
  playlists,
  mediaProviders,
  addToPlaylist,
  removeFromPlaylist,
  createPlaylist,
  isFavoriteTrack,
  addFavoriteTrack,
  removeFavoriteTrack
}: UseFavoriteButtonOptions): {
  favoriteButtonVisible: ComputedRef<boolean>
  favoriteButtonLiked: ComputedRef<boolean>
  favoriteButtonLoading: ComputedRef<boolean>
  favoriteButtonTitle: ComputedRef<string>
  toggleFavorite: () => Promise<void>
} {
  const providerFavoriteAvailable = ref(false)
  const providerFavoriteLoading = ref(false)
  const providerFavoriteLiked = ref(false)
  // 当前 provider 喜欢状态对应的曲目 id：切歌后旧曲目的状态绝不能
  // 显示到新曲目上（心动模式等场景会频繁快速切歌）。
  const providerFavoriteTrackId = ref<string | null>(null)
  let providerFavoriteRequestId = 0

  const defaultFavoritePlaylist = computed(
    () =>
      playlists.value.find((playlist) => playlist.isDefault) ??
      playlists.value.find((playlist) => playlist.name === DEFAULT_FAVORITE_PLAYLIST_NAME) ??
      null
  )

  const localFavoriteLiked = computed(() => {
    const track = currentTrack.value
    if (track && isFavoriteTrack) return isFavoriteTrack(track)
    const playlist = defaultFavoritePlaylist.value
    return !!track && !!playlist && playlist.trackIds.includes(track.id)
  })

  const favoriteButtonVisible = computed(() => {
    const track = currentTrack.value
    if (!track) return false
    return isLocalTrack(track) || providerFavoriteAvailable.value
  })

  const favoriteButtonLiked = computed(() => {
    const track = currentTrack.value
    if (!track) return false
    if (isLocalTrack(track)) return localFavoriteLiked.value
    return (
      providerFavoriteLiked.value &&
      providerFavoriteTrackId.value != null &&
      providerFavoriteTrackId.value === track.id
    )
  })

  const favoriteButtonLoading = computed(() => {
    const track = currentTrack.value
    return !!track && !isLocalTrack(track) && providerFavoriteLoading.value
  })

  const favoriteButtonTitle = computed(() => {
    const track = currentTrack.value
    const platform =
      track && !isLocalTrack(track)
        ? mediaProviders.get(getTrackProviderId(track) ?? '')?.name
        : null
    return platform
      ? favoriteButtonLiked.value
        ? '在' + platform + '取消喜欢'
        : '在' + platform + '喜欢'
      : favoriteButtonLiked.value
        ? '移出应用收藏'
        : '加入应用收藏'
  })

  async function refreshProviderFavoriteState(track: Track | null | undefined): Promise<void> {
    const requestId = ++providerFavoriteRequestId
    providerFavoriteAvailable.value = false
    providerFavoriteLiked.value = false
    providerFavoriteTrackId.value = null
    if (!track || isLocalTrack(track)) return

    const providerId = getTrackProviderId(track)
    if (!providerId) return
    const providerTrackId = resolveProviderTrackId(track, providerId)
    if (providerTrackId == null) return

    if (typeof window !== 'undefined' && window.api?.providers) {
      await syncPluginProviders()
      if (requestId !== providerFavoriteRequestId) return
    }

    const provider = mediaProviders.get(providerId)
    providerFavoriteAvailable.value = Boolean(provider?.likeTrack)
    if (!provider?.isTrackLiked) return

    try {
      const liked = await provider.isTrackLiked(providerTrackId)
      if (requestId === providerFavoriteRequestId) {
        providerFavoriteLiked.value = liked
        providerFavoriteTrackId.value = track.id
      }
    } catch (error) {
      console.warn(`Failed to read ${providerId} favorite state`, error)
    }
  }

  function toggleLocalFavorite(track: Track): void {
    if (isFavoriteTrack && addFavoriteTrack && removeFavoriteTrack) {
      if (isFavoriteTrack(track)) {
        removeFavoriteTrack(track)
      } else {
        addFavoriteTrack(track)
      }
      return
    }

    let playlist = defaultFavoritePlaylist.value
    if (!playlist) {
      createPlaylist(DEFAULT_FAVORITE_PLAYLIST_NAME)
      playlist = defaultFavoritePlaylist.value
    }
    if (!playlist) return

    if (playlist.trackIds.includes(track.id)) {
      removeFromPlaylist(playlist.name, track.id)
    } else {
      addToPlaylist(playlist.name, track.id)
    }
  }

  async function toggleProviderFavorite(track: Track): Promise<void> {
    if (providerFavoriteLoading.value) return
    const providerId = getTrackProviderId(track)
    if (!providerId) return
    const providerTrackId = resolveProviderTrackId(track, providerId)
    if (providerTrackId == null) return

    const trackId = track.id
    const nextLiked = !providerFavoriteLiked.value
    ++providerFavoriteRequestId
    providerFavoriteLoading.value = true
    try {
      if (typeof window !== 'undefined' && window.api?.providers) {
        await syncPluginProviders()
      }
      const provider = mediaProviders.get(providerId)
      if (!provider?.likeTrack) return

      await provider.likeTrack(providerTrackId, nextLiked)
      if (currentTrack.value?.id === trackId) {
        providerFavoriteLiked.value = nextLiked
        providerFavoriteTrackId.value = trackId
      }
    } catch (error) {
      console.warn(`Failed to toggle ${providerId} favorite state`, error)
    } finally {
      providerFavoriteLoading.value = false
    }
  }

  async function toggleFavorite(): Promise<void> {
    const track = currentTrack.value
    if (!track) return

    if (!isLocalTrack(track)) {
      await toggleProviderFavorite(track)
      return
    }

    toggleLocalFavorite(track)
  }

  watch(
    () =>
      [currentTrack.value?.id, currentTrack.value?.source, currentTrack.value?.ncmSongId] as const,
    () => {
      void refreshProviderFavoriteState(currentTrack.value)
    },
    { immediate: true }
  )

  return {
    favoriteButtonVisible,
    favoriteButtonLiked,
    favoriteButtonLoading,
    favoriteButtonTitle,
    toggleFavorite
  }
}
