<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useDownloadTasks } from '../stores/useDownloadTasks'
import { useMusicStore } from '../stores/useMusicStore'
import { useAppUpdateStore } from '../stores/useAppUpdateStore'
import { useEscapeToClose, useFocusTrap } from '../app/useDismissLayer'
import DownloadResultActions from './streaming-page/DownloadResultActions.vue'
import { downloadStatusLabel } from './streaming-page/streamingDownloads'
import type { LoudnessBatchStatus } from '../../../shared/libraryLoudness'

const api = window.api
const emit = defineEmits<{ library: [] }>()
function openLibrary() {
  open.value = false
  emit('library')
}
const open = ref(false)
const root = ref<HTMLElement | null>(null)
useFocusTrap(root, () => open.value)
useEscapeToClose(
  () => open.value,
  () => {
    open.value = false
  }
)
const downloads = useDownloadTasks()
const music = useMusicStore()
const update = useAppUpdateStore()
const scan = music.libraryScanStatus
const enrichment = music.libraryMetadataEnrichmentStatus
const loudness = ref<LoudnessBatchStatus | null>(null)
const actionError = ref('')
const pending = ref(new Set<string>())
const filter = ref<'all' | 'active' | 'failed'>('all')
const activeStates = [
  'queued',
  'preparing',
  'downloading',
  'running',
  'enriching',
  'paused',
  'cancelling',
  'resolving',
  'retrying',
  'verifying',
  'installing'
]
const labels: Record<string, string> = {
  idle: '待命',
  enriching: '信息补全中',
  running: '进行中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
  cancelling: '正在取消',
  resolving: '准备更新',
  downloading: '正在下载',
  retrying: '正在重试',
  verifying: '校验中',
  ready: '可以安装',
  installing: '正在安装',
  error: '失败'
}
const jobs = computed(() => {
  const result: {
    id: string
    title: string
    state: string
    detail: string
    value?: number
    cancel?: () => Promise<unknown>
    retry?: () => Promise<unknown>
    pause?: () => Promise<unknown>
    resume?: () => Promise<unknown>
  }[] = []
  const s = scan.value
  if (s.state !== 'idle')
    result.push({
      id: 'scan',
      title: '曲库扫描',
      state: s.state,
      detail: s.error || `${s.current} / ${s.total} 个文件`,
      value: s.total ? s.current / s.total : undefined,
      cancel: ['running', 'enriching', 'paused'].includes(s.state)
        ? music.cancelLibraryScan
        : undefined,
      pause: s.state === 'running' ? music.pauseLibraryScan : undefined,
      resume: s.state === 'paused' ? music.resumeLibraryScan : undefined,
      retry: ['failed', 'cancelled'].includes(s.state) ? music.startFullLibraryScan : undefined
    })
  const m = enrichment.value
  if (m.state !== 'idle')
    result.push({
      id: 'metadata',
      title: '曲目信息补全',
      state: m.state === 'completed' && m.failed > 0 ? 'failed' : m.state,
      detail: m.error || `完成 ${m.completed}，失败 ${m.failed}，跳过 ${m.skipped} / ${m.total}`,
      value: m.total ? (m.completed + m.failed + m.skipped) / m.total : undefined,
      cancel:
        m.state === 'enriching' ? async () => music.cancelLibraryMetadataEnrichment() : undefined
    })
  const l = loudness.value
  if (l && l.state !== 'idle')
    result.push({
      id: 'loudness',
      title: '响度分析',
      state: l.state === 'completed' && l.failed > 0 ? 'failed' : l.state,
      detail: `${l.processed} / ${l.total}，失败 ${l.failed} ${l.currentTitle}`,
      value: l.total ? l.processed / l.total : undefined,
      cancel:
        l.state === 'running' && l.jobId
          ? () => window.api.loudnessAnalysis.cancelBatch(l.jobId!)
          : undefined
    })
  const u = update.state.value.progress
  if (u.phase !== 'idle' || update.state.value.checking)
    result.push({
      id: 'update',
      title: '应用更新',
      state: update.state.value.checking ? 'running' : u.phase,
      detail:
        u.error || u.message || (update.state.value.checking ? '正在检查更新' : u.version || ''),
      value: u.totalBytes ? u.receivedBytes / u.totalBytes : undefined,
      cancel: ['resolving', 'downloading', 'retrying', 'verifying'].includes(u.phase)
        ? update.cancel
        : undefined,
      retry: ['error', 'cancelled'].includes(u.phase) ? update.download : undefined
    })
  return result
})
const activeCount = computed(
  () =>
    jobs.value.filter((j) => activeStates.includes(j.state)).length +
    downloads.tasks.value.filter((t) => activeStates.includes(t.status)).length
)
const visibleJobs = computed(() => jobs.value.filter((j) => matches(j.state)))
const visibleDownloads = computed(() => downloads.tasks.value.filter((t) => matches(t.status)))
function matches(state: string) {
  return (
    filter.value === 'all' ||
    (filter.value === 'active' ? activeStates.includes(state) : ['failed', 'error'].includes(state))
  )
}
async function run(id: string, action: () => Promise<unknown>) {
  if (pending.value.has(id)) return
  pending.value.add(id)
  actionError.value = ''
  try {
    await action()
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : '操作失败，请重试'
  } finally {
    pending.value.delete(id)
  }
}
const stops: (() => void)[] = []
onMounted(() => {
  stops.push(downloads.connect(), update.connect())
  const apply = (s: LoudnessBatchStatus) => {
    if (!loudness.value || s.revision >= loudness.value.revision) loudness.value = s
  }
  stops.push(window.api.loudnessAnalysis.onBatchProgress((e) => apply(e.status)))
  void window.api.loudnessAnalysis
    .getBatch()
    .then((s) => apply(s.status))
    .catch(() => {
      actionError.value = '响度任务读取失败'
    })
})
onUnmounted(() => stops.forEach((stop) => stop()))
</script>

