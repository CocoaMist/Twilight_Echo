import type { AppSettings } from '../../shared/appSettings.ts'
import type { CoreSettingsPatch } from '../../shared/coreSettings.ts'
import type { CoreThemeEdit, CoreThemeMutationResult } from '../../shared/coreThemes.ts'
import {
  PersistentDataRevisionConflictError,
  createPersistentDataRevisionConflictResponse
} from '../../shared/versionedPersistence.ts'
import {
  TWILIGHT_DEFAULT_THEME,
  TWILIGHT_DEFAULT_THEME_ID,
  normalizeThemeProfile,
  type ThemeAssetReference,
  type ThemeAssetType,
  type ThemeLibraryDocument,
  type ThemeLibrarySnapshot,
  type ThemeProfileV2,
  type ThemeWindowDefaults
} from '../../shared/theme.ts'
import type { ThemeLibraryRepository } from '../persistence/themeLibraryRepository.ts'
import {
  createInheritedThemeSettingsPatch,
  createThemePlayerBarSettingsPatch
} from './windowInheritance.ts'

export interface CoreThemePlatform {
  validateAssets(id: string, assets: ThemeAssetReference[], signal?: AbortSignal): Promise<boolean>
  deleteAssets(id: string): Promise<void>
  importArchive(signal?: AbortSignal): Promise<ThemeProfileV2 | null>
  exportArchive(profile: ThemeProfileV2, signal?: AbortSignal): Promise<string | null>
  importAsset(
    id: string,
    type: ThemeAssetType,
    signal?: AbortSignal
  ): Promise<ThemeAssetReference | null>
  copyAssets(sourceId: string, targetId: string): Promise<void>
}

interface Options {
  repository: ThemeLibraryRepository
  settings(): AppSettings
  updateSettings(patch: CoreSettingsPatch): Promise<unknown>
  platform: CoreThemePlatform
  pluginTheme(
    pluginId: string,
    themeId: string
  ): Promise<{ windowDefaults?: ThemeWindowDefaults } | null>
  changed(snapshot: ThemeLibrarySnapshot): void
  now(): string
}

