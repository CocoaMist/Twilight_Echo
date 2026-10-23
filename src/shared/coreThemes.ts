import type {
  ThemeAssetReference,
  ThemeAssetType,
  ThemeLibrarySnapshot,
  ThemeProfileV2,
  ThemeSelection,
  ThemeWindowInheritance,
  ThemeBootstrap
} from './theme.ts'
import type { PersistentDataRevisionConflictResponse } from './versionedPersistence.ts'
import type { ThemeLibraryDocument } from './theme.ts'

export type CoreThemeMutationResult =
  | ThemeLibrarySnapshot
  | PersistentDataRevisionConflictResponse<ThemeLibraryDocument>
export type CoreThemeEdit = { revision: number } & (
  | { kind: 'save'; profile: ThemeProfileV2 }
  | { kind: 'remove'; id: string }
  | { kind: 'active'; selection: ThemeSelection }
  | { kind: 'inheritance'; inheritance: ThemeWindowInheritance }
)
export interface CoreThemeOperations {
  'themes.list': { input: Record<string, never>; output: ThemeLibrarySnapshot }
  'themes.bootstrap': { input: Record<string, never>; output: ThemeBootstrap }
  'themes.edit': { input: CoreThemeEdit; output: CoreThemeMutationResult }
  'themes.import': { input: { revision: number }; output: CoreThemeMutationResult | null }
  'themes.export': { input: { id: string }; output: string | null }
  'themes.importAsset': {
    input: { id: string; type: ThemeAssetType }
    output: ThemeAssetReference | null
  }
  'themes.validateAssets': { input: { id: string; assets: ThemeAssetReference[] }; output: boolean }
  'themes.copyAssets': { input: { sourceId: string; targetId: string }; output: void }
  'themes.reconcile': { input: Record<string, never>; output: void }
}

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((key) => allowed.includes(key))
const id = (v: unknown) =>
  typeof v === 'string' && v.length > 0 && v.length <= 160 && !v.includes('\0')
const revision = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
export function validCoreThemePayload(name: string, p: Record<string, unknown>): boolean {
  if (name === 'themes.list' || name === 'themes.bootstrap' || name === 'themes.reconcile')
    return keys(p, [])
  if (name === 'themes.import') return keys(p, ['revision']) && revision(p.revision)
  if (name === 'themes.export') return keys(p, ['id']) && id(p.id)
  if (name === 'themes.importAsset')
    return keys(p, ['id', 'type']) && id(p.id) && (p.type === 'font' || p.type === 'image')
  if (name === 'themes.validateAssets')
    return (
      keys(p, ['id', 'assets']) &&
      id(p.id) &&
      Array.isArray(p.assets) &&
      p.assets.length <= 128 &&
      p.assets.every(record)
    )
  if (name === 'themes.copyAssets')
    return keys(p, ['sourceId', 'targetId']) && id(p.sourceId) && id(p.targetId)
  if (name !== 'themes.edit' || !revision(p.revision)) return false
  switch (p.kind) {
    case 'save':
      return keys(p, ['revision', 'kind', 'profile']) && record(p.profile)
    case 'remove':
      return keys(p, ['revision', 'kind', 'id']) && id(p.id)
    case 'active':
      if (!keys(p, ['revision', 'kind', 'selection']) || !record(p.selection)) return false
      return p.selection.kind === 'plugin'
        ? keys(p.selection, ['kind', 'pluginId', 'themeId']) &&
            id(p.selection.pluginId) &&
            id(p.selection.themeId)
        : (p.selection.kind === 'user' || p.selection.kind === 'builtin') &&
            keys(p.selection, ['kind', 'id']) &&
            id(p.selection.id)
    case 'inheritance':
      return (
        keys(p, ['revision', 'kind', 'inheritance']) &&
        record(p.inheritance) &&
        keys(p.inheritance, ['miniPlayer', 'desktopLyrics']) &&
        typeof p.inheritance.miniPlayer === 'boolean' &&
        typeof p.inheritance.desktopLyrics === 'boolean'
      )
    default:
      return false
  }
}
