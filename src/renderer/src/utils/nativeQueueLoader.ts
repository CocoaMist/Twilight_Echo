import type {
  NativeQueueCommit,
  NativeQueueSelection,
  NativeQueueRebind
} from '../../../shared/nativeQueue.ts'
import type { Track } from '../types/music'
import type { PlayMode } from '../types/settings'
import { toNativePlayMode } from '../../../shared/playbackModes.ts'
import { MAX_NATIVE_QUEUE_ITEMS } from '../../../shared/nativeQueue.ts'
import {
  preparePlayerNativeQueue,
  type NativeQueueLoadItem,
  type PreparedNativeQueue,
  type PreparePlayerNativeQueueOptions,
  type PlayerNativeQueueBoundary,
  type LibraryNativeQueueEntry,
  type LibraryNativeQueueReference
} from './nativeQueuePreparation.ts'

interface QueueApi {
  loadQueue: (items: NativeQueueLoadItem[], index: number) => Promise<NativeQueueCommit | void>
  selectQueueItem?: (selection: NativeQueueSelection) => Promise<boolean>
  rebindQueue?: (request: NativeQueueRebind) => Promise<NativeQueueCommit | null>
}

/** Retains one content version, with authority to reuse held by main. */
type CommittedEntry = { id: string; queueEntryId?: string; index: number } | null

export class NativeQueueLoader {
  private committed: {
    json: string
    token: string
    window: boolean
    entries: CommittedEntry[]
    libraryQueue?: LibraryNativeQueueReference
  } | null = null
  private generation = 0

  clear(): void {
    this.generation++
    this.committed = null
  }

  /**
   * Afterglow restore: adopt the queue identity the engine already holds so
   * later playback-info events map back onto this renderer's logical queue
   * without reloading the native queue. `nativeQueueIndices` describes a
   * current+next window (online queues); without it the mapping is identity.
   */
  adopt(
    queue: readonly Track[],
    info: { queueIndex: number; queueToken?: string; nativeQueueIndices?: readonly number[] }
  ): void {
    this.generation++
    const indices =
      info.nativeQueueIndices && info.nativeQueueIndices.length > 0
        ? [...info.nativeQueueIndices]
        : queue.map((_, index) => index)
    this.committed = {
      json: '',
      token: info.queueToken ?? '',
      window: indices.length !== queue.length,
      entries: indices.map((index) => {
        const track = queue[index]
        return track ? { id: track.id, index, queueEntryId: track.queueEntryId } : null
      })
    }
  }

  /** Adopt only lightweight database identities; no global Track[] or transport. */
  adoptLibrary(
    reference: LibraryNativeQueueReference,
    entries: readonly LibraryNativeQueueEntry[],
    queueToken: string
  ): boolean {
    if (
      !queueToken ||
      !entries.length ||
      entries.length > MAX_NATIVE_QUEUE_ITEMS ||
      entries.some(
        (entry) =>
          !entry.id || !entry.queueEntryId || !Number.isSafeInteger(entry.index) || entry.index < 0
      )
    )
      return false
    this.generation++
    this.committed = {
      json: '',
      token: queueToken,
      window: true,
      entries: entries.map((entry) => ({ ...entry })),
      libraryQueue: { id: reference.id, revision: reference.revision }
    }
    return true
  }

  /** Snapshot of the native→logical mapping, for the pre-unload handoff. */
  getCommittedIndices(): number[] | null {
    if (!this.committed) return null
    return this.committed.entries.map((entry) => entry?.index ?? -1)
  }

  getLibraryQueueReference(): LibraryNativeQueueReference | null {
    return this.committed?.libraryQueue ? { ...this.committed.libraryQueue } : null
  }

