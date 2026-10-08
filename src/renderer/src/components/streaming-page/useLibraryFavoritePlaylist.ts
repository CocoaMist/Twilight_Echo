import { computed, ref, watch } from 'vue'
import type { MediaProviderPlaylistSummary } from '../../providers/mediaProvider'

/** The library card's selection is local to each provider account. */
export function useLibraryFavoritePlaylist(
  scope: () => string,
  defaultPlaylist: () => MediaProviderPlaylistSummary | null,
  playlists: () => readonly MediaProviderPlaylistSummary[],
  storage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage
) {
  const selectedId = ref<string | null>(null)
  const storageError = ref('')
  const options = computed(() => {
    const fallback = defaultPlaylist()
    if (!fallback) return []
    const seen = new Set<string>()
    return [fallback, ...playlists()].filter((playlist) => {
      const id = String(playlist.id)
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  })
  const selectedPlaylist = computed(
    () =>
      options.value.find((playlist) => String(playlist.id) === selectedId.value) ??
      defaultPlaylist()
  )
  const storageKey = () => `te-library-favorite:${scope()}`

  watch(
    scope,
    () => {
      selectedId.value = null
      storageError.value = ''
      try {
        selectedId.value = storage().getItem(storageKey())
      } catch {
        storageError.value = '无法读取已保存的收藏夹，当前展示默认收藏夹'
      }
    },
    { immediate: true, flush: 'sync' }
  )

  function select(id: string): void {
    if (!options.value.some((playlist) => String(playlist.id) === id)) return
    selectedId.value = id
    try {
      storage().setItem(storageKey(), id)
      storageError.value = ''
    } catch {
      storageError.value = '收藏夹已切换，但无法保存；重启后将恢复原选择'
    }
  }

  return { options, selectedPlaylist, storageError, select }
}
