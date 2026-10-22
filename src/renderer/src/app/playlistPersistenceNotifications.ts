import { watch, type Ref } from 'vue'
import type { PlaylistPersistenceStatus } from '../stores/playlistPersistence.ts'
import { useAppNoticeStore } from '../stores/useAppNoticeStore.ts'

/** The global notice owns explicit recovery; ordinary I/O keeps its retry path. */
export function startPlaylistPersistenceNotifications(
  status: Readonly<Ref<PlaylistPersistenceStatus>>,
  reload: () => Promise<void>,
  confirm: (message: string) => boolean = (message) => window.confirm(message)
): () => void {
  const notices = useAppNoticeStore()
  const dedupeKey = 'playlist-save-conflict'
  let disposed = false
  let running = false
  let noticeId: number | null = null

  function present(error?: string): void {
    if (disposed || status.value.canRetry !== false) return
    noticeId = notices.pushNotice({
      kind: 'error',
      dedupeKey,
      sticky: true,
      message: error
        ? `重新读取失败：${error}。未保存的修改仍保留在当前窗口。`
        : `歌单修改未保存：${status.value.lastError || '成员发生冲突'}。自动重试已停止，未保存的修改仍保留在当前窗口。`,
      action: {
        label: '重新读取歌单',
        run: async () => {
          if (disposed || running || status.value.canRetry !== false) return
          if (
            !confirm(
              '重新读取将放弃当前窗口所有尚未保存的歌单修改，并载入已保存版本。确定放弃这些修改吗？'
            )
          ) {
            // A cancelled action remains available in the same notice/history.
            present()
            return
          }
          running = true
          try {
            await reload()
          } catch (error) {
            present(error instanceof Error ? error.message : String(error))
          } finally {
            running = false
          }
        }
      }
    })
  }
  const stop = watch(
    () => status.value.canRetry === false,
    (conflict) => {
      if (conflict) present()
      else if (noticeId !== null) {
        notices.pushNotice({
          kind: 'info',
          dedupeKey,
          message: '歌单已重新读取，保存冲突已解除',
          presentation: 'center'
        })
        noticeId = null
      }
    },
    { immediate: true, flush: 'sync' }
  )
  return () => {
    disposed = true
    stop()
    if (noticeId !== null) notices.dismissNotice(noticeId)
  }
}
