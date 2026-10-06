<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { THEME_BACKGROUND_PALETTES } from '../../../../../shared/theme.ts'
import type {
  AppBackgroundSettings,
  AppTheme,
  MotionPreference,
  UiDensity
} from '@renderer/types/settings'

const { settings, updateSettings, importBackgroundImage } = useSettingsStore()

const backgroundFileInput = ref<HTMLInputElement | null>(null)

const activeTone = computed<'light' | 'dark'>(() => {
  if (settings.value.theme === 'dark') return 'dark'
  if (settings.value.theme === 'pureWhite') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
})

const activeAccentColor = computed(() =>
  activeTone.value === 'dark' ? settings.value.darkAccentColor : settings.value.lightAccentColor
)

const backgroundOptions = computed(() =>
  THEME_BACKGROUND_PALETTES[activeTone.value === 'dark' ? 'dark' : 'pureWhite'].slice(0, 6)
)

const hasBackgroundImage = computed(() => settings.value.appBackground.global.kind === 'image')

const densityOptions: { value: UiDensity; label: string }[] = [
  { value: 'compact', label: '紧凑' },
  { value: 'standard', label: '标准' },
  { value: 'comfortable', label: '舒展' }
]

const themeOptions: { value: AppTheme; label: string; icon: string }[] = [
  { value: 'system', label: '跟随系统', icon: 'ph ph-circle-half' },
  { value: 'pureWhite', label: '浅色', icon: 'ph ph-sun' },
  { value: 'dark', label: '深色', icon: 'ph ph-moon-stars' }
]

const accentOptions: { value: string; label: string; class: string }[] = [
  { value: 'violet', label: '紫罗兰', class: 'violet' },
  { value: 'blue', label: '蓝', class: 'blue' },
  { value: 'emerald', label: '翠绿', class: 'emerald' },
  { value: 'rose', label: '玫瑰', class: 'rose' },
  { value: 'amber', label: '琥珀', class: 'amber' },
  { value: 'slate', label: '石板', class: 'slate' }
]

function setTheme(theme: AppTheme): void {
  if (settings.value.theme === theme) return
  void updateSettings({ theme })
}

function setAccent(color: string): void {
  if (activeAccentColor.value === color) return
  void updateSettings(
    activeTone.value === 'dark'
      ? { accentColor: color, darkAccentColor: color }
      : { accentColor: color, lightAccentColor: color }
  )
}

function setDensity(uiDensity: UiDensity): void {
  if (settings.value.uiDensity === uiDensity) return
  void updateSettings({ uiDensity })
}

// Surface a motion switch only for users whose OS asks for reduced motion —
// everyone else keeps the default and never sees the extra row.
const systemPrefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

const motionOptions: { value: MotionPreference; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'full', label: '完整动效' },
  { value: 'reduced', label: '减弱动效' }
]

function setMotion(motionPreference: MotionPreference): void {
  if (settings.value.motionPreference === motionPreference) return
  void updateSettings({ motionPreference })
}

function cloneAppBackground(): AppBackgroundSettings {
  const background = settings.value.appBackground
  return {
    global: { ...background.global },
    pages: {
      local: { ...background.pages.local },
      settings: { ...background.pages.settings },
      streaming: { ...background.pages.streaming },
      player: { ...background.pages.player }
    }
  }
}

function isBackgroundSelected(color: string): boolean {
  const current = settings.value.appBackground.global
  return current.kind === 'color' && current[activeTone.value] === color
}

function setBackgroundColor(color: string): void {
  if (isBackgroundSelected(color)) return
  const appBackground = cloneAppBackground()
  appBackground.global.kind = 'color'
  appBackground.global[activeTone.value] = color
  void updateSettings({ appBackground })
}

function pickBackgroundImage(): void {
  backgroundFileInput.value?.click()
}

async function onBackgroundFileSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const image = await importBackgroundImage(file)
  if (!image) return
  const appBackground = cloneAppBackground()
  appBackground.global.kind = 'image'
  appBackground.global.image = image
  void updateSettings({ appBackground })
}

