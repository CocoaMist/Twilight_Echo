import { ref } from 'vue'
import { createInitialAppUpdateSnapshot } from '../../src/shared/appUpdate.ts'
import { useAppNoticeStore } from '../../src/renderer/src/stores/useAppNoticeStore.ts'

// Disposable preview data. No files, audio devices or IPC are accessed.
const scan = ref({ state: 'running', current: 72, total: 120, error: '' })
const metadata = ref({ state: 'idle', completed: 0, failed: 0, skipped: 0, total: 0, error: '' })
const tracks = ref([])
const update = createInitialAppUpdateSnapshot()
const announce = (message) => useAppNoticeStore().pushNotice({ message: `预览：${message}` })
export const useMusicStore = () => ({
  tracks,
  libraryScanStatus: scan,
  libraryMetadataEnrichmentStatus: metadata,
  pauseLibraryScan: async () => {
    scan.value = { ...scan.value, state: 'paused' }
  },
  resumeLibraryScan: async () => {
    scan.value = { ...scan.value, state: 'running' }
  },
  cancelLibraryScan: async () => {
    scan.value = { ...scan.value, state: 'cancelled' }
  },
  startFullLibraryScan: async () => {
    scan.value = { ...scan.value, state: 'running', current: 0 }
  },
  cancelLibraryMetadataEnrichment: () => {}
})
export const usePlayerStore = () => ({ playTrack: async () => announce('播放本地文件') })

const task = {
  id: 'preview-download',
  providerId: 'preview',
  providerJobId: 'preview',
  track: { id: 'preview-track', title: '示例曲目', artist: '示例艺人', album: '示例专辑' },
  status: 'completed',
  progress: 1,
  targetPath: 'D:/preview/song.flac',
  fileSize: 1024,
  requestedQuality: 'flac',
  actualQuality: 'flac',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
}
export function installPreviewApi() {
  let changed
  window.api = {
    providerDownloads: {
      list: async () => [task],
      onChanged: (handler) => {
        changed = handler
        return () => {
          changed = undefined
        }
      },
      cancel: async () => changed?.([{ ...task, status: 'cancelled' }]),
      retry: async () => changed?.([{ ...task, status: 'downloading', progress: 0.3 }]),
      result: async (_, add) => {
        if (add) announce('加入曲库')
        return task.targetPath
      }
    },
    shell: { showItemInFolder: async () => announce('打开目录') },
    app: { getUpdateState: async () => update, onUpdateState: () => () => {} },
    loudnessAnalysis: {
      getBatch: async () => ({ status: { state: 'idle', revision: 0 } }),
      onBatchProgress: () => () => {}
    }
  }
}