<template>
  <button
    type="button"
    class="task-entry"
    :aria-expanded="open"
    aria-controls="task-center"
    :aria-label="`后台任务（${activeCount} 项进行中）`"
    title="后台任务"
    @click="open = true"
  >
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      aria-hidden="true"
    >
      <path d="m3 6 2 2 3-4M11 6h10M3 13h5m3 0h10M3 20h5m3 0h10" /></svg
    ><span v-if="activeCount">{{ activeCount }}</span>
  </button>
  <Teleport to="body">
    <div v-if="open" class="task-overlay" @click.self="open = false">
      <section
        id="task-center"
        ref="root"
        class="task-center"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-center-title"
        tabindex="-1"
      >
        <header>
          <h2 id="task-center-title">后台任务</h2>
          <button type="button" aria-label="关闭后台任务" @click="open = false">关闭</button>
        </header>
        <label
          >显示
          <select v-model="filter">
            <option value="all">全部</option>
            <option value="active">进行中</option>
            <option value="failed">失败</option>
          </select></label
        >
        <p
          v-if="
            actionError ||
            downloads.error.value ||
            update.error.value ||
            update.connectionError.value
          "
          role="alert"
        >
          {{
            actionError ||
            downloads.error.value ||
            update.error.value ||
            update.connectionError.value
          }}
        </p>
        <button v-if="downloads.error.value" type="button" @click="downloads.refresh">
          重新读取
        </button>
        <p v-if="!visibleJobs.length && !visibleDownloads.length" class="empty">
          暂无符合条件的任务
        </p>
        <article v-for="job in visibleJobs" :key="job.id">
          <strong>{{ job.title }}</strong
          ><span>{{ labels[job.state] || job.state }}</span>
          <p>{{ job.detail }}</p>
          <progress
            v-if="activeStates.includes(job.state)"
            :value="job.value"
            max="1"
            :aria-label="job.title"
          ></progress>
          <div class="actions">
            <button v-if="job.id !== 'update'" type="button" @click="openLibrary">查看曲库</button>
            <button
              v-if="job.pause"
              :disabled="pending.has(job.id)"
              @click="run(job.id, job.pause)"
            >
              暂停</button
            ><button
              v-if="job.resume"
              :disabled="pending.has(job.id)"
              @click="run(job.id, job.resume)"
            >
              继续</button
            ><button
              v-if="job.cancel"
              :disabled="pending.has(job.id)"
              @click="run(job.id, job.cancel)"
            >
              取消</button
            ><button
              v-if="job.retry"
              :disabled="pending.has(job.id)"
              @click="run(job.id, job.retry)"
            >
              重试</button
            ><button
              v-if="job.id === 'update' && job.state === 'ready'"
              :disabled="pending.has(job.id)"
              @click="run(job.id, update.install)"
            >
              安装更新
            </button>
          </div>
        </article>
        <article v-for="task in visibleDownloads" :key="task.id">
          <strong>{{ task.track.title }}</strong
          ><span>{{ downloadStatusLabel(task) }}</span>
          <p>{{ task.track.artist }}</p>
          <progress
            v-if="activeStates.includes(task.status)"
            :value="task.progress"
            max="1"
            aria-label="下载进度"
          ></progress>
          <p v-if="task.error || task.warning">{{ task.error || task.warning }}</p>
          <DownloadResultActions v-if="task.status === 'completed'" :task="task" />
          <div class="actions">
            <button
              v-if="activeStates.includes(task.status)"
              :disabled="pending.has(task.id)"
              @click="run(task.id, () => api.providerDownloads.cancel(task.id))"
            >
              取消</button
            ><button
              v-if="['failed', 'cancelled'].includes(task.status)"
              :disabled="pending.has(task.id)"
              @click="run(task.id, () => api.providerDownloads.retry(task.id))"
            >
              重新下载
            </button>
          </div>
        </article>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.task-entry {
  border: 0;
  background: transparent;
  color: inherit;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px;
  cursor: pointer;
}
.task-overlay {
  position: fixed;
  inset: 0;
  z-index: 1600;
  background: var(--te-dialog-backdrop);
  display: grid;
  place-items: center;
  padding: 24px;
}
.task-center {
  width: min(680px, 100%);
  max-height: 85dvh;
  overflow: auto;
  padding: 24px;
  border-radius: 16px;
  background: var(--te-app-bg);
  color: var(--te-settings-text);
  box-shadow: var(--te-glass-shadow);
}
header,
.actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
header h2 {
  margin: 0;
  font-size: 20px;
}
article {
  padding: 16px 0;
  border-bottom: 1px solid var(--te-card-border);
  overflow-wrap: anywhere;
}
article > span {
  margin-left: 12px;
  font-size: 12px;
}
p {
  font-size: 13px;
  opacity: 0.8;
}
progress {
  width: 100%;
  accent-color: var(--te-primary-500);
}
button,
select {
  font: inherit;
  cursor: pointer;
}
.actions {
  justify-content: flex-end;
  margin-top: 8px;
}
.empty {
  padding: 32px;
  text-align: center;
}
button,
select {
  border: 1px solid var(--te-card-border);
  border-radius: 8px;
  background: var(--te-card-bg);
  color: var(--te-settings-text);
  padding: 7px 12px;
}
button:hover {
  background: var(--te-hover-bg);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button:focus-visible,
select:focus-visible,
input:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}
.task-entry {
  background: transparent;
  border: 0;
  min-height: 32px;
  padding: 10px;
}
</style>
