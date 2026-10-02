import type { SettingsSnapshot } from './appSettings.ts'
import type { ThemeBootstrap, ThemeTone } from './theme.ts'
import type { TrayNavigationTarget } from './trayPlayer.ts'

export type StartupSettingsSnapshot = SettingsSnapshot

export interface AppStartupSnapshot {
  settings: StartupSettingsSnapshot
  pendingNavigation: TrayNavigationTarget | null
  systemTone: ThemeTone
  themeBootstrap: ThemeBootstrap
}
