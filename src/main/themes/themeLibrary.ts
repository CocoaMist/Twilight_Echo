import { app } from 'electron'
import { join } from 'node:path'
import {
  createDefaultThemeLibraryDocument,
  type ThemeLibrarySnapshot,
  type ThemeLibraryDocument,
  type ThemeProfileV2,
  type ThemeSelection,
  type ThemeWindowInheritance
} from '../../shared/theme.ts'
import { runtime } from '../core/runtime.ts'
import { ThemeLibraryRepository } from './themeLibraryRepository.ts'
import { getCoreSettingsBridge, assertLegacySettingsWriter } from '../coreProcess/settingsBridge.ts'

let repository: ThemeLibraryRepository | null = null

function getRepository(): ThemeLibraryRepository {
  assertLegacySettingsWriter()
  if (!repository) {
    repository = new ThemeLibraryRepository(join(app.getPath('userData'), 'themes.json'), () =>
      createDefaultThemeLibraryDocument(
        runtime.appSettings.activeTheme,
        runtime.appSettings.themeWindowInheritance
      )
    )
  }
  return repository
}

export async function loadThemeLibrary(): Promise<ThemeLibrarySnapshot> {
  const core = getCoreSettingsBridge()
  if (core) return core.request('themes.list', {})
  return await getRepository().load()
}

export async function saveThemeProfile(
  candidate: ThemeProfileV2,
  expectedRevision: number,
  now = new Date().toISOString()
): Promise<ThemeLibrarySnapshot> {
  return await getRepository().saveProfile(candidate, expectedRevision, now)
}

export async function deleteThemeProfile(
  profileId: string,
  expectedRevision: number
): Promise<ThemeLibrarySnapshot> {
  return await getRepository().deleteProfile(profileId, expectedRevision)
}

export async function setActiveTheme(
  selection: ThemeSelection,
  expectedRevision: number
): Promise<ThemeLibrarySnapshot> {
  return await getRepository().setActive(selection, expectedRevision)
}

export async function setThemeWindowInheritance(
  inheritance: ThemeWindowInheritance,
  expectedRevision: number
): Promise<ThemeLibrarySnapshot> {
  return await getRepository().setWindowInheritance(inheritance, expectedRevision)
}

export async function replaceThemeLibrary(
  document: ThemeLibraryDocument,
  expectedRevision: number
): Promise<ThemeLibrarySnapshot> {
  return await getRepository().replaceDocument(document, expectedRevision)
}

export function resetThemeLibraryStoreForTests(): void {
  repository = null
}
