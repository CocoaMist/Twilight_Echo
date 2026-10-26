import {
  MAX_USER_THEME_PROFILES,
  TWILIGHT_DEFAULT_THEME_ID,
  isBuiltInThemePresetId,
  isThemeLibraryDocument,
  limitThemeProfileHistory,
  normalizeThemeLibraryDocument,
  normalizeThemeProfile,
  themeProfilesHaveSameEditableState,
  type ThemeLibraryDocument,
  type ThemeLibrarySnapshot,
  type ThemeProfileV2,
  type ThemeSelection,
  type ThemeWindowInheritance
} from '../../shared/theme.ts'
import { VersionedDataStore } from './versionedDataStore.ts'

const MAX_THEME_LIBRARY_BYTES = 2 * 1024 * 1024

export class ThemeLibraryRepository {
  private readonly store: VersionedDataStore<ThemeLibraryDocument>
  private readonly initialDocument: () => ThemeLibraryDocument

  constructor(filePath: string, initialDocument: () => ThemeLibraryDocument) {
    this.initialDocument = initialDocument
    this.store = new VersionedDataStore<ThemeLibraryDocument>({
      filePath,
      label: 'theme library',
      maxBytes: MAX_THEME_LIBRARY_BYTES,
      isData: isThemeLibraryDocument,
      isLegacy: isThemeLibraryDocument
    })
  }

  async load(): Promise<ThemeLibrarySnapshot> {
    const current = await this.store.load()
    if (current) return { ...current, data: normalizeThemeLibraryDocument(current.data) }
    return {
      version: 2,
      revision: 0,
      savedAt: new Date(0).toISOString(),
      data: this.initialDocument()
    }
  }

  async saveProfile(
    candidate: ThemeProfileV2,
    expectedRevision: number,
    now = new Date().toISOString()
  ): Promise<ThemeLibrarySnapshot> {
    const normalized = normalizeThemeProfile(candidate)
    if (!normalized) throw new Error('主题档案无效')
    const current = await this.load()
    const existing = current.data.profiles.find((profile) => profile.id === normalized.id)
    if (!existing && current.data.profiles.length >= MAX_USER_THEME_PROFILES) {
      throw new Error(`最多只能保存 ${MAX_USER_THEME_PROFILES} 个用户主题`)
    }
    const profile: ThemeProfileV2 = {
      ...normalized,
      createdAt:
        existing?.createdAt ??
        (normalized.createdAt === new Date(0).toISOString() ? now : normalized.createdAt),
      updatedAt: now
    }
    const previousHistory = current.data.profileHistory[profile.id] ?? []
    const profileHistory = {
      ...current.data.profileHistory,
      ...(existing && !themeProfilesHaveSameEditableState(existing, profile)
        ? {
            [profile.id]: limitThemeProfileHistory([
              { savedAt: now, profile: existing },
              ...previousHistory
            ])
          }
        : previousHistory.length > 0
          ? { [profile.id]: previousHistory }
          : {})
    }
    const profiles = existing
      ? current.data.profiles.map((entry) => (entry.id === profile.id ? profile : entry))
      : [...current.data.profiles, profile]
    return await this.store.save({ ...current.data, profiles, profileHistory }, expectedRevision)
  }

  async deleteProfile(profileId: string, expectedRevision: number): Promise<ThemeLibrarySnapshot> {
    if (profileId === TWILIGHT_DEFAULT_THEME_ID) throw new Error('默认主题不能删除')
    if (isBuiltInThemePresetId(profileId)) throw new Error('内置主题不能删除')
    const current = await this.load()
    const profiles = current.data.profiles.filter((profile) => profile.id !== profileId)
    if (profiles.length === current.data.profiles.length) throw new Error('主题档案不存在')
    const profileHistory = { ...current.data.profileHistory }
    delete profileHistory[profileId]
    const activeTheme =
      current.data.activeTheme.kind === 'user' && current.data.activeTheme.id === profileId
        ? ({ kind: 'builtin', id: TWILIGHT_DEFAULT_THEME_ID } as const)
        : current.data.activeTheme
    return await this.store.save(
      { ...current.data, profiles, activeTheme, profileHistory },
      expectedRevision
    )
  }

  async setActive(
    selection: ThemeSelection,
    expectedRevision: number
  ): Promise<ThemeLibrarySnapshot> {
    const current = await this.load()
    if (selection.kind === 'builtin' && !isBuiltInThemePresetId(selection.id)) {
      throw new Error('未知内置主题')
    }
    if (
      selection.kind === 'user' &&
      !current.data.profiles.some((profile) => profile.id === selection.id)
    ) {
      throw new Error('主题档案不存在')
    }
    if (selection.kind === 'plugin' && (!selection.pluginId.trim() || !selection.themeId.trim())) {
      throw new Error('插件主题标识无效')
    }
    return await this.store.save({ ...current.data, activeTheme: selection }, expectedRevision)
  }

  async setWindowInheritance(
    inheritance: ThemeWindowInheritance,
    expectedRevision: number
  ): Promise<ThemeLibrarySnapshot> {
    const current = await this.load()
    return await this.store.save(
      {
        ...current.data,
        windowInheritance: {
          miniPlayer: inheritance.miniPlayer !== false,
          desktopLyrics: inheritance.desktopLyrics !== false
        }
      },
      expectedRevision
    )
  }

  async replaceDocument(
    candidate: ThemeLibraryDocument,
    expectedRevision: number
  ): Promise<ThemeLibrarySnapshot> {
    if (!isThemeLibraryDocument(candidate)) throw new Error('主题库备份无效')
    return await this.store.save(normalizeThemeLibraryDocument(candidate), expectedRevision)
  }
}
