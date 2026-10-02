import { computed, ref, type Ref, type ComputedRef } from 'vue'

export type AppNoticeKind = 'info' | 'success' | 'warning' | 'error'

export type AppNoticeAction = {
  label: string
  run: () => void
}

export type AppNotice = {
  id: number
  kind: AppNoticeKind
  message: string
  createdAt: number
  read: boolean
  action?: AppNoticeAction
  sticky?: boolean
  dedupeKey?: string
}

const notices = ref<AppNotice[]>([])
const noticeHistory = ref<AppNotice[]>([])
let nextNoticeId = 1
const dismissTimers = new Map<number, ReturnType<typeof setTimeout>>()
const timerState = new Map<number, { remaining: number; started: number; pauses: Set<string> }>()
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
  const pauses = timerState.get(notice.id)?.pauses ?? new Set<string>()
  clearDismissTimer(notice.id)
  timerState.delete(notice.id)
  if (notice.sticky) return
  const delayMs = Math.max(2500, durationMs ?? 7000)
  timerState.set(notice.id, { remaining: delayMs, started: Date.now(), pauses })
  if (pauses.size) return
  dismissTimers.set(
    notice.id,
    setTimeout(() => {
      clearDismissTimer(notice.id)
      timerState.delete(notice.id)
      notices.value = notices.value.filter((item) => item.id !== notice.id)
    }, delayMs)
  )
}

export function useAppNoticeStore(): {
  notices: Ref<AppNotice[]>
  noticeHistory: Ref<AppNotice[]>
  unreadCount: ComputedRef<number>
  markHistoryRead: () => void
  clearHistory: () => void
  pauseNotice: (id: number, reason: string) => void
  resumeNotice: (id: number, reason: string) => void
  pushNotice: (input: {
    kind?: AppNoticeKind
    message: string
    action?: AppNoticeAction
    sticky?: boolean
    durationMs?: number
    dedupeKey?: string
  }) => number
  dismissNotice: (id: number) => void
  releaseNoticeDedupe: (dedupeKey: string) => void
  clearNotices: () => void
} {
  /** Closing a deduped notice suppresses that exact message until it changes. */
  function dismissNotice(id: number): void {
    const notice = notices.value.find((item) => item.id === id)
    if (notice?.dedupeKey) suppressedDedupeMessages.set(notice.dedupeKey, notice.message)
    clearDismissTimer(id)
    timerState.delete(id)
    notices.value = notices.value.filter((item) => item.id !== id)
  }

  /** Let a dedupe key notify again even if the message is unchanged. */
  function releaseNoticeDedupe(dedupeKey: string): void {
    suppressedDedupeMessages.delete(dedupeKey)
  }

  function clearNotices(): void {
    for (const id of dismissTimers.keys()) clearDismissTimer(id)
    suppressedDedupeMessages.clear()
    timerState.clear()
    notices.value = []
    noticeHistory.value = []
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
    const sticky = input.sticky ?? (kind === 'error' || kind === 'warning' || !!input.action)

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
        if (existing.message !== message || existing.kind !== kind) {
          updated.read = false
          updated.createdAt = Date.now()
          if (!noticeHistory.value.some((item) => item.id === existing.id)) {
            noticeHistory.value = [...noticeHistory.value.slice(-49), updated]
          }
        }
        notices.value = notices.value.map((item) => (item.id === existing.id ? updated : item))
        noticeHistory.value = noticeHistory.value.map((item) =>
          item.id === existing.id ? updated : item
        )
        scheduleAutoDismiss(updated, input.durationMs)
        return updated.id
      }
    }

    const notice: AppNotice = {
      id: nextNoticeId++,
      kind,
      message,
      createdAt: Date.now(),
      read: false,
      action: input.action,
      sticky,
      dedupeKey
    }
    const evicted = notices.value.length >= 4 ? notices.value[0] : null
    if (evicted) {
      clearDismissTimer(evicted.id)
      timerState.delete(evicted.id)
    }
    notices.value = [...notices.value.slice(-3), notice]
    noticeHistory.value = [...noticeHistory.value.slice(-49), notice]
    scheduleAutoDismiss(notice, input.durationMs)
    return notice.id
  }

  return {
    notices,
    noticeHistory,
    unreadCount: computed(() => noticeHistory.value.filter((notice) => !notice.read).length),
    markHistoryRead: () => {
      for (const notice of noticeHistory.value) notice.read = true
    },
    clearHistory: () => {
      noticeHistory.value = []
    },
    pauseNotice,
    resumeNotice,
    pushNotice,
    dismissNotice,
    releaseNoticeDedupe,
    clearNotices
  }
}

function pauseNotice(id: number, reason: string): void {
  const state = timerState.get(id)
  if (!state || state.pauses.has(reason)) return
  if (state.pauses.size === 0) {
    state.remaining = Math.max(0, state.remaining - (Date.now() - state.started))
    clearDismissTimer(id)
  }
  state.pauses.add(reason)
}
function resumeNotice(id: number, reason: string): void {
  const state = timerState.get(id)
  if (!state || !state.pauses.delete(reason) || state.pauses.size > 0) return
  state.started = Date.now()
  dismissTimers.set(
    id,
    setTimeout(() => {
      clearDismissTimer(id)
      timerState.delete(id)
      notices.value = notices.value.filter((item) => item.id !== id)
    }, state.remaining)
  )
}
