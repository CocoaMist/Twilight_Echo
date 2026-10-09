import { watch } from 'vue'
import { useAppUpdateStore } from '../stores/useAppUpdateStore.ts'
import { useAppNoticeStore } from '../stores/useAppNoticeStore.ts'

export function startAppUpdateNotifications(openUpdates: () => void): () => void {
  const updates = useAppUpdateStore()
  const notices = useAppNoticeStore()
  let shown: string | null = null
  let noticeId: number | null = null
  const stop = watch(
    () => updates.state.value.notice,
    (notice) => {
      if (!notice) {
        if (noticeId) notices.dismissNotice(noticeId)
        noticeId = null
        return
      }
      if (notice.id === shown) return
      shown = notice.id
      // A new reminder after a snooze is intentional, even when its text is unchanged.
      notices.releaseNoticeDedupe('app-update')
      noticeId = notices.pushNotice({
        kind: notice.kind === 'installed' ? 'success' : 'info',
        message:
          notice.kind === 'installed'
            ? `已更新至 v${notice.version}`
            : notice.kind === 'ready'
              ? `v${notice.version} 更新包已就绪，可在设置中安装`
              : `发现新版本 v${notice.version}`,
        dedupeKey: 'app-update',
        fresh: true,
        presentation: notice.kind === 'ready' ? 'toast' : 'center',
        action: { label: '查看更新', run: openUpdates }
      })
    },
    { immediate: true }
  )
  const disconnect = updates.connect()
  return () => {
    stop()
    disconnect()
  }
}
