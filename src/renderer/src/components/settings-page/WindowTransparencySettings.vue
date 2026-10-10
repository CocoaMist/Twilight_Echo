<script setup lang="ts">
import { computed } from 'vue'
import EditableRangeValue from '../EditableRangeValue.vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import type { WindowTransparencyEffectSettings } from '../../types/settings'
import type { BooleanSettingKey } from './types.ts'

const { settings, updateSettings, windowTransparencySupported } = useSettingsStore()

const transparencyUnsupported = computed(
  () => settings.value.windowTransparency === true && windowTransparencySupported.value === false
)
const transparencySupported = computed(() => windowTransparencySupported.value === true)

function updateTp<K extends keyof WindowTransparencyEffectSettings>(
  key: K,
  value: WindowTransparencyEffectSettings[K]
): void {
  void updateSettings({
    windowTransparencyEffect: { ...settings.value.windowTransparencyEffect, [key]: value }
  })
}

function toggleSetting(key: BooleanSettingKey): void {
  void updateSettings({ [key]: !settings.value[key] })
}
</script>

<template>
  <div class="window-transparency-settings">
    <hr />
    <div
      data-setting-id="window-transparency"
      id="setting-window-transparency"
      class="setting-item"
    >
      <div class="setting-copy">
        <strong>系统窗口透明</strong>
        <span>显示桌面与系统模糊效果，更改后需重启。</span>
        <span class="setting-substatus"
          >支持 Windows 11 22H2+ 和启用合成器的 Linux X11；需开启系统透明效果。</span
        >
        <span v-if="!transparencySupported" class="setting-substatus"
          >当前系统暂不支持此功能；Linux Wayland 不支持窗口透明。</span
        >
      </div>
      <button
        type="button"
        class="toggle-switch"
        :class="{
          active: settings.windowTransparency,
          inactive: !settings.windowTransparency,
          disabled: !transparencySupported
        }"
        role="switch"
        aria-label="窗口透明"
        :disabled="!transparencySupported"
        :aria-checked="settings.windowTransparency"
        :aria-disabled="!transparencySupported"
        @click="toggleSetting('windowTransparency')"
      ></button>
    </div>
    <div v-if="transparencyUnsupported" class="settings-inline-warning" role="status">
      当前系统不支持透明窗口（Linux Wayland，或 Windows
      未开启系统透明效果），已自动回退为不透明窗口，应用仍可正常使用。
    </div>
    <template v-if="settings.windowTransparency && transparencySupported">
      <hr />
      <div
        data-setting-id="window-surface-opacity"
        id="setting-window-surface-opacity"
        class="setting-item"
      >
        <div class="setting-copy">
          <strong>背景表面不透明度</strong>
          <span>页面背景表面的不透明程度，越低越通透。</span>
        </div>
        <div class="inline-controls">
          <input
            type="range"
            class="range-input"
            min="0"
            max="100"
            :value="settings.windowTransparencyEffect.surfaceOpacity"
            @input="updateTp('surfaceOpacity', Number(($event.target as HTMLInputElement).value))"
          />
          <EditableRangeValue
            :value="settings.windowTransparencyEffect.surfaceOpacity"
            :min="0"
            :max="100"
            suffix="%"
            aria-label="编辑表面不透明度"
            @change="updateTp('surfaceOpacity', $event)"
          />
        </div>
      </div>
      <div
        data-setting-id="window-surface-blur"
        id="setting-window-surface-blur"
        class="setting-item"
      >
        <div class="setting-copy">
          <strong>背景表面模糊度</strong>
          <span>页面背景表面的应用内模糊强度。</span>
        </div>
        <div class="inline-controls">
          <input
            type="range"
            class="range-input"
            min="0"
            max="60"
            :value="settings.windowTransparencyEffect.surfaceBlur"
            @input="updateTp('surfaceBlur', Number(($event.target as HTMLInputElement).value))"
          />
          <EditableRangeValue
            :value="settings.windowTransparencyEffect.surfaceBlur"
            :min="0"
            :max="60"
            suffix="px"
            aria-label="编辑表面模糊度"
            @change="updateTp('surfaceBlur', $event)"
          />
        </div>
      </div>
      <hr />
      <div
        data-setting-id="window-card-opacity"
        id="setting-window-card-opacity"
        class="setting-item"
      >
        <div class="setting-copy">
          <strong>卡片不透明度</strong>
          <span>卡片表面的不透明程度，越低越通透。</span>
        </div>
        <div class="inline-controls">
          <input
            type="range"
            class="range-input"
            min="0"
            max="100"
            :value="settings.windowTransparencyEffect.cardOpacity"
            @input="updateTp('cardOpacity', Number(($event.target as HTMLInputElement).value))"
          />
          <EditableRangeValue
            :value="settings.windowTransparencyEffect.cardOpacity"
            :min="0"
            :max="100"
            suffix="%"
            aria-label="编辑卡片不透明度"
            @change="updateTp('cardOpacity', $event)"
          />
        </div>
      </div>
      <div data-setting-id="window-card-blur" id="setting-window-card-blur" class="setting-item">
        <div class="setting-copy">
          <strong>卡片模糊度</strong>
          <span>卡片表面的应用内模糊强度。</span>
        </div>
        <div class="inline-controls">
          <input
            type="range"
            class="range-input"
            min="0"
            max="60"
            :value="settings.windowTransparencyEffect.cardBlur"
            @input="updateTp('cardBlur', Number(($event.target as HTMLInputElement).value))"
          />
          <EditableRangeValue
            :value="settings.windowTransparencyEffect.cardBlur"
            :min="0"
            :max="60"
            suffix="px"
            aria-label="编辑卡片模糊度"
            @change="updateTp('cardBlur', $event)"
          />
        </div>
      </div>
    </template>
  </div>
</template>