/** One owner for themes.json and its settings projection; asset IO remains a platform capability. */
export class CoreThemeService {
  private pending: Promise<unknown> = Promise.resolve()
  private readonly options: Options
  constructor(options: Options) {
    this.options = options
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const work = this.pending.then(action)
    this.pending = work.catch(() => {})
    return work
  }
  list(): Promise<ThemeLibrarySnapshot> {
    return this.enqueue(() => this.options.repository.load())
  }
  load(): Promise<ThemeLibrarySnapshot> {
    return this.list()
  }
  /** Settings backup uses the same theme mutation lane and original revision fence. */
  replaceDocument(document: ThemeLibraryDocument, revision: number): Promise<ThemeLibrarySnapshot> {
    return this.enqueue(async () => {
      const snapshot = await this.options.repository.replaceDocument(document, revision)
      this.options.changed(snapshot)
      return snapshot
    })
  }
  bootstrap(): Promise<{
    library: ThemeLibrarySnapshot
    defaultTheme: typeof TWILIGHT_DEFAULT_THEME
  }> {
    return this.enqueue(async () => {
      const library = await this.options.repository.load()
      const patch = createThemePlayerBarSettingsPatch(library, this.options.settings())
      if (patch.playerBar) await this.options.updateSettings(patch)
      return { library, defaultTheme: TWILIGHT_DEFAULT_THEME }
    })
  }
  private async synchronize(snapshot: ThemeLibrarySnapshot): Promise<void> {
    const activeTheme = snapshot.data.activeTheme
    await this.options.updateSettings({
      activeTheme,
      pluginThemeId:
        activeTheme.kind === 'plugin' ? `${activeTheme.pluginId}:${activeTheme.themeId}` : null,
      themeWindowInheritance: snapshot.data.windowInheritance,
      ...(await createInheritedThemeSettingsPatch(
        snapshot,
        this.options.settings(),
        async (pluginId, themeId) =>
          (await this.options.pluginTheme(pluginId, themeId))?.windowDefaults
      ))
    })
  }
  private async validate(profile: ThemeProfileV2, signal?: AbortSignal): Promise<void> {
    const bound = new Set(
      Object.values(profile.assetBindings ?? {}).filter(
        (value): value is string => typeof value === 'string'
      )
    )
    if (!bound.size) return
    const assets = (profile.assets ?? []).filter((asset) => bound.has(asset.id))
    if (
      assets.length !== bound.size ||
      !(await this.options.platform.validateAssets(profile.id, assets, signal))
    )
      throw new Error('主题绑定的本地资源不可用')
  }
  private async mutation(
    action: () => Promise<ThemeLibrarySnapshot>,
    synchronize: boolean
  ): Promise<CoreThemeMutationResult> {
    try {
      const snapshot = await action()
      if (synchronize) await this.synchronize(snapshot)
      this.options.changed(snapshot)
      return snapshot
    } catch (error) {
      if (error instanceof PersistentDataRevisionConflictError)
        return createPersistentDataRevisionConflictResponse(error)
      throw error
    }
  }
  edit(request: CoreThemeEdit, signal: AbortSignal): Promise<CoreThemeMutationResult> {
    return this.enqueue(async () => {
      signal.throwIfAborted()
      const repository = this.options.repository
      switch (request.kind) {
        case 'save': {
          const profile = normalizeThemeProfile(request.profile)
          if (!profile) throw new Error('主题档案无效')
          await this.validate(profile, signal)
          signal.throwIfAborted()
          return this.mutation(
            () => repository.saveProfile(profile, request.revision, this.options.now()),
            false
          )
        }
        case 'remove': {
          const result = await this.mutation(
            () => repository.deleteProfile(request.id, request.revision),
            true
          )
          if ('data' in result) await this.options.platform.deleteAssets(request.id)
          return result
        }
        case 'active':
          return this.mutation(
            () => repository.setActive(request.selection, request.revision),
            true
          )
        case 'inheritance':
          return this.mutation(
            () => repository.setWindowInheritance(request.inheritance, request.revision),
            true
          )
      }
    })
  }
  import(revision: number, signal: AbortSignal): Promise<CoreThemeMutationResult | null> {
    return this.enqueue(async () => {
      const profile = await this.options.platform.importArchive(signal)
      if (!profile) return null
      try {
        await this.validate(profile, signal)
        signal.throwIfAborted()
      } catch (error) {
        await this.options.platform.deleteAssets(profile.id)
        throw error
      }
      const result = await this.mutation(
        () => this.options.repository.saveProfile(profile, revision, this.options.now()),
        false
      )
      if (!('data' in result)) await this.options.platform.deleteAssets(profile.id)
      return result
    })
  }
  export(id: string, signal: AbortSignal): Promise<string | null> {
    return this.enqueue(async () => {
      const library = await this.options.repository.load()
      const profile = library.data.profiles.find((entry) => entry.id === id)
      if (!profile) throw new Error('主题档案不存在')
      return this.options.platform.exportArchive(profile, signal)
    })
  }
  importAsset(id: string, type: ThemeAssetType, signal: AbortSignal) {
    return this.options.platform.importAsset(id, type, signal)
  }
  validateAssets(id: string, assets: ThemeAssetReference[], signal: AbortSignal) {
    return this.options.platform.validateAssets(id, assets, signal)
  }
  copyAssets(sourceId: string, targetId: string) {
    return this.options.platform.copyAssets(sourceId, targetId)
  }
  reconcile(): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.options.repository.load()
      const active = current.data.activeTheme
      if (
        active.kind !== 'plugin' ||
        (await this.options.pluginTheme(active.pluginId, active.themeId))
      )
        return
      await this.mutation(
        () =>
          this.options.repository.setActive(
            { kind: 'builtin', id: TWILIGHT_DEFAULT_THEME_ID },
            current.revision
          ),
        true
      )
    })
  }
  async shutdown(): Promise<void> {
    await this.pending
  }
}
