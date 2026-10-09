<script setup lang="ts">
import { computed } from 'vue'
import EditableRangeValue from '../EditableRangeValue.vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import type { WindowTransparencyEffectSettings } from '../../types/settings'
import type { BooleanSettingKey } from './types.ts'

defineProps<{
  toggleSetting: (key: BooleanSettingKey) => void
}>()

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

function toggleCompactVisualizer(): void {
  void updateSettings({
    playerBar: {
      ...settings.value.playerBar,
      compactVisualizerEnabled: !settings.value.playerBar.compactVisualizerEnabled
    }
  })
}
</script>

<template>
  <section id="performance" class="glass-card preview-section">
    <div class="section-title-row">
      <i class="pi pi-bolt"></i>
      <h2>性能</h2>
    </div>
    <div class="setting-list">
      <div class="setting-item">
        <div class="setting-copy">
          <strong>歌词页底部动态频谱</strong>
          <span>关闭后隐藏底部跳动的频谱条，并停止它的数据轮询；播放控制栏仍然显示。</span>
        </div>
        <button
          type="button"
          class="toggle-switch"
          :class="{
            active: settings.playerBar.compactVisualizerEnabled,
            inactive: !settings.playerBar.compactVisualizerEnabled
          }"
          role="switch"
          aria-label="歌词页底部动态频谱"
          :aria-checked="settings.playerBar.compactVisualizerEnabled"
          @click="toggleCompactVisualizer"
        ></button>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>硬件加速</strong>
          <span>使用显卡加速界面渲染、动画与模糊效果。更改后需重启应用。</span>
        </div>
        <button
          type="button"
          class="toggle-switch"
          :class="{
            active: settings.hardwareAcceleration,
            inactive: !settings.hardwareAcceleration
          }"
          role="switch"
          aria-label="硬件加速"
          :aria-checked="settings.hardwareAcceleration"
          @click="toggleSetting('hardwareAcceleration')"
        ></button>
      </div>
      <div class="setting-item">
        <div class="setting-copy">
          <strong>窗口透明</strong>
          <span
            >让应用窗口透出桌面背景，需系统支持透明与模糊效果。更改后需重启；与外观分区的卡片玻璃效果独立。</span
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
        当前系统不支持透明窗口，已回退为不透明窗口，应用仍可正常使用。
      </div>
      <div v-else-if="!transparencySupported" class="settings-inline-warning" role="status">
        当前系统未提供透明窗口支持，此选项暂不可用。
      </div>
      <template v-if="settings.windowTransparency && transparencySupported">
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>窗口表面不透明度</strong>
            <span>页面背景表面的不透明程度，越低越通透。</span>
          </div>
          <div class="inline-controls">
            <input
              aria-label="窗口表面不透明度"
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
        <div class="setting-item">
          <div class="setting-copy">
            <strong>窗口表面模糊度</strong>
            <span>页面背景表面的应用内模糊强度。</span>
          </div>
          <div class="inline-controls">
            <input
              aria-label="窗口表面模糊度"
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
        <div class="setting-item">
          <div class="setting-copy">
            <strong>窗口内卡片不透明度</strong>
            <span>卡片表面的不透明程度，越低越通透。</span>
          </div>
          <div class="inline-controls">
            <input
              aria-label="窗口内卡片不透明度"
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
        <div class="setting-item">
          <div class="setting-copy">
            <strong>窗口内卡片模糊度</strong>
            <span>卡片表面的应用内模糊强度。</span>
          </div>
          <div class="inline-controls">
            <input
              aria-label="窗口内卡片模糊度"
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
  </section>
</template>