  /** Derive the old native slot from a main-issued token and the exact array
   * occurrence. The logical index is never guessed to be the native index. */
  arraySelection(
    info: { queueIndex: number; queueToken?: string; source: string },
    queue: readonly Track[],
    index: number,
    current: Track
  ): NativeQueueSelection | null {
    const committed = this.committed
    const entry = committed?.entries[info.queueIndex]
    if (
      !committed ||
      committed.libraryQueue ||
      !info.queueToken ||
      committed.token !== info.queueToken ||
      !entry ||
      entry.id !== current.id ||
      (current.queueEntryId
        ? entry.queueEntryId !== current.queueEntryId
        : entry.index !== index) ||
      index < 0 ||
      queue[index]?.id !== current.id ||
      queue[index]?.queueEntryId !== current.queueEntryId ||
      !info.source
    )
      return null
    return {
      queueToken: info.queueToken!,
      index: info.queueIndex,
      id: current.id,
      source: info.source
    }
  }

  /** Queue-only handoff, never LoadQueue/play/seek. Null explicitly preserves
   * the old mapping; an invalid/lost reply revokes it without replay/rollback.
   * The caller must retain the SQL seed on any possibly-applied outcome. */
  async rebindPrepared(
    prepared: PreparedNativeQueue,
    expected: NativeQueueSelection,
    mode: PlayMode,
    api: Pick<QueueApi, 'rebindQueue'>
  ): Promise<{ applied: boolean; current: boolean }> {
    const previous = this.committed
    if (!api.rebindQueue || !previous || previous.token !== expected.queueToken)
      return { applied: false, current: true }
    const entries = this.entries(prepared, []),
      items = structuredClone(prepared.items),
      json = JSON.stringify(items),
      libraryQueue = prepared.libraryQueue
        ? { id: prepared.libraryQueue.id, revision: prepared.libraryQueue.revision }
        : undefined
    const generation = ++this.generation
    this.committed = null
    const commit = await api.rebindQueue({
      expected: { ...expected },
      items,
      startIndex: prepared.startIndex,
      playMode: prepared.queueIndices && mode !== 'repeat' ? 'sequential' : toNativePlayMode(mode)
    })
    const current = generation === this.generation
    if (commit === null) {
      if (current) this.committed = previous
      return { applied: false, current }
    }
    if (!commit || typeof commit.queueToken !== 'string' || !commit.queueToken)
      throw new Error('队列接管回复无效，结果未知，请重新选择歌曲恢复同步')
    if (current)
      this.committed = {
        json,
        token: commit.queueToken,
        window: !!prepared.queueIndices,
        entries,
        ...(libraryQueue ? { libraryQueue } : {})
      }
    return { applied: true, current }
  }

  /** Selecting an occurrence commits a new database revision, without changing
   * the engine's already-playing window or its native token. Only cursor-only
   * commits may rebase this authority; edits/order changes require loadQueue. */
  rebaseLibraryCursor(
    previous: LibraryNativeQueueReference,
    next: LibraryNativeQueueReference
  ): boolean {
    const committed = this.committed
    if (
      !committed?.libraryQueue ||
      previous.id !== next.id ||
      committed.libraryQueue.id !== previous.id ||
      committed.libraryQueue.revision !== previous.revision
    )
      return false
    committed.libraryQueue = { ...next }
    return true
  }

  private matches(
    items: NativeQueueLoadItem[],
    libraryQueue?: LibraryNativeQueueReference
  ): boolean {
    return (
      this.committed !== null &&
      JSON.stringify(items) === this.committed.json &&
      this.committed.libraryQueue?.id === libraryQueue?.id &&
      this.committed.libraryQueue?.revision === libraryQueue?.revision
    )
  }

  private entries(prepared: PreparedNativeQueue, queue: readonly Track[]): CommittedEntry[] {
    if (prepared.libraryQueue) return prepared.libraryQueue.entries.map((entry) => ({ ...entry }))
    return prepared.items.map((item, nativeIndex) => {
      const index = prepared.queueIndices?.[nativeIndex] ?? nativeIndex
      return { id: item.id, index, queueEntryId: queue[index]?.queueEntryId }
    })
  }

  async loadPrepared(
    prepared: PreparedNativeQueue,
    api: QueueApi,
    queue: readonly Track[] = []
  ): Promise<void> {
    return this.commitPrepared(prepared, api, queue, ++this.generation)
  }

