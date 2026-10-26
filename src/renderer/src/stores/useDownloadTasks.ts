import { ref, watch } from 'vue'
import type { CoreDownloadTask } from '../../../shared/coreDownloads.ts'
import { useCoreConnection } from './coreConnection.ts'
import { useAppNoticeStore } from './useAppNoticeStore.ts'

const tasks = ref<CoreDownloadTask[]>([])
const error = ref('')
let users = 0
let stopWatching: (() => void) | undefined
let request = 0
let hasSnapshot = false
let lastRevision: number | null = null
function applyTasks(value: CoreDownloadTask[], event: boolean, core: ReturnType<typeof useCoreConnection>): void {
  const notices = useAppNoticeStore()
  const previous = new Map(tasks.value.map((task) => [task.id, task.status]))
  for (const task of value) {
    const before = previous.get(task.id)
    if (!['completed', 'failed', 'cancelled'].includes(task.status)) {
      const old = notices.noticeHistory.value.find((item) => item.downloadTaskId === task.id)
      if (old) old.action = undefined
    }
    if (
      (!before && !event) ||
      before === task.status ||
      !['completed', 'failed', 'cancelled'].includes(task.status)
    )
      continue
    notices.pushNotice({
      kind: task.status === 'failed' ? 'error' : task.status === 'completed' ? 'success' : 'info',
      message: `${task.track.title}：${task.status === 'completed' ? '下载完成' : task.status === 'failed' ? '下载失败' : '已取消下载'}${task.error || task.warning ? ` · ${task.error || task.warning}` : ''}`,
      downloadTaskId: task.id,
      fresh: true,
      action: ['failed', 'cancelled'].includes(task.status)
        ? { label: '重新下载', run: () => core.command('downloads.retry', { id: task.id }) }
        : undefined,
      presentation: 'center',
      dedupeKey: `download-result:${task.id}`
    })
  }
  tasks.value = value
  error.value = ''
}
export function useDownloadTasks() {
  const core = useCoreConnection()
  async function refresh(): Promise<void> {
    const currentRequest = ++request
    try {
      const snapshot = core.state.value ?? (await core.attach())
      const revision = snapshot.downloads?.revision
      if (revision == null) return
      const page = await core.query('downloads.page', { revision, limit: 200 })
      if (currentRequest === request && core.state.value?.downloads?.revision === page.revision) {
        applyTasks(page.items, hasSnapshot || (lastRevision !== null && page.revision !== lastRevision), core)
        hasSnapshot = true
        lastRevision = page.revision
      }
    } catch {
      if (currentRequest === request)
        error.value = '下载任务读取失败，请点击重新读取。'
    }
  }
  function connect(): () => void {
    if (++users === 1) {
      const observe = () => {
        lastRevision = core.state.value?.downloads?.revision ?? null
        stopWatching = watch(
          () => core.state.value?.downloads?.revision,
          () => void refresh()
        )
        void refresh()
      }
      if (core.state.value) observe()
      else void core.attach().then(observe).catch(() => {
          error.value = '下载任务读取失败，请点击重新读取。'
        })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--users === 0) {
        request++
        stopWatching?.()
        stopWatching = undefined
      }
    }
  }
  return { tasks, error, connect, refresh }
}
