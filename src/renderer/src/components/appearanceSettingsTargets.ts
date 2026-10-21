import type { AppearancePart } from './appearanceParts'
import { settingsDisclosurePath, type SettingsSearchEntry } from './settings-page/types.ts'
import type { ThemeStudioDomain } from './theme-studio/useThemeStudioEditor'

export type AppearanceSettingsPanel =
  | 'appearance-theme'
  | 'appearance-surfaces'
  | 'global-font'
  | 'player-bar'
  | 'outer-panel'
  | 'controls'
  | 'navigation'
  | 'material'
  | 'card'
  | 'general'

export const APPEARANCE_STUDIO_PARTS: Record<ThemeStudioDomain, AppearancePart> = {
  presets: 'appearance-theme',
  personalization: 'appearance-theme',
  shell: 'controls',
  navigation: 'navigation',
  library: 'card',
  typography: 'global-font',
  player: 'player-bar',
  windows: 'player-bar',
  motion: 'overview',
  advanced: 'controls'
}

interface AppearanceSettingsDestination {
  part: AppearancePart
  panel?: AppearanceSettingsPanel
  area?: 'background' | 'material' | 'advanced'
  settingId?: string
  fallbackId?: string
  disclosures?: readonly string[]
}

const propertyTargets: Record<string, { settingId: string; group: 'card' | 'glass' }> = {
  'appearance-editor-84': { settingId: 'card-appearance', group: 'card' },
  'appearance-editor-85': { settingId: 'card-enabled', group: 'card' },
  'appearance-editor-86': { settingId: 'card-blur', group: 'card' },
  'appearance-editor-87': { settingId: 'card-saturation', group: 'card' },
  'appearance-editor-88': { settingId: 'card-color', group: 'card' },
  'appearance-editor-89': { settingId: 'card-border', group: 'card' },
  'appearance-editor-90': { settingId: 'card-radius', group: 'card' },
  'appearance-editor-91': { settingId: 'card-shadow', group: 'card' },
  'appearance-editor-92': { settingId: 'card-hover', group: 'card' },
  'appearance-editor-93': { settingId: 'card-highlight', group: 'card' },
  'appearance-editor-105': { settingId: 'liquid-glass', group: 'glass' },
  'appearance-editor-106': { settingId: 'glass-enabled', group: 'glass' },
  'appearance-editor-107': { settingId: 'glass-pointer', group: 'glass' }
}

export function appearanceSettingsTarget(
  entry: SettingsSearchEntry
): AppearanceSettingsDestination {
  const id = entry.id ?? entry.fallbackId ?? ''
  const property = propertyTargets[id]
  if (property) {
    const glass = property.group === 'glass'
    return {
      part: glass ? 'controls' : 'card',
      panel: glass ? 'appearance-surfaces' : 'card',
      settingId: property.settingId,
      fallbackId: glass ? 'glass-enabled' : 'card-enabled',
      disclosures: glass ? ['workspace-liquid-glass', 'liquid-glass'] : ['card-appearance']
    }
  }
  if (entry.appearanceArea) {
    if (entry.appearanceArea === 'material')
      return { part: 'controls', panel: 'appearance-surfaces' }
    if (entry.appearanceArea === 'advanced') return { part: 'card', panel: 'card' }
    return {
      part: 'inner-panel',
      area: ['appearance-editor-75', 'appearance-editor-96'].includes(id)
        ? 'advanced'
        : entry.appearanceArea,
      settingId: (
        {
          'appearance-editor-74': 'background-text-tone',
          'appearance-editor-75': 'workspace-scale',
          'appearance-editor-76': 'background-target',
          'appearance-editor-77': 'background-target',
          'appearance-editor-94': 'workspace-blur',
          'appearance-editor-95': 'workspace-blur',
          'appearance-editor-96': 'workspace-brightness',
          'appearance-editor-97': 'workspace-dim'
        } as Record<string, string>
      )[id]
    }
  }
  if (id.startsWith('window-'))
    return { part: 'outer-panel', panel: 'outer-panel', fallbackId: 'window-transparency' }
  if (id.startsWith('mini-'))
    return {
      part: 'player-bar',
      panel: 'player-bar',
      disclosures: ['workspace-mini-player', 'mini-player']
    }
  if (id.startsWith('player-') || id === 'compact-visualizer')
    return {
      part: 'player-bar',
      panel: 'player-bar',
      disclosures: [
        'player-bar',
        ...settingsDisclosurePath(entry).filter((id) => id !== 'player-bar')
      ]
    }
  if (id === 'global-font' || id === 'font-rendering')
    return { part: 'global-font', panel: 'global-font' }
  if (['ui-density', 'motion', 'startup-experience'].includes(id))
    return { part: 'overview', panel: 'general' }
  if (id === 'appearance-surfaces') return { part: 'controls', panel: 'appearance-surfaces' }
  return { part: 'appearance-theme', panel: 'appearance-theme' }
}

export function appearancePartPanel(part: AppearancePart): AppearanceSettingsPanel | undefined {
  if (part === 'overview') return 'general'
  if (part === 'background' || part === 'inner-panel') return undefined
  return part
}
