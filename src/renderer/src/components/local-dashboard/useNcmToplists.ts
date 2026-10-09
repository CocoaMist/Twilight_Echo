import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import type { ProviderInfo } from '../../stores/useProviderStore'
import type { MediaProviderToplistSummary } from '../../providers/mediaProvider'
import type { Track } from '../../types/music'
import { friendlyStreamingError } from '../streaming-page/friendlyStreamingError.ts'

const FEATURED_IDS = ['19723756', '3779629', '2884035', '3778678']

export function useNcmToplists(options: {
  providers: Ref<ProviderInfo[]>
  callProvider: <T>(id: string, method: string, args?: unknown[]) => Promise<T>
}) {
  const available = computed(() =>
    options.providers.value.some(
      (provider) => provider.id === 'ncm' && provider.supportedMethods.includes('fetchToplists')
    )
  )
  const charts = shallowRef<MediaProviderToplistSummary[]>([])
  const featured = computed(() => {
    const preferred = FEATURED_IDS.flatMap((id) =>
      charts.value.filter((chart) => String(chart.id) === id)
    )
    const remaining = charts.value.filter((chart) => !preferred.includes(chart))
    return [...preferred, ...remaining.filter((chart) => chart.featured), ...remaining]
      .filter((chart, index, items) => items.indexOf(chart) === index)
      .slice(0, 4)
  })
  const loading = ref(false)
  const error = ref('')
  const selected = shallowRef<MediaProviderToplistSummary | null>(null)
  const tracks = shallowRef<Track[]>([])
  const detailLoading = ref(false)
  const detailError = ref('')
  let listRevision = 0
  let detailRevision = 0
  let disposed = false

  async function reload(force = true): Promise<void> {
    if (!available.value || disposed) return
    const request = ++listRevision
    loading.value = true
    error.value = ''
    try {
      const items = await options.callProvider<MediaProviderToplistSummary[]>(
        'ncm',
        'fetchToplists',
        [force]
      )
      if (!disposed && available.value && request === listRevision) charts.value = items
    } catch (cause) {
      if (!disposed && available.value && request === listRevision)
        error.value = friendlyStreamingError(cause, '排行榜暂时不可用，请稍后重试')
    } finally {
      if (!disposed && request === listRevision) loading.value = false
    }
  }

  function close(): void {
    detailRevision += 1
    selected.value = null
    tracks.value = []
    detailLoading.value = false
    detailError.value = ''
  }

  async function open(chart: MediaProviderToplistSummary): Promise<Track[] | null> {
    if (!available.value || disposed) return null
    const request = ++detailRevision
    selected.value = chart
    tracks.value = []
    detailError.value = ''
    detailLoading.value = true
    const current = () => !disposed && available.value && request === detailRevision
    try {
      // A chart changes regularly. Do not reuse the provider's indefinite playlist cache.
      const items = await options.callProvider<Track[]>('ncm', 'fetchPlaylistTracks', [
        chart.id,
        true
      ])
      if (!current()) return null
      tracks.value = items
      if (!items.length) detailError.value = '暂时没有读取到榜单歌曲，请重试'
      return items
    } catch (cause) {
      if (current()) detailError.value = friendlyStreamingError(cause, '榜单歌曲加载失败，请重试')
      return null
    } finally {
      if (current()) detailLoading.value = false
    }
  }

  watch(
    available,
    (enabled) => {
      listRevision += 1
      close()
      charts.value = []
      error.value = ''
      loading.value = false
      if (enabled) void reload(false)
    },
    { immediate: true, flush: 'sync' }
  )
  onScopeDispose(() => {
    disposed = true
    listRevision += 1
    detailRevision += 1
  })

  return {
    available,
    charts,
    featured,
    loading,
    error,
    selected,
    tracks,
    detailLoading,
    detailError,
    reload,
    open,
    close
  }
}
