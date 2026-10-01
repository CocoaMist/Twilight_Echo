<script setup lang="ts">
import { ref } from 'vue'
import EditableRangeValue from '../EditableRangeValue.vue'
import LyricsAppearanceCustomizer from '../LyricsAppearanceCustomizer.vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useLyricsAppearanceEditor } from '../../composables/useLyricsAppearanceEditor.ts'
import { LYRICS_RANGES } from '../../../../shared/lyricsAppearance.ts'
import {
  lyricAlignOptions,
  lyricsAppearanceFontFamilyOptions,
  lyricsFocusLineCountOptions
} from './types.ts'
import type { LyricsAppearanceSettings } from '../../types/settings'

const { settings } = useSettingsStore()

const lyricsEditor = useLyricsAppearanceEditor()
const lyricsRanges = LYRICS_RANGES
const open = ref(false)
const customizerOpen = ref(false)

function updateLyricsAppearance<K extends keyof LyricsAppearanceSettings>(
  key: K,
  value: LyricsAppearanceSettings[K]
): void {
  // The shared editor owns the legacy fan-out and the published bounds, so the
  // quick controls here cannot drift from the full editor in the drawer.
  lyricsEditor.setGlobal(key, value)
}
</script>

<template>
  <button
    type="button"
    class="settings-accordion-trigger setting-item"
    :class="{ open }"
    :aria-expanded="open"
    @click="open = !open"
  >
    <span class="setting-copy">
      <strong>歌词显示样式</strong>
      <span>控制主播放页的排版、聚焦范围和高亮效果。</span>
    </span>
    <i aria-hidden="true" class="pi pi-chevron-down"></i>
  </button>
  <div v-if="open" class="settings-accordion-body">
    <hr />
    <div class="setting-item">
      <div class="setting-copy">
        <strong>歌词字体</strong>
        <span>主播放页歌词使用的字体，默认跟随界面字体。</span>
      </div>
      <select
        class="preview-select wide"
        :value="settings.lyricsAppearance.fontFamily"
        @change="
          updateLyricsAppearance(
            'fontFamily',
            ($event.target as HTMLSelectElement).value as LyricsAppearanceSettings['fontFamily']
          )
        "
      >
        <option
          v-for="option in lyricsAppearanceFontFamilyOptions"
          :key="option.value"
          :value="option.value"
        >
          {{ option.label }}
        </option>
      </select>
    </div>
    <hr />
    <div class="setting-item">
      <div class="setting-copy">
        <strong>歌词对齐</strong>
        <span>歌词整行在播放页中的水平对齐方式。</span>
      </div>
      <div class="segmented-control" role="group" aria-label="歌词对齐">
        <button
          v-for="option in lyricAlignOptions"
          :key="option.value"
          type="button"
          :class="{ active: settings.lyricsAppearance.align === option.value }"
          @click="updateLyricsAppearance('align', option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </div>
    <hr />
    <div class="setting-item">
      <div class="setting-copy">
        <strong>歌词字号</strong>
        <span>普通行的基准字号，当前行与翻译行按比例跟随。</span>
      </div>
      <div class="range-pill">
        <span>字号</span>
        <input
          class="range-input"
          type="range"
          :min="lyricsRanges.fontSize.min"
          :max="lyricsRanges.fontSize.max"
          :value="settings.lyricsAppearance.fontSize"
          @input="
            updateLyricsAppearance('fontSize', Number(($event.target as HTMLInputElement).value))
          "
        />
        <EditableRangeValue
          :value="settings.lyricsAppearance.fontSize"
          :min="lyricsRanges.fontSize.min"
          :max="lyricsRanges.fontSize.max"
          suffix="px"
          aria-label="编辑歌词字号"
          @change="updateLyricsAppearance('fontSize', $event)"
        />
      </div>
    </div>
    <hr />
    <div class="setting-item">
      <div class="setting-copy">
        <strong>歌词字重</strong>
        <span>歌词文字的粗细，数值越大越粗。</span>
      </div>
      <div class="range-pill">
        <span>字重</span>
        <input
          class="range-input"
          type="range"
          min="400"
          max="700"
          step="100"
          :value="settings.lyricsAppearance.fontWeight"
          @input="
            updateLyricsAppearance('fontWeight', Number(($event.target as HTMLInputElement).value))
          "
        />
        <EditableRangeValue
          :value="settings.lyricsAppearance.fontWeight"
          :min="400"
          :max="700"
          :step="100"
          aria-label="编辑歌词字重"
          @change="updateLyricsAppearance('fontWeight', $event)"
        />
      </div>
    </div>
    <hr />
    <div class="setting-item">
      <div class="setting-copy">
        <strong>歌词行距</strong>
        <span>相邻歌词行之间的行高倍数。</span>
      </div>
      <div class="range-pill">
        <span>行距</span>
        <input
          class="range-input"
          type="range"
          :min="lyricsRanges.lineHeight.min"
          :max="lyricsRanges.lineHeight.max"
          :step="lyricsRanges.lineHeight.step"
          :value="settings.lyricsAppearance.lineHeight"
          @input="
            updateLyricsAppearance('lineHeight', Number(($event.target as HTMLInputElement).value))
          "
        />
        <EditableRangeValue
          :value="settings.lyricsAppearance.lineHeight"
          :min="lyricsRanges.lineHeight.min"
          :max="lyricsRanges.lineHeight.max"
          :step="lyricsRanges.lineHeight.step"
          aria-label="编辑歌词行距"
          @change="updateLyricsAppearance('lineHeight', $event)"
        />
      </div>
    </div>
    <hr />
    <div class="setting-item">
      <div class="setting-copy">
        <strong>未播放暗度</strong>
        <span>尚未唱到的歌词行保留多少亮度，数值越低越暗。</span>
      </div>
      <div class="range-pill">
        <span>暗度</span>
        <input
          class="range-input"
          type="range"
          :min="lyricsRanges.inactiveOpacity.min"
          :max="lyricsRanges.inactiveOpacity.max"
          :step="lyricsRanges.inactiveOpacity.step"
          :value="settings.lyricsAppearance.inactiveOpacity"
          @input="
            updateLyricsAppearance(
              'inactiveOpacity',
              Number(($event.target as HTMLInputElement).value)
            )
          "
        />
        <EditableRangeValue
          :value="settings.lyricsAppearance.inactiveOpacity"
          :min="lyricsRanges.inactiveOpacity.min"
          :max="lyricsRanges.inactiveOpacity.max"
          suffix="%"
          aria-label="编辑未播放歌词暗度"
          @change="updateLyricsAppearance('inactiveOpacity', $event)"
        />
      </div>
    </div>
    <hr />
    <div class="setting-item">
      <div class="setting-copy">
        <strong>聚焦行数</strong>
        <span>只清晰显示当前行附近的若干行，其余淡出。</span>
      </div>
      <div class="segmented-control density" role="group" aria-label="歌词聚焦行数">
        <button
          v-for="option in lyricsFocusLineCountOptions"
          :key="option.value"
          type="button"
          :class="{ active: settings.lyricsAppearance.focusLineCount === option.value }"
          @click="updateLyricsAppearance('focusLineCount', option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </div>
    <hr />
    <div class="setting-item">
      <div class="setting-copy">
        <strong>逐字高亮</strong>
        <span>按逐字时间戳显示扫光效果。</span>
      </div>
      <span
        class="toggle-switch"
        :class="{
          active: settings.lyricsAppearance.karaokeEnabled,
          inactive: !settings.lyricsAppearance.karaokeEnabled
        }"
        role="switch"
        :aria-checked="settings.lyricsAppearance.karaokeEnabled"
        @click="updateLyricsAppearance('karaokeEnabled', !settings.lyricsAppearance.karaokeEnabled)"
      ></span>
    </div>
    <hr />
    <div class="setting-item">
      <div class="setting-copy">
        <strong>歌词颜色</strong>
        <span>跟随主题自动取色，或手动指定正文、当前行与扫光颜色。</span>
      </div>
      <div class="segmented-control" role="group" aria-label="歌词颜色来源">
        <button
          type="button"
          :class="{ active: settings.lyricsAppearance.colorMode === 'theme' }"
          @click="updateLyricsAppearance('colorMode', 'theme')"
        >
          跟随主题
        </button>
        <button
          type="button"
          :class="{ active: settings.lyricsAppearance.colorMode === 'custom' }"
          @click="updateLyricsAppearance('colorMode', 'custom')"
        >
          自定义
        </button>
      </div>
    </div>
    <template v-if="settings.lyricsAppearance.colorMode === 'custom'">
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>自定义歌词配色</strong>
          <span>分别指定普通行、当前行和逐字扫光使用的颜色。</span>
        </div>
        <div class="inline-controls">
          <label class="range-pill">
            <span>正文</span>
            <input
              type="color"
              class="color-picker"
              :value="settings.lyricsAppearance.textColor"
              @input="
                updateLyricsAppearance('textColor', ($event.target as HTMLInputElement).value)
              "
            />
          </label>
          <label class="range-pill">
            <span>当前行</span>
            <input
              type="color"
              class="color-picker"
              :value="settings.lyricsAppearance.activeColor"
              @input="
                updateLyricsAppearance('activeColor', ($event.target as HTMLInputElement).value)
              "
            />
          </label>
          <label class="range-pill">
            <span>扫光</span>
            <input
              type="color"
              class="color-picker"
              :value="settings.lyricsAppearance.karaokeColor"
              @input="
                updateLyricsAppearance('karaokeColor', ($event.target as HTMLInputElement).value)
              "
            />
          </label>
        </div>
      </div>
    </template>
    <hr />
    <div class="setting-item">
      <div class="setting-copy">
        <strong>逐层个性化</strong>
        <span>
          分别设置普通、当前、翻译、罗马音四层的字体与字号，以及封面间距、聚焦范围和动效强度。
        </span>
      </div>
      <button type="button" class="soft-button" @click="customizerOpen = true">
        打开歌词个性化
      </button>
    </div>
  </div>
  <Teleport to="body">
    <LyricsAppearanceCustomizer :open="customizerOpen" @close="customizerOpen = false" />
  </Teleport>
</template>
