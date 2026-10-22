import { computed, ref, shallowRef } from 'vue'
import type { Track } from '@renderer/types/music'
import type { PlayMode } from '@renderer/types/settings'
import { saveQueueTrack } from '@renderer/utils/queueSessionTrack.ts'
import {
  MAX_PLAYBACK_ORDER_ENTRIES,
  MAX_QUEUE_SESSIONS,
  MAX_SAVED_QUEUE_ENTRIES,
  type NamedQueueSession,
  type PlaybackOrderEntry,
  type QueueWorkspaceDocument
} from '../../../../shared/queueWorkspace.ts'
import {
  isPersistentDataRevisionConflict,
  type VersionedDataEnvelope
} from '../../../../shared/versionedPersistence.ts'

export interface QueueWorkspaceApi {
  loadQueueWorkspace: () => Promise<VersionedDataEnvelope<QueueWorkspaceDocument> | null>
  saveQueueWorkspace: (
    document: QueueWorkspaceDocument,
    revision: number
  ) => Promise<VersionedDataEnvelope<QueueWorkspaceDocument>>
  syncQueueReferences?: (owner: string, ids: string[]) => Promise<void>
}

export function createQueueWorkspaceStore(
  getApi: () => QueueWorkspaceApi,
  onError: (message: string) => void = () => {}
) {
  const sessions = shallowRef<NamedQueueSession[]>([])
  const history = shallowRef<PlaybackOrderEntry[]>([])
  const loading = ref(false)
  const writes = ref(0)
  const error = ref('')
  const busy = computed(() => loading.value || writes.value > 0)
  let revision = 0
  let loaded = false
  let loadRequest: Promise<void> | null = null
  let tail: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | null = null
  let pendingHistory: PlaybackOrderEntry[] = []
  const referenceOwner = 'workspace'

  function referenceIds(document: QueueWorkspaceDocument): string[] {
    return [
      ...new Set(
        document.sessions.flatMap((session) =>
          session.libraryQueue ? [session.libraryQueue.id] : []
        )
      )
    ]
  }

  async function syncIds(ids: string[], required = false): Promise<void> {
    const sync = getApi().syncQueueReferences
    if (!sync) return
    if (required) {
      await sync(referenceOwner, ids)
      return
    }
    await sync(referenceOwner, ids).catch(() => {})
  }

  async function syncReferences(document: QueueWorkspaceDocument): Promise<void> {
    const ids = referenceIds(document)
    // Persistence remains usable when the SQLite owner is unavailable (for
    // example while running in JSON mode). A missed sync is conservative: it
    // can retain a queue temporarily, but cannot make GC delete a live queue.
    await syncIds(ids)
  }

  function applyHistory(saved: PlaybackOrderEntry[]): void {
    const ids = new Set(saved.map((entry) => entry.id))
    history.value = [...saved, ...pendingHistory.filter((entry) => !ids.has(entry.id))].slice(
      -MAX_PLAYBACK_ORDER_ENTRIES
    )
  }

  function ensureLoaded(): Promise<void> {
    if (loaded) return Promise.resolve()
    if (loadRequest) return loadRequest
    loading.value = true
    loadRequest = (async () => {
      const result = await getApi().loadQueueWorkspace()
      sessions.value = result?.data.sessions ?? []
      applyHistory(result?.data.history ?? [])
      revision = result?.revision ?? 0
      await syncReferences({ version: 1, sessions: sessions.value, history: history.value })
      loaded = true
      error.value = ''
    })()
      .catch((reason) => {
        error.value = reason instanceof Error ? reason.message : String(reason)
        throw reason
      })
      .finally(() => {
        loading.value = false
        loadRequest = null
      })
    return loadRequest
  }

  function commit(update?: (sessions: NamedQueueSession[]) => NamedQueueSession[]): Promise<void> {
    writes.value++
    const operation = tail
      .then(async () => {
        await ensureLoaded()
        if (!update && pendingHistory.length === 0) return
        const next = update ? update(sessions.value) : sessions.value
        if (next.length > MAX_QUEUE_SESSIONS)
          throw new Error(`最多保存 ${MAX_QUEUE_SESSIONS} 个会话`)
        if (
          next.reduce((sum, session) => sum + session.entries.length, 0) > MAX_SAVED_QUEUE_ENTRIES
        ) {
          throw new Error('所有会话合计最多保存 40,000 首，请删除不需要的会话')
        }
        const savedHistory = history.value
        const currentDocument = {
          version: 1 as const,
          sessions: sessions.value,
          history: savedHistory
        }
        const nextDocument = { version: 1 as const, sessions: next, history: savedHistory }
        // Protect additions before publishing the new document. Retaining old
        // IDs in this union keeps a failed save from losing its prior owner.
        await syncIds(
          [...new Set([...referenceIds(currentDocument), ...referenceIds(nextDocument)])],
          true
        )
        try {
          const receipt = await getApi().saveQueueWorkspace(nextDocument, revision)
          revision = receipt.revision
          sessions.value = receipt.data.sessions
          const savedIds = new Set(savedHistory.map((entry) => entry.id))
          pendingHistory = pendingHistory.filter((entry) => !savedIds.has(entry.id))
          await syncReferences(receipt.data)
          error.value = ''
        } catch (reason) {
          if (isPersistentDataRevisionConflict(reason)) {
            const current = reason.current as VersionedDataEnvelope<QueueWorkspaceDocument> | null
            revision = current?.revision ?? 0
            sessions.value = current?.data.sessions ?? []
            applyHistory(current?.data.history ?? [])
          }
          throw reason
        }
      })
      .catch((reason) => {
        error.value = isPersistentDataRevisionConflict(reason)
          ? '会话已在其他窗口更新，已加载最新内容，请重试'
          : reason instanceof Error
            ? reason.message
            : String(reason)
        throw new Error(error.value, { cause: reason })
      })
      .finally(() => {
        writes.value--
      })
    tail = operation.catch(() => {})
    return operation
  }

  function normalizeName(name: string, items: NamedQueueSession[], id: string): string {
    const normalized = name.trim()
    if (!normalized || normalized.length > 120) throw new Error('会话名称须为 1–120 个字符')
    if (
      items.some(
        (item) => item.id !== id && item.name.toLocaleLowerCase() === normalized.toLocaleLowerCase()
      )
    ) {
      throw new Error('已有同名会话，请使用覆盖操作或更换名称')
    }
    return normalized
  }

  function save(session: NamedQueueSession, overwrite = false): Promise<void> {
    return commit((items) => {
      const exists = items.some((item) => item.id === session.id)
      if (overwrite && !exists) throw new Error('此会话已删除，请保存为新会话')
      const next = { ...session, name: normalizeName(session.name, items, session.id) }
      return exists
        ? items.map((item) => (item.id === next.id ? { ...next, createdAt: item.createdAt } : item))
        : [...items, next]
    })
  }

  function rename(id: string, name: string): Promise<void> {
    return commit((items) => {
      if (!items.some((item) => item.id === id)) throw new Error('此会话已删除')
      const normalized = normalizeName(name, items, id)
      return items.map((item) =>
        item.id === id ? { ...item, name: normalized, updatedAt: new Date().toISOString() } : item
      )
    })
  }

  function remove(id: string): Promise<void> {
    return commit((items) => items.filter((item) => item.id !== id))
  }

  function record(track: Track, playMode: PlayMode): void {
    const entry = {
      id: crypto.randomUUID(),
      playedAt: new Date().toISOString(),
      track: saveQueueTrack(track),
      playMode
    }
    pendingHistory = [...pendingHistory, entry].slice(-MAX_PLAYBACK_ORDER_ENTRIES)
    history.value = [...history.value, entry].slice(-MAX_PLAYBACK_ORDER_ENTRIES)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void commit().catch(() => onError(error.value))
    }, 1200)
  }

  async function flush(): Promise<void> {
    if (timer) clearTimeout(timer)
    timer = null
    await tail
    if (pendingHistory.length) await commit()
  }

  async function reload(): Promise<void> {
    await tail
    loaded = false
    await ensureLoaded()
  }

  function dispose(): void {
    if (timer) clearTimeout(timer)
    timer = null
  }

  return {
    sessions,
    history,
    loading,
    busy,
    error,
    ensureLoaded,
    reload,
    save,
    rename,
    remove,
    record,
    flush,
    dispose
  }
}
