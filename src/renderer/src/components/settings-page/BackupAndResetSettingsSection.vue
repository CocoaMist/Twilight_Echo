<script setup lang="ts">
import PersonalBackupSection from './PersonalBackupSection.vue'
import type { SettingsResetGroup } from './types.ts'

const emit = defineEmits<{
  exportSettings: []
  importSettings: []
  resetGroup: [group: SettingsResetGroup]
}>()
</script>

<template>
  <div class="section-block">
    <h3>备份与恢复</h3>
    <div class="setting-list">
      <div data-setting-id="settings-backup" id="setting-settings-backup" class="setting-item">
        <div class="setting-copy">
          <strong>设置备份</strong>
          <span>导出当前设置为 JSON，或从备份文件恢复；导入前会二次确认。</span>
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
      <div
        data-setting-id="reset-settings"
        id="setting-reset-settings"
        class="setting-item top-align"
      >
        <div class="setting-copy">
          <strong>按分组恢复默认</strong>
          <span>只重置选中的设置分组，不清空媒体库、插件和本地数据。</span>
        </div>
        <div class="inline-controls reset-group-actions">
          <button type="button" class="muted-button" @click="emit('resetGroup', 'appearance')">
            外观与播放条
          </button>
          <button type="button" class="muted-button" @click="emit('resetGroup', 'playback')">
            播放与音效
          </button>
          <button type="button" class="muted-button" @click="emit('resetGroup', 'lyrics')">
            播放页歌词
          </button>
          <button type="button" class="muted-button" @click="emit('resetGroup', 'desktopLyrics')">
            桌面歌词
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