  private async commitPrepared(
    prepared: PreparedNativeQueue,
    api: QueueApi,
    queue: readonly Track[],
    generation: number
  ): Promise<void> {
    // Capture identities before IPC: a queue edit may replace the caller's rows
    // while the engine is authorizing/loading this request.
    const entries = this.entries(prepared, queue),
      json = JSON.stringify(prepared.items)
    const libraryQueue = prepared.libraryQueue
      ? {
          id: prepared.libraryQueue.id,
          revision: prepared.libraryQueue.revision
        }
      : undefined
    this.committed = null
    const commit = await api.loadQueue(prepared.items, prepared.startIndex)
    if (generation === this.generation && commit?.queueToken) {
      this.committed = {
        json,
        token: commit.queueToken,
        window: !!prepared.queueIndices,
        entries,
        ...(libraryQueue ? { libraryQueue } : {})
      }
    }
  }

  findLogicalIndex(
    info: { queueIndex: number; queueToken?: string },
    queue: readonly Track[]
  ): number {
    if (
      !this.committed ||
      this.committed.libraryQueue ||
      !info.queueToken ||
      info.queueToken !== this.committed.token
    )
      return -1
    const entry = this.committed.entries[info.queueIndex]
    if (!entry) return -1
    const track = queue[entry.index]
    return track?.id === entry.id &&
      (!entry.queueEntryId || track.queueEntryId === entry.queueEntryId)
      ? entry.index
      : -1
  }

  /** Database positions must be resolved against a bounded occurrence window,
   * not used to index the legacy complete-array queue. Both versions fence it. */
  findLibraryEntry(
    info: { queueIndex: number; queueToken?: string },
    queue: LibraryNativeQueueReference
  ): LibraryNativeQueueEntry | null {
    const committed = this.committed
    if (
      !committed?.libraryQueue ||
      committed.libraryQueue.id !== queue.id ||
      committed.libraryQueue.revision !== queue.revision ||
      !info.queueToken ||
      info.queueToken !== committed.token
    )
      return null
    const entry = committed.entries[info.queueIndex]
    return entry?.queueEntryId
      ? { id: entry.id, index: entry.index, queueEntryId: entry.queueEntryId }
      : null
  }

  hasWindow(): boolean {
    return this.committed?.window === true
  }

  playMode(mode: PlayMode) {
    return this.hasWindow() && mode !== 'repeat' ? 'sequential' : toNativePlayMode(mode)
  }

  async prepareAndLoad(
    options: PreparePlayerNativeQueueOptions,
    boundary: PlayerNativeQueueBoundary,
    api: QueueApi
  ): Promise<PreparedNativeQueue | null> {
    const generation = ++this.generation
    const isCurrent = () => generation === this.generation && options.isCurrent?.() !== false
    const prepareOptions = { ...options, isCurrent }
    let prepared = await preparePlayerNativeQueue(
      {
        ...prepareOptions,
        canReuseQueue: (items) => !!api.selectQueueItem && this.matches(items, options.libraryQueue)
      },
      boundary
    )
    if (!prepared || !isCurrent()) return null
    if (
      this.committed &&
      api.selectQueueItem &&
      this.matches(prepared.items, options.libraryQueue)
    ) {
      const item = prepared.items[prepared.startIndex]
      const entries = this.entries(prepared, options.queue)
      const selected = await api.selectQueueItem({
        queueToken: this.committed.token,
        index: prepared.startIndex,
        id: item.id,
        source: item.source
      })
      if (!isCurrent()) {
        if (generation === this.generation) this.clear()
        return null
      }
      if (selected) {
        this.committed.window = !!prepared.queueIndices
        this.committed.entries = entries
        return prepared
      }
      // Token invalidation, a changed symlink or a service restart: run the
      // full availability checks again, including singleton degradation.
      this.committed = null
      prepared = await preparePlayerNativeQueue(
        { ...prepareOptions, canReuseQueue: undefined },
        boundary
      )
      if (!prepared || !isCurrent()) return null
    }
    await this.commitPrepared(prepared, api, options.queue, generation)
    if (!isCurrent()) {
      if (generation === this.generation) this.clear()
      return null
    }
    return prepared
  }
}
