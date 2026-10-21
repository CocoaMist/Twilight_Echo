import type { useAppNavigation } from './useAppNavigation.ts'
export interface DspWorkspace {
  requestLeave: () => Promise<boolean>
}

/** Preserve the existing overlay/history contract while protecting its DSP writer. */
export function guardDspNavigation(
  navigation: ReturnType<typeof useAppNavigation>,
  getWorkspace: () => DspWorkspace | null
) {
  let leaving = false
  async function run(action: () => void): Promise<void> {
    const session = navigation.session.value
    if (
      ![session.overlay, ...session.overlayHistory].some(
        (overlay) => overlay === 'equalizer' || overlay === 'dsp'
      )
    ) {
      action()
      return
    }
    const workspace = getWorkspace()
    if (!workspace) {
      action()
      return
    }
    if (leaving) return
    leaving = true
    try {
      if (
        (await workspace.requestLeave()) &&
        getWorkspace() === workspace &&
        navigation.session.value.overlay === session.overlay
      )
        action()
    } finally {
      leaving = false
    }
  }
  const guarded =
    <Args extends unknown[]>(action: (...args: Args) => void) =>
    (...args: Args): void => {
      void run(() => action(...args))
    }
  return {
    ...navigation,
    navigate: guarded(navigation.navigate),
    selectSidebarPage: guarded(navigation.selectSidebarPage),
    goBackPage: guarded(navigation.goBackPage),
    goForwardPage: (): boolean => {
      if (!navigation.canGoForwardPage.value) return false
      void run(() => {
        navigation.goForwardPage()
      })
      return true
    },
    onSelectView: guarded(navigation.onSelectView),
    onSelectPluginPage: guarded(navigation.onSelectPluginPage),
    openPlayingPage: guarded(navigation.openPlayingPage),
    closePlayingPage: guarded(navigation.closePlayingPage),
    openSettingsPage: guarded(navigation.openSettingsPage),
    closeSettingsPage: guarded(navigation.closeSettingsPage),
    openAppearancePage: guarded(navigation.openAppearancePage),
    openThemeStudioPage: guarded(navigation.openThemeStudioPage),
    openPluginPage: guarded(navigation.openPluginPage),
    hidePluginPage: guarded(navigation.hidePluginPage),
    closePluginPage: guarded(navigation.closePluginPage),
    openEqualizerPage: guarded(navigation.openEqualizerPage),
    closeEqualizerPage: guarded(navigation.closeEqualizerPage),
    openDspRackPage: guarded(navigation.openDspRackPage),
    closeDspRackPage: guarded(navigation.closeDspRackPage),
    openLoginPage: guarded(navigation.openLoginPage),
    closeLoginPage: guarded(navigation.closeLoginPage),
    enterStreamingMode: guarded(navigation.enterStreamingMode),
    returnToLocalMode: guarded(navigation.returnToLocalMode),
    enterRadioPodcastMode: guarded(navigation.enterRadioPodcastMode),
    closeRadioPodcastPage: guarded(navigation.closeRadioPodcastPage),
    enterNetworkSourcesMode: guarded(navigation.enterNetworkSourcesMode),
    closeNetworkSourcesPage: guarded(navigation.closeNetworkSourcesPage),
    openLibraryPlaylist: guarded(navigation.openLibraryPlaylist),
    openDspSettings: guarded(navigation.openDspSettings),
    openPlaybackSettings: guarded(navigation.openPlaybackSettings),
    createToggleMenuHandler: () => guarded(navigation.createToggleMenuHandler()),
    createToggleSettingsHandler: () => guarded(navigation.createToggleSettingsHandler()),
    createTogglePluginHandler: () => guarded(navigation.createTogglePluginHandler())
  }
}
