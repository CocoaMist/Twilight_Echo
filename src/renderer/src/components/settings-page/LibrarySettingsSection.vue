<script setup lang="ts">
import { useSettingsStore } from '../../stores/useSettingsStore'
import DownloadSettingsFields from './DownloadSettingsFields.vue'
import SettingsGroup from './SettingsGroup.vue'
import { ref, watch } from 'vue'
import type { LibraryWatcherStatusSnapshot } from '../../../../shared/localLibraryScan.ts'
import type { BooleanSettingKey } from './types.ts'
const { settings } = useSettingsStore()
const genreSeparatorsDraft = ref(settings.value.genreSeparators)
watch(
  () => settings.value.genreSeparators,
  (value) => {
    genreSeparatorsDraft.value = value
  }
)

defineProps<{
  libraryWatcherStatus: LibraryWatcherStatusSnapshot | null
  libraryScanStatus: { state: string; current: number; total: number }
  libraryScanIsActive: boolean
  libraryScanProgressText: string
  libraryMetadataEnrichmentText: string
  libraryMetadataEnrichmentIsActive: boolean
  libraryMetadataEnrichmentError?: string
  libraryResetMessage: string
  libraryScanCommandError: string
  libraryResetPending: boolean
  addLibraryFolder: () => void
  removeLibraryFolder: (folder: string) => void
  chooseDownloadFolder: () => void
  resetDownloadFolder: () => void
  toggleSetting: (key: BooleanSettingKey) => void
  setGenreSeparators: (event: Event) => void
  watcherStateLabel: (state: string) => string
  watcherModeLabel: (mode: string) => string
  formatWatcherTime: (iso: string | null | undefined) => string
  runFullLibraryScan: () => void
  pauseActiveLibraryScan: () => void
  resumeActiveLibraryScan: () => void
  cancelActiveLibraryScan: () => void
  resetLocalLibrary: () => void
  cancelActiveLibraryMetadataEnrichment: () => void
}>()
</script>
<template>
  <section id="library" class="glass-card preview-section">
    <div class="section-title-row">
      <i class="pi pi-database" aria-hidden="true" />
      <h2>媒体库与存储</h2>
    </div>
    <p class="settings-section-description">管理本地音乐、下载文件与缓存空间。</p>
    <div class="section-block">
      <h3>本地媒体库</h3>
      <div class="setting-list">
        <div
          data-setting-id="library-folders"
          id="setting-library-folders"
          class="setting-item top-align"
        >
          <div class="setting-copy">
            <strong>扫描文件夹</strong>
            <span>添加包含您本地音乐文件的目录。</span>
          </div>
          <div class="folder-list">
            <div v-for="folder in settings.libraryFolders" :key="folder" class="folder-chip">
              <span :title="folder">{{ folder }}</span>
              <i
                class="pi pi-times"
                data-te-interactive
                role="button"
                tabindex="0"
                :aria-label="`移除文件夹 ${folder}`"
                @click="removeLibraryFolder(folder)"
                @keydown.enter.prevent="removeLibraryFolder(folder)"
                @keydown.space.prevent="removeLibraryFolder(folder)"
              ></i>
            </div>
            <div v-if="settings.libraryFolders.length === 0" class="folder-empty-hint">
              暂未添加任何文件夹
            </div>
            <button type="button" class="dashed-button" @click="addLibraryFolder">
              <i class="pi pi-plus"></i>
              添加文件夹
            </button>
          </div>
        </div>
        <hr />
        <div data-setting-id="watch-library" id="setting-watch-library" class="setting-item">
          <div class="setting-copy">
            <strong>实时监控文件夹变动</strong>
            <span>当添加新音乐时自动同步到媒体库，无需手动刷新。</span>
          </div>
          <button
            type="button"
            class="toggle-switch"
            :class="{ active: settings.watchLibrary, inactive: !settings.watchLibrary }"
            role="switch"
            aria-label="实时监控文件夹变动"
            :aria-checked="settings.watchLibrary"
            @click="toggleSetting('watchLibrary')"
          ></button>
        </div>
      </div>
    </div>
    <SettingsGroup
      id="scan-diagnostics"
      title="扫描与诊断"
      :summary="
        libraryScanIsActive || libraryMetadataEnrichmentIsActive
          ? libraryScanProgressText + ' · ' + libraryMetadataEnrichmentText
          : settings.libraryFolders.length + ' 个扫描目录'
      "
      :attention="
        libraryScanCommandError ||
        libraryResetMessage ||
        (libraryScanStatus.state === 'failed' ? libraryScanProgressText : '') ||
        libraryMetadataEnrichmentError ||
        libraryWatcherStatus?.folders.find((folder) => folder.lastError)?.lastError ||
        ''
      "
      ><div class="setting-list">
        <div data-setting-id="genre-separators" id="setting-genre-separators" class="setting-item">
          <div class="setting-copy">
            <strong>流派分隔符</strong>
            <span>将标签中的多个字符识别为不同流派；默认支持 ,，;；、/。</span>
          </div>
          <input
            class="preview-select"
            type="text"
            maxlength="32"
            :value="genreSeparatorsDraft"
            aria-label="流派分隔符"
            placeholder=",，;；、/"
            @input="genreSeparatorsDraft = ($event.target as HTMLInputElement).value"
            @change="setGenreSeparators"
          />
        </div>
        <hr />
        <div
          data-setting-id="watcher-status"
          id="setting-watcher-status"
          v-if="settings.libraryFolders.length > 0"
          class="setting-item top-align watcher-status-panel"
        >
          <div class="setting-copy">
            <strong>媒体库监控状态</strong>
            <span>各根目录的监听状态；Linux 或失败时会自动降级为定时对账扫描。</span>
          </div>
          <div class="watcher-status-list" aria-live="polite">
            <div
              v-for="item in libraryWatcherStatus?.folders ??
              settings.libraryFolders.map((folder) => ({
                folder,
                state: settings.watchLibrary ? 'failed' : 'disabled',
                mode: 'none',
                lastError: null,
                lastEventAt: null,
                lastReconcileAt: null
              }))"
              :key="item.folder"
              class="watcher-status-row"
            >
              <span class="watcher-status-path" :title="item.folder">{{ item.folder }}</span>
              <span class="watcher-status-badge" :data-state="item.state">
                {{ watcherStateLabel(item.state) }}
                · {{ watcherModeLabel(item.mode) }}
              </span>
              <span class="watcher-status-times">
                事件 {{ formatWatcherTime(item.lastEventAt) }} · 对账
                {{ formatWatcherTime(item.lastReconcileAt) }}
              </span>
              <span v-if="item.lastError" class="watcher-status-error">{{ item.lastError }}</span>
            </div>
          </div>
        </div>
        <hr />
        <div
          data-setting-id="library-rescan"
          id="setting-library-rescan"
          class="setting-item top-align"
        >
          <div class="setting-copy">
            <strong>完整重扫</strong>
            <span
              >显式重新解析全部本地文件的 metadata 与封面；可暂停或取消。同目录 CUE：单音频 + 唯一
              `.cue`，≤2 MiB，UTF-8/GBK/GB18030。</span
            >
          </div>
          <div class="library-scan-panel" aria-live="polite">
            <progress
              v-if="libraryScanIsActive"
              class="library-scan-progress"
              :value="libraryScanStatus.total > 0 ? libraryScanStatus.current : undefined"
              :max="libraryScanStatus.total > 0 ? libraryScanStatus.total : 1"
            ></progress>
            <span class="library-scan-copy">{{ libraryScanProgressText }}</span>
            <span class="library-scan-copy">{{ libraryMetadataEnrichmentText }}</span>
            <span v-if="libraryResetMessage" class="library-scan-copy success-copy">
              {{ libraryResetMessage }}
            </span>
            <span v-if="libraryScanCommandError" class="library-scan-error">
              {{ libraryScanCommandError }}
            </span>
            <div class="library-scan-actions">
              <button
                type="button"
                class="brand-soft-button"
                :disabled="libraryScanIsActive"
                @click="runFullLibraryScan"
              >
                完整重扫
              </button>
              <button
                v-if="libraryScanStatus.state === 'running'"
                type="button"
                class="soft-button"
                @click="pauseActiveLibraryScan"
              >
                暂停
              </button>
              <button
                v-if="libraryScanStatus.state === 'paused'"
                type="button"
                class="soft-button"
                @click="resumeActiveLibraryScan"
              >
                继续
              </button>
              <button
                v-if="libraryScanIsActive"
                type="button"
                class="danger-soft-button"
                @click="cancelActiveLibraryScan"
              >
                取消
              </button>
              <button
                type="button"
                class="danger-soft-button"
                data-testid="settings-library-reset"
                :disabled="libraryScanIsActive || libraryResetPending"
                @click="resetLocalLibrary"
              >
                {{ libraryResetPending ? '重置中…' : '重置库' }}
              </button>
              <button
                v-if="libraryMetadataEnrichmentIsActive"
                type="button"
                class="soft-button"
                title="丢弃队列中的富化；已发出的 Provider 请求可能仍会完成但不会写回"
                @click="cancelActiveLibraryMetadataEnrichment"
              >
                取消富化
              </button>
            </div>
          </div>
        </div>
      </div></SettingsGroup
    >
    <div class="section-block">
      <h3>下载到本地</h3>
      <div class="setting-list">
        <div
          data-setting-id="download-directory"
          id="setting-download-directory"
          class="setting-item top-align"
        >
          <div class="setting-copy">
            <strong>下载目录</strong>
            <span>
              流媒体「下载到本地」的保存位置；留空时沿用第一个扫描文件夹。选在扫描文件夹之外时，下载完成的文件不会自动进入媒体库。
            </span>
          </div>
          <div class="path-control">
            <input
              readonly
              aria-label="下载目录"
              :value="settings.downloadFolder || '跟随扫描文件夹'"
            />
            <button type="button" class="soft-button" @click="chooseDownloadFolder">
              选择文件夹
            </button>
            <button
              v-if="settings.downloadFolder"
              type="button"
              class="muted-button"
              @click="resetDownloadFolder"
            >
              清除
            </button>
          </div>
        </div>
        <DownloadSettingsFields />
      </div>
    </div>
    <slot />
  </section>
</template>
