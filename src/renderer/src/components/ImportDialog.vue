<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useEscapeToClose, useFocusTrap } from '../app/useDismissLayer.ts'
import { useMusicStore } from '../stores/useMusicStore'
import { useSettingsStore } from '../stores/useSettingsStore'
import {
  canResumeLocalLibraryScan,
  libraryScanStatusText
} from '../utils/libraryScanPresentation.ts'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ close: [] }>()
const musicStore = useMusicStore()
const { settings, loaded: settingsLoaded, removeLibraryFolder } = useSettingsStore()
const selectedFolders = ref<Set<string>>(new Set())
const scanError = ref('')
const dialogRef = ref<HTMLElement | null>(null)
const choosingFolder = ref(false)
const newlyAddedFolders = ref<string[]>([])
const databaseRequestPending = ref(false)
const controlPending = ref(false)
const databaseStatus = computed(() => musicStore.libraryScanStatus.value)
const databaseScanActive = computed(() =>
  ['running', 'paused'].includes(databaseStatus.value.state)
)
const busy = computed(
  () =>
    !settingsLoaded.value ||
    choosingFolder.value ||
    controlPending.value ||
    databaseRequestPending.value ||
    databaseScanActive.value
)
const closeDisabled = computed(() => choosingFolder.value)
const databaseStatusText = computed(() => libraryScanStatusText(databaseStatus.value))
const canContinue = computed(() => canResumeLocalLibraryScan(databaseStatus.value))
const availableFolders = computed(() => [
  ...new Set([...settings.value.libraryFolders, ...newlyAddedFolders.value])
])

