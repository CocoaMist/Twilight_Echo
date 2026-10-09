<script setup lang="ts">
import { useSettingsSearchDisclosure } from './settingsSearchDisclosure'
import SettingsDisclosure from './SettingsDisclosure.vue'
import { onBeforeUnmount, ref, watch } from 'vue'
import { cloneMiniPlayerSettings, type MiniPlayerSettings } from '../../../../shared/miniPlayer.ts'
import { useSettingsStore } from '../../stores/useSettingsStore'
import MiniPlayerCustomizer from '../../mini-player/MiniPlayerCustomizer.vue'
import { useMiniPlayerCustomizationDraft } from '../../mini-player/useMiniPlayerCustomizationDraft'

const { settings, updateSettings, chooseBackgroundImage } = useSettingsStore()
const open = ref(false)
let localPersistenceCount = 0

const customization = useMiniPlayerCustomizationDraft({
  initial: cloneMiniPlayerSettings(settings.value.miniPlayer),
  persist
})

async function persist(miniPlayer: MiniPlayerSettings): Promise<MiniPlayerSettings> {
  localPersistenceCount += 1
  try {
    const next = await updateSettings({ miniPlayer })
    return next.miniPlayer
  } finally {
    localPersistenceCount -= 1
  }
}

async function pickBackgroundImage(): Promise<string | null> {
  return await chooseBackgroundImage()
}

async function toggleOpen(): Promise<void> {
  if (!open.value) {
    customization.beginSession()
    open.value = true
    return
  }

  try {
    await customization.flush()
    open.value = false
  } catch {
    // Keep the editor open so the persistence error remains visible.
  }
}

watch(
  () => settings.value.miniPlayer,
  (next) => {
    if (localPersistenceCount === 0) customization.acceptConfirmed(next)
  },
  { deep: true, flush: 'sync' }
)

onBeforeUnmount(() => {
  const pendingFlush = customization.flush()
  customization.dispose()
  void pendingFlush.catch(() => undefined)
})
useSettingsSearchDisclosure('miniPlayer', open, () => customization.beginSession())
</script>

<template>
  <div class="mini-player-settings-section">
    <button
      type="button"
      class="settings-accordion-trigger setting-item"
      :class="{ open }"
      :aria-expanded="open"
      @click="toggleOpen"
    >
      <span class="setting-copy">
        <strong>独立迷你窗口</strong>
        <span
          >自定义独立悬浮窗口的主题、背景与布局。应用底部播放条在“播放条形态与可见性”中单独设置。</span
        >
      </span>
      <i class="pi pi-chevron-down"></i>
    </button>

    <SettingsDisclosure :open="open">
      <MiniPlayerCustomizer
        :settings="customization.settings.value"
        mode="inline"
        :saving="customization.saving.value"
        :error="customization.error.value"
        :pick-background-image="pickBackgroundImage"
        @update:settings="customization.replaceSettings"
        @undo="customization.undoSession"
        @reset="customization.resetActiveTheme"
        @flush="customization.flush"
      />
    </SettingsDisclosure>
  </div>
</template>

<style scoped>
.mini-player-settings-section {
  min-width: 0;
}
</style>
