import type { AppSettings } from '../../shared/appSettings.ts'
import type { ThemeLibrarySnapshot } from '../../shared/theme.ts'
import {
  createInheritedThemeSettingsPatch as createInheritedPatch,
  createThemePlayerBarSettingsPatch as createPlayerBarPatch
} from '../../core/settings/windowInheritance.ts'
import { runtime } from '../core/runtime.ts'

export function createThemePlayerBarSettingsPatch(
  snapshot: ThemeLibrarySnapshot
): Partial<AppSettings> {
  return createPlayerBarPatch(snapshot, runtime.appSettings)
}

export function createInheritedThemeSettingsPatch(
  snapshot: ThemeLibrarySnapshot
): Promise<Partial<AppSettings>> {
  return createInheritedPatch(snapshot, runtime.appSettings, async (pluginId, themeId) => {
    await runtime.pluginManagerReady
    const extensions = (await runtime.pluginManager?.listExtensions()) ?? []
    return extensions
      .find((entry) => entry.pluginId === pluginId)
      ?.themes.find((theme) => theme.id === themeId)?.structured?.windowDefaults
  })
}
