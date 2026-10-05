import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import type { ProviderInfo, ProviderLoginState } from '../../stores/useProviderStore'
import type { Track } from '../../types/music'
import type {
  MediaProviderDiscoveryPlaylistPage,
  MediaProviderPlaylistSummary
} from '../../providers/mediaProvider'
import { friendlyStreamingError } from '../streaming-page/friendlyStreamingError.ts'

export function useOnlineHome(options: {
  providers: Ref<ProviderInfo[]>
  preferredProvider: Ref<string>
  checkLogin: (id: string) => Promise<ProviderLoginState>
  callProvider: <T>(id: string, method: string, args?: unknown[]) => Promise<T>
}) {
  const providers = computed(() =>
    options.providers.value.filter((provider) =>
      provider.capabilities.some((capability) =>
        ['playbackUrl', 'search', 'library', 'playlist'].includes(capability)
      )
    )
  )
  const provider = computed(
    () =>
      providers.value.find((item) => item.id === options.preferredProvider.value) ??
      providers.value[0] ??
      null
  )
  const loading = ref(false)
  const loggedIn = ref(false)
  const error = ref('')
  const tracks = shallowRef<Track[]>([])
  const playlists = shallowRef<MediaProviderPlaylistSummary[]>([])
  const sectionTitle = ref('为你推荐')
  const playlistTitle = ref('精选歌单')
  let contentProviderId: string | null = null
  let revision = 0
  let disposed = false

  async function reload(): Promise<void> {
    if (disposed) return
    const request = ++revision
    const source = provider.value
    const current = () => !disposed && request === revision && source?.id === provider.value?.id
    // Keep the last usable snapshot during a refresh, but never carry it into
    // another provider's actions. The synchronous watcher clears it before render.
    if (source?.id !== contentProviderId) {
      tracks.value = []
      playlists.value = []
      loggedIn.value = false
      sectionTitle.value = '为你推荐'
      playlistTitle.value = '精选歌单'
      contentProviderId = source?.id ?? null
    }
    error.value = ''
    loading.value = !!source
    if (!source) return

    const failures: unknown[] = []
    try {
      let authenticated = !source.capabilities.includes('login')
      if (!authenticated) {
        try {
          authenticated = (await options.checkLogin(source.id)).loggedIn
        } catch (cause) {
          failures.push(cause)
        }
      }
      if (!current()) return
      const homeAvailable = authenticated || source.ui?.streamingHome?.requiresLogin === false
      const section = homeAvailable
        ? source.ui?.streamingSections?.find(
            (item) =>
              source.supportedMethods.includes(item.method) &&
              (authenticated || !item.requiresLogin)
          )
        : undefined
      const nextSectionTitle = section?.title ?? '为你推荐'
      let nextPlaylistTitle = '精选歌单'

      async function loadPlaylists(): Promise<MediaProviderPlaylistSummary[]> {
        if (homeAvailable && source!.supportedMethods.includes('fetchRecommendPlaylists')) {
          try {
            const items = await options.callProvider<MediaProviderPlaylistSummary[]>(
              source!.id,
              'fetchRecommendPlaylists'
            )
            if (items.length || !current()) return items
          } catch (cause) {
            if (!source!.supportedMethods.includes('fetchDiscoveryPlaylists')) throw cause
            failures.push(cause)
          }
        }
        // Public discovery keeps a signed-out home useful without calling personal endpoints.
        if (current() && source!.supportedMethods.includes('fetchDiscoveryPlaylists')) {
          nextPlaylistTitle = '发现歌单'
          const page = await options.callProvider<MediaProviderDiscoveryPlaylistPage>(
            source!.id,
            'fetchDiscoveryPlaylists',
            ['全部', 'hot', 6, 0]
          )
          return page.items
        }
        return []
      }

      const results = await Promise.allSettled([
        section
          ? options.callProvider<Track[]>(source.id, section.method, section.args ?? [])
          : Promise.resolve<Track[]>([]),
        loadPlaylists()
      ])
      if (!current()) return
      const [songs, collections] = results
      // Vue batches this snapshot into one render. An empty success replaces old
      // content; a failed section keeps its useful last result and matching title.
      loggedIn.value = authenticated
      if (songs.status === 'fulfilled') {
        tracks.value = songs.value.slice(0, 12)
        sectionTitle.value = nextSectionTitle
      } else failures.push(songs.reason)
      if (collections.status === 'fulfilled') {
        playlists.value = collections.value.slice(0, 6)
        playlistTitle.value = nextPlaylistTitle
      } else failures.push(collections.reason)
      if (failures.length)
        error.value = friendlyStreamingError(failures[0], '部分在线内容暂时不可用')
    } finally {
      if (current()) loading.value = false
    }
  }

  // Health polling replaces provider objects; reload only when content capabilities change.
  watch(
    () =>
      JSON.stringify([
        provider.value?.id,
        provider.value?.capabilities,
        provider.value?.supportedMethods,
        provider.value?.ui
      ]),
    () => void reload(),
    { immediate: true, flush: 'sync' }
  )
  onScopeDispose(() => {
    disposed = true
    revision += 1
  })

  return {
    providers,
    provider,
    loading,
    loggedIn,
    error,
    tracks,
    playlists,
    sectionTitle,
    playlistTitle,
    reload
  }
}
