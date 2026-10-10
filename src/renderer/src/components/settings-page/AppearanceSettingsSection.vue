<script setup lang="ts">
import { onMounted } from 'vue'
import { useLyricsFontPicker } from '@renderer/composables/useLyricsFontPicker'
import MiniPlayerSettingsSection from './MiniPlayerSettingsSection.vue'
import ThemeControlsSettings from './ThemeControlsSettings.vue'
import BackgroundEditorSettings from './BackgroundEditorSettings.vue'
import FontRenderingSettings from './FontRenderingSettings.vue'
import WindowTransparencySettings from './WindowTransparencySettings.vue'
import SettingsGroup from './SettingsGroup.vue'
import PlayerBarSettings from './PlayerBarSettings.vue'
import PlayerBarLayoutSettings from './PlayerBarLayoutSettings.vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { fontFamilyOptions, uiDensityOptions, type BooleanSettingKey } from './types.ts'
import { normalizeAppFontFamily } from '../../../../shared/appFont.ts'
import type { AppSettings, UiDensity } from '../../types/settings'

const emit = defineEmits<{
  openThemeStudio: []
  openThemeWorkshop: []
}>()

const { settings, updateSettings } = useSettingsStore()
const { installed, load: loadFonts } = useLyricsFontPicker()
onMounted(loadFonts)

function setFontFamily(event: Event): void {
  const fontFamily = normalizeAppFontFamily((event.target as HTMLSelectElement).value)
  if (settings.value.fontFamily === fontFamily) return
  void updateSettings({ fontFamily })
}

function setUiDensity(density: UiDensity): void {
  if (settings.value.uiDensity === density) return
  void updateSettings({ uiDensity: density })
}

function toggleSetting(key: BooleanSettingKey): void {
  void updateSettings({ [key]: !settings.value[key] } as Partial<AppSettings>)
}
</script>

<template>
  <section id="appearance" class="glass-card preview-section">
    <div class="section-title-row">
      <i class="pi pi-palette"></i>
      <h2>外观</h2>
    </div>

    <p class="settings-section-description">搭配主题、文字与播放器，让界面适合你的使用习惯。</p>
    <div class="section-block">
      <h3>主题与配色</h3>
      <div class="setting-list">
        <ThemeControlsSettings
          @open-theme-studio="emit('openThemeStudio')"
          @open-theme-workshop="emit('openThemeWorkshop')"
        />
      </div>
    </div>
    <div class="section-block">
      <h3>背景与材质</h3>
      <div class="setting-list">
        <BackgroundEditorSettings />
        <hr />
        <div data-setting-id="cover-theme" id="setting-cover-theme" class="setting-item">
          <div class="setting-copy">
            <strong>封面主题色</strong>
            <span>播放页和底栏使用当前专辑封面提取的主题色。</span>
          </div>
          <button
            type="button"
            aria-label="封面主题色"
            class="toggle-switch"
            :class="{ active: settings.useCoverTheme, inactive: !settings.useCoverTheme }"
            role="switch"
            :aria-checked="settings.useCoverTheme"
            @click="toggleSetting('useCoverTheme')"
          ></button>
        </div>
        <WindowTransparencySettings />
      </div>
    </div>
    <div class="section-block">
      <h3>文字与排版</h3>
      <div class="setting-list">
        <div data-setting-id="global-font" id="setting-global-font" class="setting-item">
          <div class="setting-copy">
            <strong>界面字体</strong>
            <span>更换界面的正文、标题与圆体字体；“默认”跟随当前主题自带的字体。</span>
          </div>
          <select class="preview-select wide" :value="settings.fontFamily" @change="setFontFamily">
            <option v-for="option in fontFamilyOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
            <optgroup label="系统已安装字体">
              <option v-for="family in installed" :key="family" :value="`local:${family}`">
                {{ family }}
              </option>
            </optgroup>
          </select>
        </div>
        <hr />
        <FontRenderingSettings />
        <hr />
        <div data-setting-id="ui-density" id="setting-ui-density" class="setting-item">
          <div class="setting-copy">
            <strong>界面密度</strong>
            <span>控制列表项的间距与信息密度。</span>
          </div>
          <div class="segmented-control density">
            <button
              v-for="option in uiDensityOptions"
              :key="option.value"
              type="button"
              :class="{ active: settings.uiDensity === option.value }"
              @click="setUiDensity(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
      </div>
    </div>
    <SettingsGroup
      id="player-bar"
      title="播放条"
      :summary="
        '形态：' +
        { standard: '标准', mini: '迷你', compact: '紧凑' }[settings.playerBar.mode] +
        ' · ' +
        { visible: '常显', autoHide: '自动隐藏', hidden: '完全隐藏' }[settings.playerBar.visibility]
      "
      initially-open
    >
      <div class="setting-list">
        <PlayerBarSettings />
        <div
          data-setting-id="compact-visualizer"
          id="setting-compact-visualizer"
          class="setting-item"
        >
          <div class="setting-copy">
            <strong>歌词页底部动态频谱</strong
            ><span>显示播放条上的动态频谱；关闭时停止频谱数据轮询。</span>
          </div>
          <button
            type="button"
            class="toggle-switch"
            role="switch"
            aria-label="歌词页底部动态频谱"
            :aria-checked="settings.playerBar.compactVisualizerEnabled"
            :class="{ active: settings.playerBar.compactVisualizerEnabled }"
            @click="
              updateSettings({
                playerBar: {
                  ...settings.playerBar,
                  compactVisualizerEnabled: !settings.playerBar.compactVisualizerEnabled
                }
              })
            "
          />
        </div>
        <PlayerBarLayoutSettings />
      </div>
    </SettingsGroup>
    <MiniPlayerSettingsSection />
  </section>
</template>
