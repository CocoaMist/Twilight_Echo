import { nativeTheme } from 'electron'
import { runtime } from '../core/runtime.ts'
import type { CoreSettingsState } from '../../shared/coreSettings.ts'
import { createSettingsSnapshot } from '../core/settings.ts'
import { getWindowBackgroundColor, syncWindowFrameAppearance } from '../app/windowAppearance.ts'
import { applyDiscordRpcSetting } from '../integrations/discord.ts'
import {
  applyMiniPlayerMotionPreferenceFromApp,
  applyMiniPlayerSettingsFromApp
} from '../integrations/miniPlayer.ts'
import { syncDesktopLyricsSettings } from '../integrations/desktopLyrics.ts'
import {
  applyAutoLaunch,
  registerPlayerShortcuts,
  syncTrayState
} from '../integrations/shortcutsTray.ts'

/** Main applies OS/window preferences only. No persistence, audio or library work. */
export function projectCoreSettings(state: CoreSettingsState): void {
  const previous = runtime.appSettings
  const next = structuredClone(state.settings)
  const changed = (...keys: (keyof typeof next)[]) =>
    keys.some((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]))
  runtime.appSettings = next
  if (changed('theme', 'appBackground')) {
    if (runtime.mainWindow) {
      syncWindowFrameAppearance(runtime.mainWindow, nativeTheme.shouldUseHighContrastColors)
      if (!next.windowTransparency)
        runtime.mainWindow.setBackgroundColor(
          getWindowBackgroundColor(next, nativeTheme.shouldUseDarkColors)
        )
    }
  }
  if (changed('launchAtLogin')) applyAutoLaunch(next.launchAtLogin)
  if (changed('discordRpcEnabled')) applyDiscordRpcSetting(next.discordRpcEnabled)
  if (changed('taskbarThumbarButtonsEnabled')) runtime.refreshTaskbarThumbarButtons?.()
  if (changed('smtcEnabled')) runtime.refreshWindowsSmtc?.()
  if (
    changed('desktopLyrics', 'lyricsAppearance', 'motionPreference') &&
    runtime.desktopLyricsWindow &&
    !runtime.desktopLyricsWindow.isDestroyed()
  )
    syncDesktopLyricsSettings()
  if (changed('miniPlayer')) applyMiniPlayerSettingsFromApp(next.miniPlayer)
  if (changed('motionPreference')) applyMiniPlayerMotionPreferenceFromApp(next.motionPreference)
  if (changed('globalShortcuts', 'shortcutEnabled', 'globalShortcutBindings'))
    registerPlayerShortcuts()
  if (changed('closeWindowBehavior', 'minimizeToTray')) syncTrayState()
  const snapshot = createSettingsSnapshot(next, runtime.launchSettings)
  for (const window of [runtime.mainWindow, runtime.trayPlayerWindow])
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send('settings:changed', snapshot)
}
