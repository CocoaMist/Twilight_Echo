import { ref } from 'vue'
import type { ProviderDownloadTaskSnapshot } from '../../../shared/providerDownloads.ts'

const tasks = ref<ProviderDownloadTaskSnapshot[]>([])
const error = ref('')
let users = 0
let generation = 0
let changes = 0
let stop: (() => void) | undefined
export function useDownloadTasks() {
  async function refresh(): Promise<void> {
    const epoch = generation,
      before = changes
    try {
      const value = await window.api.providerDownloads.list()
      if (epoch === generation && changes === before) {
        tasks.value = value
        error.value = ''
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
        tasks.value = value
        error.value = ''
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
