import {
  isThemeLibraryDocument,
  normalizeThemeLibraryDocument,
  type ThemeLibraryDocument
} from '../../shared/theme.ts'
import { parseJsonWithNestingLimit } from '../../shared/jsonSafety.ts'

export const SETTINGS_BACKUP_SCHEMA_VERSION = 2

export interface AppSettingsBackupImport<T extends object> {
  settings: T
  themeLibrary: ThemeLibraryDocument | null
}

export function exportAppSettingsForBackup<T extends object>(
  settings: T,
  themeLibrary?: ThemeLibraryDocument
): string {
  return JSON.stringify(
    themeLibrary
      ? {
          schemaVersion: SETTINGS_BACKUP_SCHEMA_VERSION,
          settings,
          themeLibrary
        }
      : settings,
    null,
    2
  )
}

export function importAppSettingsFromBackup<T extends object>(
  json: string,
  currentSettings: T,
  normalize: (settings: Partial<T>) => T
): T {
  return importAppSettingsBackup(json, currentSettings, normalize).settings
}

export function importAppSettingsBackup<T extends object>(
  json: string,
  currentSettings: T,
  normalize: (settings: Partial<T>) => T
): AppSettingsBackupImport<T> {
  let parsed: unknown
  try {
    parsed = parseJsonWithNestingLimit(json)
  } catch {
    throw new Error('Invalid settings backup JSON')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Settings backup must be a JSON object')
  }

  const record = parsed as Record<string, unknown>
  const isBundle = record.schemaVersion === SETTINGS_BACKUP_SCHEMA_VERSION && 'settings' in record
  const rawSettings = isBundle ? record.settings : parsed
  if (!rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) {
    throw new Error('Settings backup settings must be a JSON object')
  }

  let themeLibrary: ThemeLibraryDocument | null = null
  if (isBundle && record.themeLibrary !== undefined) {
    if (!isThemeLibraryDocument(record.themeLibrary)) {
      throw new Error('Settings backup theme library is invalid')
    }
    themeLibrary = normalizeThemeLibraryDocument(record.themeLibrary)
  }

  return {
    settings: normalize({
      ...currentSettings,
      ...(rawSettings as Partial<T>)
    }),
    themeLibrary
  }
}
