import type { CoreDownloadTask } from '../../../../shared/coreDownloads.ts'

export function filterActiveDownloadTasks(
  tasks: CoreDownloadTask[]
): CoreDownloadTask[] {
  return tasks.filter((task) => task.status !== 'completed' && task.status !== 'cancelled')
}

export function formatDownloadProgress(value: number): string {
  return `${Math.round(value * 100)}%`
}

export function downloadStatusLabel(task: CoreDownloadTask): string {
  switch (task.status) {
    case 'queued':
      return task.queuePosition != null ? `排队中 #${task.queuePosition}` : '排队中'
    case 'preparing':
      return '准备中'
    case 'downloading':
      return `下载中 ${formatDownloadProgress(task.progress)}`
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    default:
      return '未知状态'
  }
}