function clearBackgroundImage(): void {
  if (!hasBackgroundImage.value) return
  const appBackground = cloneAppBackground()
  appBackground.global.kind = 'color'
  appBackground.global.image = ''
  void updateSettings({ appBackground })
}
</script>

<template>
  <section class="onb-stage" data-scene="01">
    <p class="onb-kicker">Twilight Echo</p>
    <h1 class="onb-title">欢迎来到<em>你的声音空间</em></h1>
    <p class="onb-subtitle">先把界面调成你喜欢的样子——所有选择之后都可以在设置中随时更改。</p>
    <div class="onb-theme-row" role="radiogroup" aria-label="外观模式">
      <button
        v-for="option in themeOptions"
        :key="option.value"
        type="button"
        class="onb-theme-chip"
        :class="{ 'is-selected': settings.theme === option.value }"
        role="radio"
        :aria-checked="settings.theme === option.value"
        @click="setTheme(option.value)"
      >
        <i :class="option.icon"></i>
        {{ option.label }}
      </button>
    </div>
    <div class="onb-swatch-row" role="radiogroup" aria-label="主题色">
      <button
        v-for="option in accentOptions"
        :key="option.value"
        type="button"
        class="onb-swatch"
        :class="[option.class, { 'is-selected': activeAccentColor === option.value }]"
        role="radio"
        :aria-checked="activeAccentColor === option.value"
        :aria-label="option.label"
        :title="option.label"
        @click="setAccent(option.value)"
      >
        <i v-if="activeAccentColor === option.value" class="ph ph-check"></i>
      </button>
    </div>
    <div class="onb-segmented" role="radiogroup" aria-label="界面密度">
      <button
        v-for="option in densityOptions"
        :key="option.value"
        type="button"
        :class="{ 'is-selected': settings.uiDensity === option.value }"
        role="radio"
        :aria-checked="settings.uiDensity === option.value"
        @click="setDensity(option.value)"
      >
        {{ option.label }}
      </button>
    </div>
    <div class="onb-bg-row" role="group" aria-label="应用背景">
      <button
        v-for="option in backgroundOptions"
        :key="option.id"
        type="button"
        class="onb-bg-swatch"
        :class="{ 'is-selected': isBackgroundSelected(option.value) }"
        :style="{ '--onb-bg-swatch': option.value }"
        role="radio"
        :aria-checked="isBackgroundSelected(option.value)"
        :aria-label="`背景色：${option.label}`"
        :title="option.label"
        @click="setBackgroundColor(option.value)"
      >
        <i v-if="isBackgroundSelected(option.value)" class="ph ph-check"></i>
      </button>
      <button
        type="button"
        class="onb-bg-swatch onb-bg-custom"
        :class="{ 'is-selected': hasBackgroundImage }"
        :aria-label="hasBackgroundImage ? '更换背景图片' : '使用自定义图片作为背景'"
        title="自定义图片"
        @click="pickBackgroundImage"
      >
        <i class="ph ph-image"></i>
      </button>
      <button
        v-if="hasBackgroundImage"
        type="button"
        class="onb-bg-clear"
        aria-label="移除背景图片"
        title="移除背景图片"
        @click="clearBackgroundImage"
      >
        <i class="ph ph-x"></i>
      </button>
      <input
        ref="backgroundFileInput"
        type="file"
        accept="image/*"
        class="onb-file-input"
        aria-hidden="true"
        tabindex="-1"
        @change="onBackgroundFileSelected"
      />
    </div>
    <div
      v-if="systemPrefersReducedMotion"
      class="onb-segmented onb-motion-row"
      role="radiogroup"
      aria-label="动效偏好"
    >
      <button
        v-for="option in motionOptions"
        :key="option.value"
        type="button"
        :class="{ 'is-selected': settings.motionPreference === option.value }"
        role="radio"
        :aria-checked="settings.motionPreference === option.value"
        @click="setMotion(option.value)"
      >
        {{ option.label }}
      </button>
    </div>
    <p class="onb-hint">
      从上到下：外观模式、主题色、界面密度与应用背景——背景可选纯色，也可以用自己的图片。
    </p>
  </section>
</template>
