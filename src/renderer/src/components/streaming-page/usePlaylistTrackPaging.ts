import { ref, type ShallowRef } from 'vue'
import type { MediaProviderPlaylistTracksPage } from '../../providers/mediaProvider.ts'
import type { Track } from '../../types/music'

type PageLoader = (offset: number, force: boolean) => Promise<MediaProviderPlaylistTracksPage>

export interface PlaylistTrackPagingSnapshot {
  loader: PageLoader | null
  nextOffset: number
  active: boolean
  hasMore: boolean
  total: number | null
  error: string
}

export function usePlaylistTrackPaging(
  tracks: ShallowRef<Track[]>,
  formatError: (error: unknown) => string
) {
  const active = ref(false)
  const hasMore = ref(false)
  const loading = ref(false)
  const error = ref('')
  const total = ref<number | null>(null)
  let nextOffset = 0
  let generation = 0
  let loader: PageLoader | null = null

  function reset(): void {
    generation++
    loader = null
    nextOffset = 0
    active.value = false
    hasMore.value = false
    loading.value = false
    error.value = ''
    total.value = null
  }

  function snapshot(): PlaylistTrackPagingSnapshot {
    return {
      loader,
      nextOffset,
      active: active.value,
      hasMore: hasMore.value || (loading.value && nextOffset === 0),
      total: total.value,
      error: error.value
    }
  }

  function restore(saved?: PlaylistTrackPagingSnapshot): void {
    reset()
    if (!saved) return
    loader = saved.loader
    nextOffset = saved.nextOffset
    active.value = saved.active
    hasMore.value = saved.hasMore
    total.value = saved.total
    error.value = saved.error
  }

  async function loadPage(first: boolean, force = false): Promise<void> {
    if (!loader || loading.value || (!first && !hasMore.value)) return
    const requestGeneration = generation
    const offset = nextOffset
    loading.value = true
    error.value = ''
    try {
      const page = await loader(offset, force)
      if (requestGeneration !== generation) return
      if (
        !Array.isArray(page.tracks) ||
        typeof page.hasMore !== 'boolean' ||
        !Number.isSafeInteger(page.nextOffset) ||
        page.nextOffset < offset ||
        (page.hasMore && page.nextOffset <= offset)
      ) {
        throw new Error('歌单分页数据不完整，请重试')
      }
      const result = first ? [] : [...tracks.value]
      const ids = new Set(result.map((track) => track.id))
      for (const track of page.tracks) {
        if (ids.has(track.id)) continue
        ids.add(track.id)
        result.push(track)
      }
      tracks.value = result
      nextOffset = page.nextOffset
      total.value = page.total
      hasMore.value = page.hasMore
    } catch (cause) {
      if (requestGeneration !== generation) return
      if (first) throw cause
      error.value = formatError(cause)
    } finally {
      if (requestGeneration === generation) loading.value = false
    }
  }

  async function open(load: PageLoader, force = false): Promise<void> {
    reset()
    active.value = true
    loader = load
    await loadPage(true, force)
  }

  return {
    active,
    hasMore,
    loading,
    error,
    total,
    reset,
    snapshot,
    restore,
    open,
    loadMore: () => loadPage(false)
  }
}
