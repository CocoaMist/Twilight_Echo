import { computed, onBeforeUnmount, ref, type ComputedRef, type Ref } from 'vue'
import {
  DEFAULT_LYRICS_APPEARANCE,
  cloneLyricsAppearance,
  normalizeLyricsAppearance,
  syncLegacyLyricsAppearance,
  LYRICS_STYLE_TARGETS,
  type LyricsAppearanceSettings,
  type LyricsStyleTarget,
  type LyricsTextStyle
} from '../../../shared/lyricsAppearance.ts'
import {
  BUILTIN_LYRICS_PRESETS,
  DEFAULT_LYRICS_PRESET_ID,
  MAX_CUSTOM_LYRICS_PRESETS,
  cloneLyricsPresetConfig,
  findLyricsPreset,
  type LyricsPreset
} from '../../../shared/lyricsPresets.ts'
import { useSettingsStore } from '../stores/useSettingsStore'

export type LyricsSaveState = 'idle' | 'saving' | 'saved' | 'error'

/** Legacy top-level keys that must fan out into the style layers when written. */
const LEGACY_KEYS = new Set<keyof LyricsAppearanceSettings>([
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'align',
  'colorMode',
  'textColor',
  'activeColor',
  'karaokeColor'
])

const SAVE_DEBOUNCE_MS = 180

export interface LyricsAppearanceEditor {
  draft: Ref<LyricsAppearanceSettings>
  activeTarget: Ref<LyricsStyleTarget>
  style: ComputedRef<LyricsTextStyle>
  saveState: Ref<LyricsSaveState>
  statusLabel: ComputedRef<string>
  presets: ComputedRef<LyricsPreset[]>
  activePresetId: ComputedRef<string>
  canSavePreset: ComputedRef<boolean>
  patchStyle: <K extends keyof LyricsTextStyle>(key: K, value: LyricsTextStyle[K]) => void
  setGlobal: <K extends keyof LyricsAppearanceSettings>(
    key: K,
    value: LyricsAppearanceSettings[K]
  ) => void
  syncFontSizeToAll: () => void
  resetTarget: () => void
  resetAll: () => void
  reloadFromSettings: () => void
  applyPreset: (id: string) => void
  savePreset: (name: string) => void
  deletePreset: (id: string) => void
}

/**
 * Shared editing surface for lyric appearance. The drawer, the settings page and
 * the playbar panel all drive the same draft through this, so a bound written in
 * one place cannot drift from the others — previously two of them carried
 * verbatim copies of the legacy fan-out and three different slider ranges.
 */
