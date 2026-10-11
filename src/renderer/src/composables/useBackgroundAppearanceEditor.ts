import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useSettingsStore } from '../stores/useSettingsStore'
import { previewAppearance } from '../stores/useThemeStore.ts'
import { useEscapeToClose, useFocusTrap } from '../app/useDismissLayer.ts'
import {
  appearanceEditorOpen,
  appearanceEditorArea,
  appearanceFullWindowPreview
} from './appearanceEditorState.ts'
import { useAppearanceDraft } from './useAppearanceDraft.ts'
import {
  BACKGROUND_EFFECT_RANGES,
  applyAppearancePreset,
  backgroundCssVariables,
  backgroundEffect,
  cardCssVariables,
  defaultBackground,
  defaultCardAppearance,
  resolveBackground,
  type AppearancePreset,
  type AppearanceTone
} from '../../../shared/appAppearance.ts'
import {
  DEFAULT_LIQUID_GLASS,
  liquidGlassCssVariables,
  normalizeLiquidGlass
} from '../../../shared/liquidGlass.ts'
import type {
  AppBackgroundColorPair,
  AppBackgroundEffect,
  AppBackgroundPage
} from '../../../shared/appSettings.ts'

export function useBackgroundAppearanceEditor() {
  const { settings, updateSettings, importBackgroundImage } = useSettingsStore()
  const session = useAppearanceDraft({
    confirmed: () => settings.value,
    persist: updateSettings,
    preview: previewAppearance
  })
  const { state } = session
  const dialogRef = ref<HTMLElement | null>(null)
  const bodyRef = ref<HTMLElement | null>(null)
  const fileInput = ref<HTMLInputElement | null>(null)
  const target = ref<'global' | AppBackgroundPage>('global')
  const previewPage = ref<AppBackgroundPage>('local')
  const tone = ref<AppearanceTone>(
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  )
  const importing = ref(false)
  const advancedOpen = ref(appearanceEditorArea.value === 'advanced')
  let importRevision = 0
  let pickerTarget: typeof target.value = 'global'
  const pageOptions: Array<{ value: AppBackgroundPage; label: string }> = [
    { value: 'local', label: '本地音乐' },
    { value: 'streaming', label: '在线音乐' },
    { value: 'player', label: '播放页' },
    { value: 'settings', label: '设置页' }
  ]
  const materials: Array<{ value: AppearancePreset; label: string; icon: string }> = [
    { value: 'theme', label: '跟随主题', icon: 'pi pi-palette' },
    { value: 'transparent', label: '透明', icon: 'pi pi-eye' },
    { value: 'frosted', label: '毛玻璃', icon: 'pi pi-cloud' },
    { value: 'liquidGlass', label: '液态玻璃', icon: 'pi pi-sparkles' }
  ]
  const activeBackground = computed(() =>
    target.value === 'global'
      ? state.draft.appBackground.global
      : resolveBackground(state.draft.appBackground, target.value)
  )
  const inherited = computed(
    () => target.value !== 'global' && state.draft.appBackground.pages[target.value].inherit
  )
  const effect = computed(() => backgroundEffect(activeBackground.value, tone.value))
  const activeMaterial = computed(() =>
    state.draft.surfaceMaterial === 'standard'
      ? state.draft.cardAppearance.enabled
        ? 'frosted'
        : 'theme'
      : state.draft.surfaceMaterial
  )
  const previewStyle = computed(() => {
    const background = resolveBackground(state.draft.appBackground, previewPage.value)
    const card = state.draft.cardAppearance[tone.value]
    const glass = state.draft.liquidGlass[tone.value]
    return {
      ...backgroundCssVariables(background, tone.value),
      ...cardCssVariables(card),
      ...liquidGlassCssVariables(glass),
      '--preview-surface':
        state.draft.surfaceMaterial === 'transparent'
          ? 'transparent'
          : state.draft.surfaceMaterial === 'liquidGlass'
            ? `color-mix(in srgb, ${tone.value === 'dark' ? '#17181a' : '#ffffff'} ${glass.tintOpacity}%, transparent)`
            : state.draft.cardAppearance.enabled
              ? 'var(--te-card-bg)'
              : tone.value === 'dark'
                ? '#181818dd'
                : '#ffffffdd',
      '--preview-filter':
        state.draft.surfaceMaterial === 'transparent'
          ? 'none'
          : state.draft.surfaceMaterial === 'liquidGlass'
            ? `blur(${glass.blurAmount}px) saturate(${glass.saturation}%)`
            : state.draft.cardAppearance.enabled
              ? `blur(${card.blurRadius}px) saturate(${card.blurSaturation}%)`
              : 'none',
      '--preview-border':
        state.draft.surfaceMaterial === 'transparent' ? 'transparent' : 'var(--te-card-border)',
      '--preview-shadow':
        state.draft.surfaceMaterial === 'transparent'
          ? 'none'
          : state.draft.surfaceMaterial === 'liquidGlass'
            ? 'inset 0 1px 0 #ffffff40'
            : state.draft.cardAppearance.enabled
              ? 'var(--te-card-shadow)'
              : 'none'
    }
  })
  useFocusTrap(dialogRef, () => appearanceEditorOpen.value && !state.fullWindow)
  useEscapeToClose(
    () => appearanceEditorOpen.value,
    () => {
      if (state.saving || importing.value) return
      if (state.fullWindow) void fullPreview(false)
      else void cancel()
    }
  )
  watch(
    appearanceEditorOpen,
    (open) => {
      if (open) session.begin()
    },
    { immediate: true }
  )
  async function scrollToArea(): Promise<void> {
    if (appearanceEditorArea.value === 'advanced') advancedOpen.value = true
    await nextTick()
    bodyRef.value
      ?.querySelector(`#appearance-${appearanceEditorArea.value}`)
      ?.scrollIntoView({ block: 'start', behavior: 'instant' })
  }
  watch([appearanceEditorArea, bodyRef], () => void scrollToArea(), { flush: 'post' })
  watch(
    () => state.draft,
    () => {
      if (state.fullWindow) void previewAppearance(state.draft)
    },
    { deep: true }
  )
  watch(
    () => state.fullWindow,
    (value) => {
      appearanceFullWindowPreview.value = value
    },
    { flush: 'sync' }
  )
  watch(target, (page) => {
    if (page !== 'global') previewPage.value = page
  })

  function editableBackground(page = target.value, customize = true): AppBackgroundColorPair {
    const background =
      page === 'global' ? state.draft.appBackground.global : state.draft.appBackground.pages[page]
    if (customize) background.customized = true
    return background
  }
  function setEffect<K extends keyof AppBackgroundEffect>(
    field: K,
    value: AppBackgroundEffect[K]
  ): void {
    if (inherited.value) return
    const background = editableBackground(target.value, false)
    background.effects ??= {
      light: backgroundEffect(background, 'light'),
      dark: backgroundEffect(background, 'dark')
    }
    background.effects[tone.value][field] = value
  }
  function setInheritance(event: Event): void {
    if (target.value === 'global') return
    const inherit = (event.target as HTMLInputElement).checked
    const page = state.draft.appBackground.pages[target.value]
    if (!inherit && page.inherit) {
      const global = state.draft.appBackground.global
      Object.assign(page, {
        ...global,
        effects: {
          light: { ...backgroundEffect(global, 'light') },
          dark: { ...backgroundEffect(global, 'dark') }
        }
      })
    }
    page.inherit = inherit
  }
  function chooseImage(): void {
    pickerTarget = target.value
    fileInput.value?.click()
  }
  async function importImage(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    const revision = ++importRevision
    const selectedTarget = pickerTarget
    importing.value = true
    state.error = ''
    try {
      if (!/\.(jpe?g|png|webp)$/i.test(file.name) || file.size > 20 * 1024 * 1024)
        throw new Error('请选择 20MB 以内的 JPG、PNG 或 WebP 图片')
      const image = await importBackgroundImage(file)
      if (!image) throw new Error('图片导入失败，请重新选择')
      const bitmap = new Image()
      bitmap.src = image
      await bitmap.decode()
      if (revision !== importRevision) return
      const background = editableBackground(selectedTarget)
      background.image = image
      background.kind = 'image'
    } catch (error) {
      if (revision === importRevision)
        state.error = error instanceof Error ? error.message : '无法读取这张图片'
    } finally {
      if (revision === importRevision) importing.value = false
    }
  }
  function removeImage(): void {
    const background = editableBackground()
    background.image = ''
    background.kind = 'color'
  }
  function resetCurrent(): void {
    if (appearanceEditorArea.value !== 'background') {
      state.draft.cardAppearance = defaultCardAppearance()
      state.draft.liquidGlass = normalizeLiquidGlass(DEFAULT_LIQUID_GLASS)
      state.draft.surfaceMaterial = 'standard'
    } else if (target.value === 'global') {
      state.draft.appBackground.global = defaultBackground()
    } else {
      state.draft.appBackground.pages[target.value] = {
        ...defaultBackground(target.value),
        inherit: true
      }
    }
  }
  function selectMaterial(preset: AppearancePreset): void {
    state.draft = applyAppearancePreset(state.draft, preset)
  }
  function useTransparentRecipe(): void {
    selectMaterial('transparent')
    for (const [field, value] of Object.entries({
      textTone: 'light',
      blur: 0,
      dim: 40,
      brightness: 100,
      scale: 1
    }))
      setEffect(
        field as keyof AppBackgroundEffect,
        value as AppBackgroundEffect[keyof AppBackgroundEffect]
      )
  }
  async function fullPreview(value: boolean): Promise<void> {
    await session.preview(value)
    if (!value) {
      await nextTick()
      dialogRef.value?.focus({ preventScroll: true })
    }
  }
  async function cancel(): Promise<void> {
    if (state.saving) return
    importRevision++
    await session.cancel()
    appearanceEditorOpen.value = false
  }
  async function save(): Promise<void> {
    if (!importing.value && (await session.save())) appearanceEditorOpen.value = false
  }
  onBeforeUnmount(() => {
    importRevision++
    appearanceFullWindowPreview.value = false
    void session.cancel()
  })
  return {
    state,
    dialogRef,
    bodyRef,
    fileInput,
    target,
    previewPage,
    tone,
    importing,
    advancedOpen,
    pageOptions,
    materials,
    activeBackground,
    inherited,
    effect,
    activeMaterial,
    previewStyle,
    editableBackground,
    setEffect,
    setInheritance,
    chooseImage,
    importImage,
    removeImage,
    resetCurrent,
    selectMaterial,
    useTransparentRecipe,
    fullPreview,
    cancel,
    save,
    ranges: BACKGROUND_EFFECT_RANGES
  }
}
