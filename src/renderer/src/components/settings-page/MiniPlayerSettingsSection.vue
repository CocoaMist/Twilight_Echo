<script setup lang="ts">
import SettingsDisclosure from './SettingsDisclosure.vue'
import { registerSettingsDisclosure } from './settingsDisclosureRegistry.ts'
import { onBeforeUnmount, ref, watch } from 'vue'
import { cloneMiniPlayerSettings, type MiniPlayerSettings } from '../../../../shared/miniPlayer.ts'
import { useSettingsStore } from '../../stores/useSettingsStore'
import MiniPlayerCustomizer from '../../mini-player/MiniPlayerCustomizer.vue'
import { useMiniPlayerCustomizationDraft } from '../../mini-player/useMiniPlayerCustomizationDraft'

const { settings, updateSettings, chooseBackgroundImage } = useSettingsStore()
const open = ref(true)
let localPersistenceCount = 0
let sessionStarted = false

const customization = useMiniPlayerCustomizationDraft({
  initial: cloneMiniPlayerSettings(settings.value.miniPlayer),
  persist
})
function beginSession(): void {
  customization.beginSession()
  sessionStarted = true
}

function replaceCustomization(next: MiniPlayerSettings): void {
  if (!sessionStarted) beginSession()
  customization.replaceSettings(next)
}

function resetCustomization(): void {
  if (!sessionStarted) beginSession()
  customization.resetActiveTheme()
}

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

registerSettingsDisclosure('mini-player', async () => {
  if (!open.value) {
    beginSession()
    open.value = true
  }
})
function toggleMiniPlayerShowInTaskbar(): void {
  replaceCustomization({
    ...customization.settings.value,
    showInTaskbar: !customization.settings.value.showInTaskbar
  })
  void customization.flush().catch(() => undefined)
}

async function toggleOpen(): Promise<void> {
  if (!open.value) {
    beginSession()
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
</script>

<template>
  <div id="mini-player" class="mini-player-settings-section section-block">
    <button
      data-setting-id="mini-player"
      id="setting-mini-player"
      type="button"
      class="settings-accordion-trigger setting-item"
      :class="{ open }"
      :aria-expanded="open"
      aria-controls="mini-player-content"
      @click="toggleOpen"
    >
      <span class="setting-copy">
        <strong>迷你播放器</strong>
        <span>自定义迷你播放器窗口的主题、背景与布局。</span>
        <span v-if="customization.error.value" role="status">{{ customization.error.value }}</span>
      </span>
      <i class="pi pi-chevron-down"></i>
    </button>

    <SettingsDisclosure id="mini-player-content" :open="open" keep-mounted>
      <div data-setting-id="mini-taskbar" id="setting-mini-taskbar" class="setting-item">
        <div class="setting-copy">
          <strong>迷你播放器显示在任务栏</strong>
          <span>开启后可从任务栏独立唤回迷你播放器；关闭后仅剩下悬浮小窗。</span>
        </div>
        <button
          type="button"
          class="toggle-switch"
          :class="{
            active: customization.settings.value.showInTaskbar,
            inactive: !customization.settings.value.showInTaskbar
          }"
          role="switch"
          aria-label="迷你播放器显示在任务栏"
          :aria-checked="customization.settings.value.showInTaskbar"
          @click="toggleMiniPlayerShowInTaskbar"
        ></button>
      </div>
      <MiniPlayerCustomizer
        :settings="customization.settings.value"
        mode="inline"
        :saving="customization.saving.value"
        :error="customization.error.value"
        :pick-background-image="pickBackgroundImage"
        @update:settings="replaceCustomization"
        @undo="customization.undoSession"
        @reset="resetCustomization"
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
