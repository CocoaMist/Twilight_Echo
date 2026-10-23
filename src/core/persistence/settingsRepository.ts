import type { AppSettings } from '../../shared/appSettings.ts'
import {
  createDefaultSettings,
  normalizeAppSettings,
  type SettingsEnvironment
} from '../settings/normalization.ts'
import { loadSettingsFile, writeSettingsFile, type SettingsFileLoadIssue } from './settingsFile.ts'

/** The existing flat settings.json, with synchronous atomic commits for audio transactions. */
export class CoreSettingsRepository {
  private value: AppSettings
  private revision = 0
  private readonly options: {
    filePath: string
    environment: SettingsEnvironment
    initial?: Partial<AppSettings>
    changed(patch: Partial<AppSettings>): void
  }
  readonly issue: SettingsFileLoadIssue | null
  constructor(options: CoreSettingsRepository['options']) {
    this.options = options
    const result = loadSettingsFile(
      options.filePath,
      { ...createDefaultSettings(options.environment.platform), ...options.initial },
      (settings) => normalizeAppSettings(settings, options.environment)
    )
    this.value = result.settings
    this.issue = result.issue
  }
  read(): AppSettings {
    return structuredClone(this.value)
  }
  getRevision(): number {
    return this.revision
  }
  normalize(patch: Partial<AppSettings>): AppSettings {
    const aliases: Partial<AppSettings> = {}
    if (Object.hasOwn(patch, 'musicCachePath') && !Object.hasOwn(patch, 'cachePath'))
      aliases.cachePath = patch.musicCachePath
    if (Object.hasOwn(patch, 'autoLaunch') && !Object.hasOwn(patch, 'launchAtLogin'))
      aliases.launchAtLogin = patch.autoLaunch
    if (Object.hasOwn(patch, 'closeToTray') && !Object.hasOwn(patch, 'closeWindowBehavior'))
      aliases.closeWindowBehavior = patch.closeToTray ? 'tray' : 'quit'
    return normalizeAppSettings({ ...this.value, ...patch, ...aliases }, this.options.environment)
  }
  update(patch: Partial<AppSettings>): AppSettings {
    const next = this.normalize(patch)
    writeSettingsFile(this.options.filePath, next)
    this.value = next
    this.revision++
    this.options.changed(patch)
    return this.read()
  }
}
