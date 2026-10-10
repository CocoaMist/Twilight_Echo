import { ref } from 'vue'
import type { ProviderDownloadTaskSnapshot } from '../../../shared/providerDownloads.ts'
import { useAppNoticeStore } from './useAppNoticeStore.ts'

const tasks = ref<ProviderDownloadTaskSnapshot[]>([])
const error = ref('')
let users = 0
let generation = 0
let changes = 0
let stop: (() => void) | undefined
function applyTasks(value: ProviderDownloadTaskSnapshot[], event = false): void {
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
        ? { label: '重新下载', run: () => window.api.providerDownloads.retry(task.id) }
        : undefined,
      presentation: 'center',
      dedupeKey: `download-result:${task.id}`
    })
  }
  tasks.value = value
  error.value = ''
}
export function useDownloadTasks() {
  async function refresh(): Promise<void> {
    const epoch = generation,
      before = changes
    try {
      const value = await window.api.providerDownloads.list()
      if (epoch === generation && changes === before) {
        applyTasks(value)
      }
    } catch {
      if (epoch === generation && changes === before)
        error.value = '下载任务读取失败，请点击重新读取。'
    }
  }
  function connect(): () => void {
    if (++users === 1) {
      const epoch = ++generation
      stop = window.api.providerDownloads.onChanged((value) => {
        if (epoch !== generation) return
        changes++
        applyTasks(value, true)
      })
      void refresh()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--users === 0) {
        generation++
        stop?.()
        stop = undefined
      }
    }
  }
  return { tasks, error, connect, refresh }
}
