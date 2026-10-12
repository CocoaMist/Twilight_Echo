import type { AppSettings } from '../../shared/appSettings.ts'
import type { BrowserWindow } from 'electron'

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

/** Keep the Windows frame on the same surface as the frameless caption. */
export function syncWindowFrameColor(
  win: Pick<BrowserWindow, 'setAccentColor'>,
  settings: WindowAppearanceSettings,
  systemDark: boolean,
  highContrast: boolean
): void {
  if (process.platform !== 'win32') return
  win.setAccentColor(highContrast ? null : getWindowBackgroundColor(settings, systemDark))
}
