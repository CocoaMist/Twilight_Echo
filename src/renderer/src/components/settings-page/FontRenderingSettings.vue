<script setup lang="ts">
import { useSettingsStore } from '../../stores/useSettingsStore'
import type { AppFontRendering } from '../../../../shared/appFont.ts'

const { settings, updateSettings } = useSettingsStore()
const options: { value: AppFontRendering; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'crisp', label: '清晰' },
  { value: 'smooth', label: '平滑' }
]

function setRendering(fontRendering: AppFontRendering): void {
  if (settings.value.fontRendering === fontRendering) return
  void updateSettings({ fontRendering }).catch(() => {
    // The store restores the confirmed value and exposes the save error to SettingsPage.
  })
}
</script>

<template>
  <div class="setting-item">
    <div class="setting-copy">
      <strong id="font-rendering-label">文字渲染</strong>
      <span id="font-rendering-description">
        文字发虚时可选“清晰”，轻微增强笔画，适合图片和透明背景。立即生效。
      </span>
      <span class="font-rendering-sample">夜航星 · Twilight Echo · 0123456789</span>
    </div>
    <div
      class="segmented-control"
      role="group"
      aria-labelledby="font-rendering-label"
      aria-describedby="font-rendering-description"
    >
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        :class="{ active: settings.fontRendering === option.value }"
        :aria-pressed="settings.fontRendering === option.value"
        @click="setRendering(option.value)"
      >
        {{ option.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.setting-copy .font-rendering-sample {
  color: var(--te-settings-text, var(--te-neutral-900));
  font-family: var(--te-font-sans);
  overflow-wrap: anywhere;
}
</style>
