import type {
  LocalLibraryScanProgress,
  LocalLibraryScanStatus
} from '../../../shared/localLibraryScan.ts'

export function canResumeLocalLibraryScan(status: LocalLibraryScanStatus): boolean {
  if (status.state === 'paused') return true
  return (
    !!status.jobId &&
    !!status.databaseProgress &&
    ['cancelled', 'failed', 'interrupted'].includes(status.databaseProgress.state)
  )
}

export function libraryScanStatusText(
  status: LocalLibraryScanStatus,
  progress?: LocalLibraryScanProgress | null
): string {
  if (status.state === 'failed') return status.error || '后台扫描失败'
  if (status.databaseProgress) {
    switch (status.state) {
      case 'paused':
        return '扫描已暂停，已入库曲目可继续浏览和播放'
      case 'cancelled':
        return '扫描已取消，已入库曲目保留；可继续扫描'
      case 'completed':
        return '检查已完成，曲库已更新'
      case 'running':
        return {
          checking: '正在检查文件变化',
          parsing: '正在读取音频元数据',
          committing: '正在提交扫描结果',
          idle: '正在完成检查'
        }[status.databaseProgress.phase]
    }
  }
  if (status.state === 'paused') return `已暂停：${status.current} / ${status.total || '?'} 项`
  if (status.state === 'running') {
    const phase = progress?.phase === 'parsing' ? '解析元数据' : '检查文件'
    return `${phase}：${status.current} / ${status.total || '?'} 项`
  }
  if (status.state === 'completed')
    return `已完成：解析 ${status.parsedFileCount} 个文件，跳过 ${status.skippedUnchanged} 个未变化文件`
  if (status.state === 'cancelled') return '扫描已取消，未提交未完成的结果'
  return '启动时仅核对 path、size 与 mtime；完整元数据重扫只由此处触发。'
}
