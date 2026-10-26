import type { AppSettings } from '../../shared/appSettings.ts'
import type { CoreSettingsState } from '../../shared/coreSettings.ts'
import {
  MAX_SETTINGS_BACKUP_BYTES,
  type CoreSettingsBackupImport
} from '../../shared/coreSettingsBackup.ts'
import {
  TWILIGHT_DEFAULT_THEME_ID,
  type ThemeAssetReference,
  type ThemeLibraryDocument,
  type ThemeLibrarySnapshot,
  type ThemeWindowDefaults
} from '../../shared/theme.ts'
import type { ThemeLibraryRepository } from '../persistence/themeLibraryRepository.ts'
import type { CoreSettingsService } from './service.ts'
import { exportAppSettingsForBackup, importAppSettingsBackup } from './backupFormat.ts'
import { createInheritedThemeSettingsPatch } from './windowInheritance.ts'

interface Options {
  settings: Pick<CoreSettingsService, 'state' | 'restore' | 'flush'>
  normalize(settings: Partial<AppSettings>): AppSettings
  themes: Pick<ThemeLibraryRepository, 'load' | 'replaceDocument'>
  validateThemeAssets(
    id: string,
    assets: ThemeAssetReference[],
    signal: AbortSignal
  ): Promise<boolean>
  pluginTheme(
    pluginId: string,
    themeId: string
  ): Promise<{ windowDefaults?: ThemeWindowDefaults } | null>
  themesChanged(snapshot: ThemeLibrarySnapshot): void
}

/** The old flat/v2 backup format; neither browser storage nor credential repositories participate. */
export class CoreSettingsBackupService {
  private readonly options: Options
  private pending: Promise<unknown> = Promise.resolve()
  constructor(options: Options) {
    this.options = options
  }

  export(): Promise<string> {
    const work = this.pending.then(async () => {
      await this.options.settings.flush()
      const theme = await this.options.themes.load()
      return exportAppSettingsForBackup(this.options.settings.state().settings, theme.data)
    })
    this.pending = work.catch(() => {})
    return work
  }

  import(request: CoreSettingsBackupImport, signal: AbortSignal): Promise<CoreSettingsState> {
    const work = this.pending.then(async () => {
      signal.throwIfAborted()
      if (new TextEncoder().encode(request.json).byteLength > MAX_SETTINGS_BACKUP_BYTES)
        throw new Error('Settings backup is too large')
      const current = this.options.settings.state()
      if (request.revision !== current.revision)
        throw Object.assign(new Error('Settings changed; read their current revision'), {
          code: 'STALE_REVISION'
        })
      const imported = importAppSettingsBackup(
        request.json,
        current.settings,
        this.options.normalize
      )
      const theme = imported.themeLibrary
        ? await this.prepareTheme(imported.themeLibrary, signal)
        : null
      const currentThemes = theme ? await this.options.themes.load() : null
      let next = imported.settings
      if (theme) {
        const snapshot = { ...currentThemes!, data: theme }
        next = this.options.normalize({
          ...next,
          activeTheme: theme.activeTheme,
          pluginThemeId:
            theme.activeTheme.kind === 'plugin'
              ? `${theme.activeTheme.pluginId}:${theme.activeTheme.themeId}`
              : null,
          themeWindowInheritance: theme.windowInheritance,
          ...(await createInheritedThemeSettingsPatch(
            snapshot,
            next,
            async (pluginId, themeId) =>
              (await this.options.pluginTheme(pluginId, themeId))?.windowDefaults
          ))
        })
      }
      const restored = await this.options.settings.restore(request.revision, next, signal)
      // Match the existing two-file contract: settings ACK first, then the versioned theme file.
      if (theme) {
        const snapshot = await this.options.themes.replaceDocument(theme, currentThemes!.revision)
        this.options.themesChanged(snapshot)
      }
      return restored
    })
    this.pending = work.catch(() => {})
    return work
  }

  private async prepareTheme(
    candidate: ThemeLibraryDocument,
    signal: AbortSignal
  ): Promise<ThemeLibraryDocument> {
    const active = candidate.activeTheme
    let available = true
    if (active.kind === 'user') {
      const profile = candidate.profiles.find((entry) => entry.id === active.id)
      const bound = new Set(
        Object.values(profile?.assetBindings ?? {}).filter(
          (id): id is string => typeof id === 'string'
        )
      )
      if (bound.size) {
        const assets = (profile?.assets ?? []).filter((asset) => bound.has(asset.id))
        available =
          assets.length === bound.size &&
          (await this.options.validateThemeAssets(active.id, assets, signal))
      }
    } else if (active.kind === 'plugin') {
      available = !!(await this.options.pluginTheme(active.pluginId, active.themeId))
    }
    signal.throwIfAborted()
    return available
      ? candidate
      : { ...candidate, activeTheme: { kind: 'builtin', id: TWILIGHT_DEFAULT_THEME_ID } }
  }

  async shutdown(): Promise<void> {
    await this.pending
  }
}
