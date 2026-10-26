import {
  DEFAULT_LYRICS_APPEARANCE,
  cloneLyricsAppearance,
  normalizeLyricsAppearance,
  type LyricsAppearanceSettings
} from './lyricsAppearance.ts'

export interface LyricsPreset {
  id: string
  name: string
  builtin: boolean
  appearance: LyricsAppearanceSettings
}

export interface LyricsPresetConfig {
  /**
   * The preset that was applied last. It is a label, not a binding: editing any
   * control afterwards writes straight to `lyricsAppearance` and leaves this
   * alone, so the field never has to be reconciled on every slider drag.
   */
  activeId: string
  custom: LyricsPreset[]
}

export const DEFAULT_LYRICS_PRESET_ID = 'default'
export const MAX_CUSTOM_LYRICS_PRESETS = 20
const MAX_PRESET_NAME_LENGTH = 48

function preset(
  id: string,
  name: string,
  build: (appearance: LyricsAppearanceSettings) => void
): LyricsPreset {
  const appearance = cloneLyricsAppearance(DEFAULT_LYRICS_APPEARANCE)
  build(appearance)
  return { id, name, builtin: true, appearance: normalizeLyricsAppearance(appearance) }
}

/**
 * The opinionated looks live here rather than in the defaults, which stay pinned
 * to what the page rendered before any of these knobs existed.
 */
export const BUILTIN_LYRICS_PRESETS: readonly LyricsPreset[] = [
  preset(DEFAULT_LYRICS_PRESET_ID, '默认', () => {}),
  preset('apple-music', 'Apple Music 风', (appearance) => {
    appearance.inactiveOpacity = 40
    appearance.styles.active.highlightEffect = 'glow'
    appearance.styles.active.highlightColor = '#fff8df'
    appearance.styles.active.highlightIntensity = 34
    appearance.styles.active.fontSize = 22
    appearance.styles.normal.fontSize = 20
    appearance.styles.translation.fontSize = 15
    appearance.styles.translation.opacity = 72
    appearance.styles.romanization.fontSize = 13
    appearance.translationSpacing = 2
    appearance.coverGap = 56
  }),
  preset('minimal', '极简', (appearance) => {
    appearance.scaleIntensity = 0
    appearance.blurIntensity = 0
    appearance.inactiveOpacity = 55
    appearance.styles.normal.lineHeight = 2.2
    appearance.styles.active.lineHeight = 2.2
    appearance.styles.normal.fontWeight = 400
    appearance.styles.active.fontWeight = 600
    appearance.styles.translation.fontSize = 15
    appearance.lyricsMaxWidth = 720
    appearance.translationSpacing = 4
  }),
  preset('large-type', '大字无障碍', (appearance) => {
    appearance.scaleIntensity = 0
    appearance.blurIntensity = 0
    appearance.inactiveOpacity = 100
    appearance.cascadeSpeed = 80
    appearance.styles.normal.fontSize = 28
    appearance.styles.normal.fontWeight = 700
    appearance.styles.active.fontSize = 32
    appearance.styles.active.fontWeight = 800
    appearance.styles.translation.fontSize = 22
    appearance.styles.translation.opacity = 100
    appearance.styles.romanization.fontSize = 20
    appearance.lyricsMaxWidth = 1000
    appearance.translationSpacing = 6
  }),
  preset('focus', '专注单行', (appearance) => {
    appearance.focusLineCount = 3
    appearance.hidePassedLines = true
    appearance.inactiveOpacity = 45
    appearance.styles.active.fontSize = 26
    appearance.styles.normal.fontSize = 20
    appearance.anchorPosition = 0.5
  })
]

export const DEFAULT_LYRICS_PRESET_CONFIG: LyricsPresetConfig = {
  activeId: DEFAULT_LYRICS_PRESET_ID,
  custom: []
}

export function findLyricsPreset(config: LyricsPresetConfig, id: string): LyricsPreset | undefined {
  return (
    BUILTIN_LYRICS_PRESETS.find((entry) => entry.id === id) ??
    config.custom.find((entry) => entry.id === id)
  )
}

export function cloneLyricsPreset(value: LyricsPreset): LyricsPreset {
  return { ...value, appearance: cloneLyricsAppearance(value.appearance) }
}

function normalizePresetName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const name = value.trim().slice(0, MAX_PRESET_NAME_LENGTH)
  return name || fallback
}

function normalizeCustomPreset(raw: unknown, index: number): LyricsPreset | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const id = typeof value.id === 'string' ? value.id.trim().slice(0, 64) : ''
  if (!id) return null
  // A stored preset must never shadow a built-in one, or applying the built-in
  // would silently resolve to the user's copy.
  if (BUILTIN_LYRICS_PRESETS.some((entry) => entry.id === id)) return null
  return {
    id,
    name: normalizePresetName(value.name, `方案 ${index + 1}`),
    builtin: false,
    appearance: normalizeLyricsAppearance(value.appearance)
  }
}

export function normalizeLyricsPresetConfig(raw: unknown): LyricsPresetConfig {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const rawCustom = Array.isArray(value.custom) ? value.custom : []

  const custom: LyricsPreset[] = []
  const seen = new Set<string>()
  for (const entry of rawCustom) {
    if (custom.length >= MAX_CUSTOM_LYRICS_PRESETS) break
    const normalized = normalizeCustomPreset(entry, custom.length)
    if (!normalized || seen.has(normalized.id)) continue
    seen.add(normalized.id)
    custom.push(normalized)
  }

  const activeId = typeof value.activeId === 'string' ? value.activeId : ''
  const known = BUILTIN_LYRICS_PRESETS.some((entry) => entry.id === activeId) || seen.has(activeId)

  return { activeId: known ? activeId : DEFAULT_LYRICS_PRESET_ID, custom }
}

export function cloneLyricsPresetConfig(value: LyricsPresetConfig): LyricsPresetConfig {
  return { activeId: value.activeId, custom: value.custom.map(cloneLyricsPreset) }
}
