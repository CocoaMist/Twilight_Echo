<script setup lang="ts">
import PersonalBackupSection from './PersonalBackupSection.vue'
type SettingsGroup = 'appearance' | 'playback' | 'desktopLyrics'

const emit = defineEmits<{
  exportSettings: []
  importSettings: []
  resetGroup: [group: SettingsGroup]
}>()
</script>

<template>
  <div class="section-block">
    <h3>备份与恢复</h3>
    <div class="setting-list">
      <div class="setting-item">
        <div class="setting-copy">
          <strong>设置备份</strong>
          <span
            >保存或恢复应用设置，不包含歌曲文件和个人曲库数据。导入会覆盖当前设置，并要求确认。</span
          >
        </div>
        <div class="inline-controls">
          <button type="button" class="soft-button" @click="emit('exportSettings')">
            <i class="pi pi-download"></i>
            导出
          </button>
          <button type="button" class="soft-button" @click="emit('importSettings')">
            <i class="pi pi-upload"></i>
            导入
          </button>
        </div>
      </div>
      <hr />
      <PersonalBackupSection />
      <hr />
      <div class="setting-item top-align">
        <div class="setting-copy">
          <strong>按分组恢复默认</strong>
          <span>只重置选中的设置分组，不清空媒体库、插件和本地数据。</span>
        </div>
        <div class="inline-controls reset-group-actions">
          <button type="button" class="muted-button" @click="emit('resetGroup', 'appearance')">
            恢复外观默认
          </button>
          <button type="button" class="muted-button" @click="emit('resetGroup', 'playback')">
            恢复播放默认
          </button>
          <button type="button" class="muted-button" @click="emit('resetGroup', 'desktopLyrics')">
            恢复桌面歌词默认
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
