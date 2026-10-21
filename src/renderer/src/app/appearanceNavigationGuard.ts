import type { useAppNavigation } from './useAppNavigation.ts'

export interface AppearanceWorkspace {
  requestLeave: () => Promise<boolean>
}

/** Keep all routes that discard the retained appearance draft behind one guard. */
export function guardAppearanceNavigation(
  navigation: ReturnType<typeof useAppNavigation>,
  getWorkspace: () => AppearanceWorkspace | null
) {
  let leaving = false
  async function run(action: () => void): Promise<void> {
    const session = navigation.session.value
    if (session.overlay !== 'appearance' && !session.overlayHistory.includes('appearance')) {
      action()
      return
    }
    const workspace = getWorkspace()
    if (leaving || !workspace) return
    leaving = true
    try {
      if (!(await workspace.requestLeave())) return
      if (getWorkspace() !== workspace || navigation.session.value.overlay !== session.overlay)
        return
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
    onSelectView: guarded(navigation.onSelectView),
    onSelectPluginPage: guarded(navigation.onSelectPluginPage),
    closePluginPage: guarded(navigation.closePluginPage),
    enterStreamingMode: guarded(navigation.enterStreamingMode),
    returnToLocalMode: guarded(navigation.returnToLocalMode),
    enterRadioPodcastMode: guarded(navigation.enterRadioPodcastMode),
    closeRadioPodcastPage: guarded(navigation.closeRadioPodcastPage),
    enterNetworkSourcesMode: guarded(navigation.enterNetworkSourcesMode),
    closeNetworkSourcesPage: guarded(navigation.closeNetworkSourcesPage),
    openLibraryPlaylist: guarded(navigation.openLibraryPlaylist),
    createToggleMenuHandler: () => guarded(navigation.createToggleMenuHandler())
  }
}