export function useLyricsAppearanceEditor(): LyricsAppearanceEditor {
  const { settings, updateSettings } = useSettingsStore()
  const draft = ref<LyricsAppearanceSettings>(
    cloneLyricsAppearance(settings.value.lyricsAppearance)
  )
  const activeTarget = ref<LyricsStyleTarget>('normal')
  const saveState = ref<LyricsSaveState>('idle')
  let saveTimer = 0
  let saveSequence = 0

  const style = computed(() => draft.value.styles[activeTarget.value])
  const statusLabel = computed(() => {
    if (saveState.value === 'saving') return '保存中…'
    if (saveState.value === 'saved') return '已保存'
    if (saveState.value === 'error') return '保存失败'
    return '实时预览'
  })

  const presetDraft = ref<ReturnType<typeof cloneLyricsPresetConfig> | null>(null)
  const presetConfig = computed(() => presetDraft.value ?? settings.value.lyricsPresets)
  const presets = computed(() => [...BUILTIN_LYRICS_PRESETS, ...presetConfig.value.custom])
  const activePresetId = computed(() => presetConfig.value.activeId)
  const canSavePreset = computed(() => presetConfig.value.custom.length < MAX_CUSTOM_LYRICS_PRESETS)

  function commit(
    next: LyricsAppearanceSettings,
    extra?: Partial<Pick<typeof settings.value, 'lyricsPresets'>>,
    delay = SAVE_DEBOUNCE_MS
  ): void {
    if (saveTimer) window.clearTimeout(saveTimer)
    const normalized = normalizeLyricsAppearance(next)
    draft.value = normalized
    if (extra?.lyricsPresets) presetDraft.value = cloneLyricsPresetConfig(extra.lyricsPresets)
    const nextPresets = presetDraft.value ? cloneLyricsPresetConfig(presetDraft.value) : undefined
    saveState.value = 'saving'
    const sequence = ++saveSequence
    saveTimer = window.setTimeout(async () => {
      saveTimer = 0
      try {
        await updateSettings({
          ...(nextPresets ? { lyricsPresets: nextPresets } : {}),
          lyricsAppearance: cloneLyricsAppearance(normalized)
        })
        if (sequence === saveSequence) {
          presetDraft.value = null
          saveState.value = 'saved'
        }
      } catch {
        if (sequence === saveSequence) saveState.value = 'error'
      }
    }, delay)
  }

  function patchStyle<K extends keyof LyricsTextStyle>(key: K, value: LyricsTextStyle[K]): void {
    commit({
      ...draft.value,
      styles: {
        ...draft.value.styles,
        [activeTarget.value]: { ...style.value, [key]: value }
      }
    })
  }

  function setGlobal<K extends keyof LyricsAppearanceSettings>(
    key: K,
    value: LyricsAppearanceSettings[K]
  ): void {
    // The quick controls still speak the legacy vocabulary, so those keys have to
    // reach the style layers as well or the compact editors would appear inert.
    const next = LEGACY_KEYS.has(key)
      ? syncLegacyLyricsAppearance(draft.value, {
          [key]: value
        } as Partial<LyricsAppearanceSettings>)
      : { ...draft.value, [key]: value }
    commit(next)
  }

  /**
   * Schema 3 gave every layer its own size. This is the deliberate way back to
   * one size everywhere, replacing the old behaviour where normalization forced
   * it on every save.
   */
  function syncFontSizeToAll(): void {
    commit(syncLegacyLyricsAppearance(draft.value, { fontSize: style.value.fontSize }))
  }

  function resetTarget(): void {
    commit({
      ...draft.value,
      styles: {
        ...draft.value.styles,
        [activeTarget.value]: { ...DEFAULT_LYRICS_APPEARANCE.styles[activeTarget.value] }
      }
    })
  }

  function resetAll(): void {
    commit(cloneLyricsAppearance(DEFAULT_LYRICS_APPEARANCE), undefined, 0)
  }

  function reloadFromSettings(): void {
    draft.value = cloneLyricsAppearance(settings.value.lyricsAppearance)
    presetDraft.value = null
    saveState.value = 'idle'
  }

  function applyPreset(id: string): void {
    const preset = findLyricsPreset(presetConfig.value, id)
    if (!preset) return
    const nextConfig = cloneLyricsPresetConfig(presetConfig.value)
    nextConfig.activeId = preset.id
    commit(cloneLyricsAppearance(preset.appearance), { lyricsPresets: nextConfig }, 0)
  }

  function savePreset(name: string): void {
    const label = name.trim()
    if (!label || !canSavePreset.value) return
    const nextConfig = cloneLyricsPresetConfig(presetConfig.value)
    const preset: LyricsPreset = {
      id: `custom-${crypto.randomUUID()}`,
      name: label,
      builtin: false,
      appearance: cloneLyricsAppearance(draft.value)
    }
    nextConfig.custom = [...nextConfig.custom, preset]
    nextConfig.activeId = preset.id
    commit(cloneLyricsAppearance(draft.value), { lyricsPresets: nextConfig }, 0)
  }

  function deletePreset(id: string): void {
    const nextConfig = cloneLyricsPresetConfig(presetConfig.value)
    const remaining = nextConfig.custom.filter((preset) => preset.id !== id)
    if (remaining.length === nextConfig.custom.length) return
    nextConfig.custom = remaining
    // Deleting the preset that is currently applied leaves the appearance alone
    // and only drops the label, so the look the user is seeing does not jump.
    if (nextConfig.activeId === id) nextConfig.activeId = DEFAULT_LYRICS_PRESET_ID
    commit(cloneLyricsAppearance(draft.value), { lyricsPresets: nextConfig }, 0)
  }

  onBeforeUnmount(() => {
    if (saveTimer) window.clearTimeout(saveTimer)
  })

  return {
    draft,
    activeTarget,
    style,
    saveState,
    statusLabel,
    presets,
    activePresetId,
    canSavePreset,
    patchStyle,
    setGlobal,
    syncFontSizeToAll,
    resetTarget,
    resetAll,
    reloadFromSettings,
    applyPreset,
    savePreset,
    deletePreset
  }
}

export { LYRICS_STYLE_TARGETS }
