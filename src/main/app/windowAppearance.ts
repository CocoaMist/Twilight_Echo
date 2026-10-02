import type { AppSettings } from '../../shared/appSettings.ts'

type WindowAppearanceSettings = {
  theme: AppSettings['theme']
  appBackground: { global: { dark: string; light: string } }
}

export function getWindowBackgroundColor(
  settings: WindowAppearanceSettings,
  systemDark: boolean
): string {
  if (settings.theme === 'dark') return settings.appBackground.global.dark
  if (settings.theme === 'system' && systemDark) {
    return settings.appBackground.global.dark
  }
  return settings.appBackground.global.light
}