function close(): void {
  if (!closeDisabled.value) emit('close')
}
useEscapeToClose(() => props.show, close)
useFocusTrap(dialogRef, () => props.show)
watch(
  () => props.show,
  (show) => {
    if (!show) return
    newlyAddedFolders.value = []
    selectedFolders.value = new Set(availableFolders.value)
    scanError.value = ''
  },
  { immediate: true }
)
watch(availableFolders, (folders) => {
  const available = new Set(folders)
  selectedFolders.value = new Set([...selectedFolders.value].filter((path) => available.has(path)))
})
async function handleAddNewFolder(): Promise<void> {
  if (busy.value) return
  choosingFolder.value = true
  scanError.value = ''
  try {
    const path = await window.api.dialog.openFolder()
    if (path) {
      if (!availableFolders.value.includes(path)) newlyAddedFolders.value.push(path)
      selectedFolders.value.add(path)
    }
  } catch (error) {
    scanError.value = `选择文件夹失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    choosingFolder.value = false
  }
}
async function handleRemoveFolder(path: string): Promise<void> {
  if (busy.value) return
  choosingFolder.value = true
  scanError.value = ''
  try {
    await removeLibraryFolder(path)
    selectedFolders.value.delete(path)
    newlyAddedFolders.value = newlyAddedFolders.value.filter((folder) => folder !== path)
  } catch (error) {
    scanError.value = `移除文件夹失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    choosingFolder.value = false
  }
}
function toggleFolder(path: string): void {
  if (selectedFolders.value.has(path)) selectedFolders.value.delete(path)
  else selectedFolders.value.add(path)
}
async function startScan(): Promise<void> {
  if (busy.value) return
  const foldersToScan = [...selectedFolders.value]
  if (!foldersToScan.length) {
    scanError.value = '请先选择要扫描的文件夹。'
    return
  }
  databaseRequestPending.value = true
  scanError.value = ''
  try {
    await musicStore.scanLibraryDirectories({ directories: foldersToScan, reason: 'import' })
    newlyAddedFolders.value = []
  } catch (error) {
    scanError.value = `目录检查未完成：${error instanceof Error ? error.message : String(error)}。已提交曲目保留。`
  } finally {
    databaseRequestPending.value = false
  }
}
async function controlScan(command: 'pause' | 'resume' | 'cancel'): Promise<void> {
  if (controlPending.value) return
  controlPending.value = true
  scanError.value = ''
  try {
    const accepted = await {
      pause: musicStore.pauseLibraryScan,
      resume: musicStore.resumeLibraryScan,
      cancel: musicStore.cancelLibraryScan
    }[command]()
    if (!accepted) scanError.value = '扫描状态已变化，请按当前状态重新操作。'
  } catch (error) {
    scanError.value = `扫描操作失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    controlPending.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="show" class="modal-overlay" @click.self="close">
        <div
          ref="dialogRef"
          class="import-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="import-dialog-title"
          tabindex="-1"
          :aria-busy="busy"
        >
          <div class="dialog-header">
            <h3 id="import-dialog-title">导入本地音乐</h3>
            <button
              type="button"
              class="btn-close"
              aria-label="关闭导入窗口"
              :disabled="closeDisabled"
              @click="close"
            >
              <i class="pi pi-times" aria-hidden="true"></i>
            </button>
          </div>

          <div class="dialog-content">
            <div class="folder-list-section">
              <div class="section-header">
                <span class="section-title">已选文件夹</span>
              </div>

              <div class="folder-list">
                <div v-if="availableFolders.length === 0" class="empty-folders">
                  暂无文件夹，请点击下方按钮添加
                </div>
                <div v-for="(folder, index) in availableFolders" :key="folder" class="folder-item">
                  <i class="pi pi-folder"></i>
                  <label class="folder-path" :for="`import-folder-${index}`" :title="folder">{{
                    folder
                  }}</label>
                  <input
                    :id="`import-folder-${index}`"
                    type="checkbox"
                    :checked="selectedFolders.has(folder)"
                    :disabled="busy"
                    :aria-label="`扫描文件夹 ${folder}`"
                    @change="toggleFolder(folder)"
                  />
                  <button
                    type="button"
                    class="btn-remove-folder"
                    :disabled="busy"
                    :aria-label="`移除文件夹 ${folder}`"
                    title="移除文件夹记录"
                    @click="handleRemoveFolder(folder)"
                  >
                    <i class="pi pi-times" aria-hidden="true"></i>
                  </button>
                </div>
              </div>
            </div>

            <p v-if="scanError" class="scan-error" role="alert">{{ scanError }}</p>
            <div class="scan-status-slot" role="status" aria-live="polite">
              <Transition name="scan-status">
                <div key="database" class="progress-section">
                  <p>
                    {{
                      databaseRequestPending && !databaseStatus.jobId
                        ? '正在准备目录检查'
                        : databaseStatusText
                    }}
                  </p>
                  <progress
                    v-if="databaseScanActive || databaseRequestPending"
                    aria-label="目录检查进度"
                  />
                  <dl
                    v-if="databaseStatus.databaseProgress"
                    class="database-counters"
                    aria-label="已确认的扫描统计"
                  >
                    <div>
                      <dt>检查文件</dt>
                      <dd>
                        {{ databaseStatus.databaseProgress.checkedFiles.toLocaleString() }} 个
                      </dd>
                    </div>
                    <div>
                      <dt>解析元数据</dt>
                      <dd>
                        {{ databaseStatus.databaseProgress.parsedFiles.toLocaleString() }} 个文件
                      </dd>
                    </div>
                    <div>
                      <dt>已入库曲目</dt>
                      <dd>{{ databaseStatus.databaseProgress.trackCount.toLocaleString() }} 首</dd>
                    </div>
                    <div>
                      <dt>失败文件</dt>
                      <dd>{{ databaseStatus.databaseProgress.failedFiles.toLocaleString() }} 个</dd>
                    </div>
                  </dl>
                  <p class="scan-scope-note">
                    已入库曲目为整个曲库的当前总数。可关闭窗口，扫描会在后台继续。
                  </p>
                  <p v-if="canContinue && !databaseScanActive" class="scan-scope-note">
                    “继续扫描”沿用原任务范围；“检查并导入”会开始所选目录的新任务。
                  </p>
                  <div class="scan-controls">
                    <button
                      v-if="databaseStatus.state === 'running'"
                      type="button"
                      class="btn-cancel"
                      :disabled="controlPending"
                      @click="controlScan('pause')"
                    >
                      暂停
                    </button>
                    <button
                      v-if="canContinue"
                      type="button"
                      class="btn-cancel"
                      :disabled="controlPending"
                      @click="controlScan('resume')"
                    >
                      继续扫描
                    </button>
                    <button
                      v-if="databaseScanActive || databaseRequestPending"
                      type="button"
                      class="btn-cancel"
                      :disabled="controlPending"
                      @click="controlScan('cancel')"
                    >
                      取消扫描
                    </button>
                  </div>
                </div>
              </Transition>
            </div>
          </div>

          <div class="dialog-footer">
            <button type="button" class="btn-cancel" :disabled="busy" @click="handleAddNewFolder">
              添加文件夹
            </button>
            <button
              type="button"
              class="btn-start"
              :disabled="busy || selectedFolders.size === 0"
              @click="startScan"
            >
              检查并导入所选文件夹
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.database-counters {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin: 16px 0;
}
.database-counters dt,
.scan-scope-note {
  color: var(--te-neutral-600);
}
.database-counters dd {
  margin: 4px 0 0;
  font-variant-numeric: tabular-nums;
}
.scan-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.progress-section progress {
  width: 100%;
}
.progress-section p {
  margin: 0 0 12px;
}
.dialog-footer {
  flex-wrap: wrap;
}
.scan-status-slot {
  display: grid;
}

.scan-status-slot > div {
  grid-area: 1 / 1;
}

.scan-status-enter-active,
.scan-status-leave-active {
  transition: opacity var(--te-motion-hover) var(--te-ease-soft);
}

.scan-status-enter-from,
.scan-status-leave-to {
  opacity: 0;
}

html[data-te-motion='reduced'] .scan-status-enter-active,
html[data-te-motion='reduced'] .scan-status-leave-active {
  transition: opacity 120ms var(--te-ease-soft) !important;
}

html[data-te-motion='off'] .scan-status-enter-from,
html[data-te-motion='off'] .scan-status-leave-to {
  opacity: 1 !important;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background:
    radial-gradient(circle at 30% 18%, rgba(124, 77, 255, 0.18), transparent 34%),
    radial-gradient(circle at 72% 78%, rgba(34, 211, 238, 0.12), transparent 36%),
    rgba(17, 24, 39, 0.18);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
  padding: 24px;
  backdrop-filter: blur(8px) saturate(125%);
  -webkit-backdrop-filter: blur(8px) saturate(125%);
}

.import-dialog {
  width: min(520px, calc(100vw - 48px));
  max-height: calc(100dvh - 48px);
  background:
    linear-gradient(145deg, rgba(255, 255, 255, 0.7), rgba(248, 245, 255, 0.46)),
    rgba(255, 255, 255, 0.52);
  border-radius: var(--te-dialog-radius);
  box-shadow:
    0 28px 90px rgba(86, 70, 160, 0.24),
    inset 0 1px 0 rgba(255, 255, 255, 0.7);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.68);
  backdrop-filter: blur(24px) saturate(155%);
  -webkit-backdrop-filter: blur(24px) saturate(155%);
  animation: import-dialog-in 0.32s var(--te-ease-soft) both;
}

.dialog-header {
  padding: 8px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 24px;
}

.dialog-header h3 {
  margin: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 18 / 14);
  font-weight: 600;
  color: var(--te-neutral-900);
}

.scan-error {
  color: var(--te-danger-600, #d14343);
}

.btn-close {
  background: none;
  border: none;
  cursor: pointer;
  color: #999;
  font-size: calc(var(--te-font-size-body, 14px) * 16 / 14);
  padding: 4px;
}

.dialog-content {
  padding: 20px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.section-title {
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
  font-weight: 700;
  color: var(--te-neutral-900);
}

.btn-add-folder {
  background: #f0f7ff;
  color: #1a73e8;
  border: 1px solid #c2e0ff;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: background-color 0.15s var(--te-ease-soft);
}

.btn-add-folder:hover {
  background: #e1efff;
}

.folder-list {
  background: var(--te-subtle-bg);
  border: 1px solid rgba(255, 255, 255, 0.58);
  border-radius: 14px;
  max-height: 200px;
  overflow-y: auto;
  margin-bottom: 20px;
}

.empty-folders {
  padding: 32px;
  text-align: center;
  color: #999;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
}

.folder-item {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  gap: 10px;
  border-bottom: 1px solid rgba(229, 231, 235, 0.52);
}

.folder-item:last-child {
  border-bottom: none;
}

.folder-path {
  flex: 1;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  color: #333;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.btn-remove-folder {
  background: none;
  border: none;
  cursor: pointer;
  color: #ccc;
  padding: 4px;
  transition: color 0.15s;
}

.btn-remove-folder:hover {
  color: #ff4d4f;
}

.options-section {
  margin-bottom: 20px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  color: #666;
  cursor: pointer;
}

.progress-section {
  background: rgba(124, 77, 255, 0.1);
  padding: 12px;
  border-radius: 14px;
  margin-top: 10px;
}

.progress-info {
  display: flex;
  justify-content: space-between;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  color: var(--te-primary-500);
  margin-bottom: 8px;
}

.progress-bar-bg {
  height: 6px;
  background: rgba(124, 77, 255, 0.14);
  border-radius: 999px;
  overflow: hidden;
}

.progress-bar-fill {
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, var(--te-primary-500), var(--te-primary-300));
  transform: scaleX(0);
  transform-origin: 0 50%;
  transition: transform 0.3s ease;
}

.empty-result {
  margin-top: 10px;
  padding: 12px 16px;
  background: var(--te-warning-soft-bg);
  border: 1px solid rgba(255, 180, 80, 0.24);
  border-radius: 14px;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  color: #b8780d;
  text-align: center;
}

.dialog-footer {
  padding: 16px 20px;
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.btn-cancel {
  background: var(--te-subtle-bg);
  border: 1px solid rgba(255, 255, 255, 0.62);
  padding: 8px 16px;
  border-radius: 12px;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
  cursor: pointer;
  color: #666;
}

.btn-start {
  background: linear-gradient(135deg, var(--te-primary-500), var(--te-primary-300));
  border: none;
  padding: 8px 24px;
  border-radius: 12px;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
  cursor: pointer;
  color: #fff;
  font-weight: 500;
  box-shadow: 0 12px 30px rgba(124, 77, 255, 0.24);
}

.btn-start:disabled {
  background: rgba(168, 133, 247, 0.36);
  cursor: not-allowed;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@keyframes import-dialog-in {
  from {
    opacity: 0;
    transform: translateY(16px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
</style>
