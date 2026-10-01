import { computed, ref, shallowRef, type Ref } from 'vue'
import type { UiContribution } from '../extensions/registry'
import type { SectionKey, SettingsSearchEntry } from '@renderer/components/settings-page/types.ts'

export type SettingsSection = SectionKey

export interface SettingsNavigationTarget {
  revision: number
  entry?: SettingsSearchEntry
  anchor?: 'device-profiles'
}

export type ThemeStudioDomain =
  | 'presets'
  | 'personalization'
  | 'shell'
  | 'navigation'
  | 'library'
  | 'typography'
  | 'player'
  | 'windows'
  | 'motion'
  | 'advanced'

const songlistOrder = [
  'dashboard',
  'allSongs',
  'artists',
  'albums',
  'genres',
  'playlists',
  'aggregate',
  'folders',
  'recent',
  'analytics'
] as const

export function useAppNavigation(options: { persistentNavigation?: () => boolean } = {}) {
  const menuOpen = ref(false)
  const showPlayingPage = ref(false)
  const showStreamingPage = ref(false)
  const showRadioPodcastPage = ref(false)
  const showNetworkSourcesPage = ref(false)
  const showLoginPage = ref(false)
  const loginPageMode = ref<'login' | 'profile'>('login')
  const loginInitialProviderId = ref<string | null>(null)
  const showSettingsPage = ref(false)
  const showThemeStudioPage = ref(false)
  const themeStudioInitialDomain = ref<ThemeStudioDomain>('presets')
  const showPluginPage = ref(false)
  const showEqualizerPage = ref(false)
  const showDspRackPage = ref(false)
  const activePluginPage = ref<UiContribution | null>(null)
  const settingsInitialSection = ref<SettingsSection>('general')
  const settingsNavigationTarget = shallowRef<SettingsNavigationTarget>({ revision: 0 })
  const activeCategory = ref('dashboard')
  const activeFilter = ref<string | null>(null)
  const songlistTransitionName = ref<'page-down' | 'page-up'>('page-down')
  const streamingMenuOpen = ref(false)
  const localMenuOpenBeforeStreaming = ref(false)

  // Base music destinations survive contextual pages. Only one foreground page
  // is active at a time; closing it restores the exact originating destination.
  const foreground = {
    playing: showPlayingPage,
    login: showLoginPage,
    settings: showSettingsPage,
    theme: showThemeStudioPage,
    plugins: showPluginPage,
    equalizer: showEqualizerPage,
    dsp: showDspRackPage
  }
  const baseSurfaceVisible = computed(
    () => !Object.values(foreground).some((page) => page.value) && !activePluginPage.value
  )
  const showStreamingSurface = computed(() => baseSurfaceVisible.value && showStreamingPage.value)
  const localViewVisible = computed(
    () =>
      baseSurfaceVisible.value &&
      !showStreamingPage.value &&
      !showRadioPodcastPage.value &&
      !showNetworkSourcesPage.value
  )

  function snapshot() {
    return {
      pages: Object.fromEntries(Object.entries(foreground).map(([key, page]) => [key, page.value])),
      streaming: showStreamingPage.value,
      radio: showRadioPodcastPage.value,
      network: showNetworkSourcesPage.value,
      plugin: activePluginPage.value,
      section: settingsInitialSection.value,
      domain: themeStudioInitialDomain.value,
      loginMode: loginPageMode.value,
      provider: loginInitialProviderId.value
    }
  }
  const returnStack: Array<{ owner: string; state: ReturnType<typeof snapshot> }> = []
  function dismissDestinationMenu(): void {
    if (!options.persistentNavigation?.()) menuOpen.value = false
  }
  function clearForeground(): void {
    Object.values(foreground).forEach((page) => {
      page.value = false
    })
    activePluginPage.value = null
  }
  function resetDestination(): void {
    clearForeground()
    returnStack.length = 0
    showStreamingPage.value = false
    showRadioPodcastPage.value = false
    showNetworkSourcesPage.value = false
    streamingMenuOpen.value = false
  }
  function openLayer(owner: string): void {
    const alreadyOpen =
      owner === 'extension'
        ? !!activePluginPage.value
        : foreground[owner as keyof typeof foreground]?.value
    if (!alreadyOpen) {
      returnStack.push({ owner, state: snapshot() })
      if (returnStack.length > 16) returnStack.shift()
    }
    clearForeground()
    dismissDestinationMenu()
    streamingMenuOpen.value = false
    if (owner !== 'extension') foreground[owner as keyof typeof foreground].value = true
  }
  function closeLayer(owner: string): void {
    const active =
      owner === 'extension'
        ? !!activePluginPage.value
        : foreground[owner as keyof typeof foreground]?.value
    if (!active) return
    clearForeground()
    const last = returnStack.at(-1)
    if (!last || last.owner !== owner) {
      returnStack.length = 0
      return
    }
    returnStack.pop()
    const state = last.state
    for (const [key, page] of Object.entries(foreground)) page.value = state.pages[key] === true
    showStreamingPage.value = state.streaming
    showRadioPodcastPage.value = state.radio
    showNetworkSourcesPage.value = state.network
    activePluginPage.value = state.plugin
    settingsInitialSection.value = state.section
    themeStudioInitialDomain.value = state.domain
    loginPageMode.value = state.loginMode
    loginInitialProviderId.value = state.provider
  }
  function toggleStreamingMenu(): void {
    streamingMenuOpen.value = !streamingMenuOpen.value
  }
  function collapseMenu(): void {
    menuOpen.value = false
    streamingMenuOpen.value = false
  }
  function onSelectView(category: string, filter: string | null): void {
    const currentIndex = songlistOrder.indexOf(
      activeCategory.value as (typeof songlistOrder)[number]
    )
    const nextIndex = songlistOrder.indexOf(category as (typeof songlistOrder)[number])
    if (currentIndex !== -1 && nextIndex !== -1)
      songlistTransitionName.value = nextIndex > currentIndex ? 'page-down' : 'page-up'
    resetDestination()
    activeCategory.value = category
    activeFilter.value = filter
    dismissDestinationMenu()
  }
  function closePluginPage(): void {
    closeLayer('extension')
  }
  function onSelectPluginPage(page: UiContribution): void {
    openLayer('extension')
    showStreamingPage.value = false
    showRadioPodcastPage.value = false
    showNetworkSourcesPage.value = false
    activePluginPage.value = page
  }
  function openPlayingPage(): void {
    openLayer('playing')
  }
  function closePlayingPage(): void {
    closeLayer('playing')
  }
  function enterStreamingMode(): void {
    if (!showStreamingPage.value) localMenuOpenBeforeStreaming.value = menuOpen.value
    resetDestination()
    dismissDestinationMenu()
    showStreamingPage.value = true
  }
  function returnToLocalMode(): void {
    resetDestination()
    menuOpen.value = localMenuOpenBeforeStreaming.value
  }
  function enterRadioPodcastMode(): void {
    resetDestination()
    dismissDestinationMenu()
    showRadioPodcastPage.value = true
  }
  function closeRadioPodcastPage(): void {
    resetDestination()
  }
  function enterNetworkSourcesMode(): void {
    resetDestination()
    dismissDestinationMenu()
    showNetworkSourcesPage.value = true
  }
  function closeNetworkSourcesPage(): void {
    resetDestination()
  }
  function openLoginPage(
    initialProviderId: string | null = null,
    options?: { profile?: boolean }
  ): void {
    openLayer('login')
    showStreamingPage.value = false
    showRadioPodcastPage.value = false
    showNetworkSourcesPage.value = false
    loginPageMode.value = options?.profile ? 'profile' : 'login'
    loginInitialProviderId.value = initialProviderId
  }
  function closeLoginPage(): void {
    closeLayer('login')
    loginPageMode.value = 'login'
    loginInitialProviderId.value = null
  }
  function openSettingsPage(
    section: SettingsSection = 'general',
    target: Omit<SettingsNavigationTarget, 'revision'> = {}
  ): void {
    openLayer('settings')
    settingsInitialSection.value = section
    settingsNavigationTarget.value = {
      ...target,
      revision: settingsNavigationTarget.value.revision + 1
    }
  }
  function closeSettingsPage(): void {
    closeLayer('settings')
  }
  function openThemeStudioPage(initialDomain: ThemeStudioDomain = 'presets'): void {
    if (initialDomain === 'presets' && !showSettingsPage.value && !showThemeStudioPage.value)
      openSettingsPage('appearance')
    if (showSettingsPage.value) settingsInitialSection.value = 'appearance'
    openLayer('theme')
    themeStudioInitialDomain.value = initialDomain
  }
  function closeThemeStudioPage(): void {
    closeLayer('theme')
  }
  function openPlaybackSettings(): void {
    openSettingsPage('playback')
  }
  function openDspSettings(): void {
    openSettingsPage('dsp')
  }
  function openPluginPage(): void {
    openLayer('plugins')
  }
  function hidePluginPage(): void {
    closeLayer('plugins')
  }
  function openEqualizerPage(): void {
    openLayer('equalizer')
  }
  function closeEqualizerPage(): void {
    closeLayer('equalizer')
  }
  function openDspRackPage(): void {
    openLayer('dsp')
  }
  function closeDspRackPage(): void {
    closeLayer('dsp')
  }

  function openLibraryPlaylist(playlist: { id: string; name: string; kind?: 'aggregate' }): void {
    showPlayingPage.value = false
    showLoginPage.value = false
    showSettingsPage.value = false
    showThemeStudioPage.value = false
    showEqualizerPage.value = false
    showDspRackPage.value = false
    returnToLocalMode()
    onSelectView(
      playlist.kind === 'aggregate' ? 'aggregate' : 'playlists',
      playlist.kind === 'aggregate' ? playlist.id : `playlist:${playlist.name}`
    )
  }

  function closeMissingPluginPage(pages: UiContribution[]): void {
    const registered = (page: UiContribution) =>
      pages.some((item) => item.pluginId === page.pluginId && item.id === page.id)
    for (const entry of returnStack) {
      if (entry.state.plugin && !registered(entry.state.plugin)) entry.state.plugin = null
    }
    if (activePluginPage.value && !registered(activePluginPage.value)) closePluginPage()
  }
  function createToggleMenuHandler(): () => void {
    return () => {
      if (showLoginPage.value) return
      menuOpen.value = !menuOpen.value
    }
  }
  function createToggleSettingsHandler(): () => void {
    return () => {
      if (showSettingsPage.value) closeSettingsPage()
      else openSettingsPage()
    }
  }
  function createTogglePluginHandler(): () => void {
    return () => {
      if (showPluginPage.value) hidePluginPage()
      else openPluginPage()
    }
  }

  return {
    menuOpen,
    showPlayingPage,
    showStreamingPage,
    showRadioPodcastPage,
    showNetworkSourcesPage,
    showLoginPage,
    loginPageMode,
    loginInitialProviderId,
    showSettingsPage,
    showThemeStudioPage,
    themeStudioInitialDomain,
    showPluginPage,
    showEqualizerPage,
    showDspRackPage,
    activePluginPage: activePluginPage as Ref<UiContribution | null>,
    settingsInitialSection,
    settingsNavigationTarget,
    activeCategory,
    activeFilter,
    songlistTransitionName,
    streamingMenuOpen,
    localMenuOpenBeforeStreaming,
    showStreamingSurface,
    baseSurfaceVisible,
    localViewVisible,
    toggleStreamingMenu,
    collapseMenu,
    onSelectView,
    closePluginPage,
    onSelectPluginPage,
    openPlayingPage,
    closePlayingPage,
    enterStreamingMode,
    enterRadioPodcastMode,
    closeRadioPodcastPage,
    enterNetworkSourcesMode,
    closeNetworkSourcesPage,
    returnToLocalMode,
    openLoginPage,
    closeLoginPage,
    openSettingsPage,
    closeSettingsPage,
    openThemeStudioPage,
    closeThemeStudioPage,
    openPlaybackSettings,
    openDspSettings,
    openPluginPage,
    hidePluginPage,
    openEqualizerPage,
    closeEqualizerPage,
    openDspRackPage,
    closeDspRackPage,
    openLibraryPlaylist,
    closeMissingPluginPage,
    createToggleMenuHandler,
    createToggleSettingsHandler,
    createTogglePluginHandler
  }
}
