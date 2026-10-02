import { ref } from 'vue'

export type AppNoticeKind = 'info' | 'success' | 'warning' | 'error'

export type AppNoticeAction = {
  label: string
  run: () => void
}

export type AppNotice = {
  id: number
  kind: AppNoticeKind
  message: string
  action?: AppNoticeAction
  sticky?: boolean
  dedupeKey?: string
}

const notices = ref<AppNotice[]>([])
let nextNoticeId = 1
const dismissTimers = new Map<number, ReturnType<typeof setTimeout>>()
// A dedupe key the user explicitly closed, mapped to the exact message they
// closed. A repeat of that same message stays suppressed — an event source that
// re-fires on a poll interval must not be able to out-click the user. A changed
// message is new information, so it releases the suppression.
const suppressedDedupeMessages = new Map<string, string>()

function clearDismissTimer(id: number): void {
  const timer = dismissTimers.get(id)
  if (timer == null) return
  clearTimeout(timer)
  dismissTimers.delete(id)
}

function scheduleAutoDismiss(notice: AppNotice, durationMs?: number): void {
  clearDismissTimer(notice.id)
  if (notice.sticky) return
  const delayMs = Math.max(2500, durationMs ?? 6000)
  dismissTimers.set(
    notice.id,
    setTimeout(() => {
      clearDismissTimer(notice.id)
      notices.value = notices.value.filter((item) => item.id !== notice.id)
    }, delayMs)
  )
}

export function useAppNoticeStore() {
  /** Closing a deduped notice suppresses that exact message until it changes. */
  function dismissNotice(id: number): void {
    const notice = notices.value.find((item) => item.id === id)
    if (notice?.dedupeKey) suppressedDedupeMessages.set(notice.dedupeKey, notice.message)
    clearDismissTimer(id)
    notices.value = notices.value.filter((item) => item.id !== id)
  }

  /** Let a dedupe key notify again even if the message is unchanged. */
  function releaseNoticeDedupe(dedupeKey: string): void {
    suppressedDedupeMessages.delete(dedupeKey)
  }

  function clearNotices(): void {
    for (const id of dismissTimers.keys()) clearDismissTimer(id)
    suppressedDedupeMessages.clear()
    notices.value = []
  }

  function pushNotice(input: {
    kind?: AppNoticeKind
    message: string
    action?: AppNoticeAction
    sticky?: boolean
    durationMs?: number
    dedupeKey?: string
  }): number {
    const message = input.message.trim()
    if (!message) return 0
    const dedupeKey = input.dedupeKey?.trim() || undefined
    const kind = input.kind ?? 'info'
    const sticky = input.sticky === true

    if (dedupeKey) {
      if (suppressedDedupeMessages.get(dedupeKey) === message) return 0
      suppressedDedupeMessages.delete(dedupeKey)
      // Update in place so a repeating source keeps one stable toast instead of
      // replacing it with a fresh id the user has to chase.
      const existing = notices.value.find((item) => item.dedupeKey === dedupeKey)
      if (existing) {
        const updated: AppNotice = {
          ...existing,
          kind,
          message,
          action: input.action,
          sticky
        }
        notices.value = notices.value.map((item) => (item.id === existing.id ? updated : item))
        scheduleAutoDismiss(updated, input.durationMs)
        return updated.id
      }
    }

    const notice: AppNotice = {
      id: nextNoticeId++,
      kind,
      message,
      action: input.action,
      sticky,
      dedupeKey
    }
    notices.value = [...notices.value.slice(-4), notice]
    scheduleAutoDismiss(notice, input.durationMs)
    return notice.id
  }

  return {
    notices,
    pushNotice,
    dismissNotice,
    releaseNoticeDedupe,
    clearNotices
  }
}
