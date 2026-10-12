import type { NativeQueueCommit, NativeQueueSelection } from '../../../shared/nativeQueue.ts'
import type { Track } from '../types/music'
import type { PlayMode } from '../types/settings'
import { toNativePlayMode } from '../../../shared/playbackModes.ts'
import {
  preparePlayerNativeQueue,
  type NativeQueueLoadItem,
  type PreparedNativeQueue,
  type PreparePlayerNativeQueueOptions,
  type PlayerNativeQueueBoundary
} from './nativeQueuePreparation.ts'

interface QueueApi {
  loadQueue: (items: NativeQueueLoadItem[], index: number) => Promise<NativeQueueCommit | void>
  selectQueueItem?: (selection: NativeQueueSelection) => Promise<boolean>
}

/** Retains one content version, with authority to reuse held by main. */
export class NativeQueueLoader {
  private committed: {
    json: string
    token: string
    window: boolean
    entries: Array<{ id: string; queueEntryId?: string; index: number }>
  } | null = null

  clear(): void {
    this.committed = null
  }

  private matches(items: NativeQueueLoadItem[]): boolean {
    return this.committed !== null && JSON.stringify(items) === this.committed.json
  }

  async loadPrepared(
    prepared: PreparedNativeQueue,
    api: QueueApi,
    queue: readonly Track[] = []
  ): Promise<void> {
    this.clear()
    const commit = await api.loadQueue(prepared.items, prepared.startIndex)
    if (commit?.queueToken) {
      this.committed = {
        json: JSON.stringify(prepared.items),
        token: commit.queueToken,
        window: !!prepared.queueIndices,
        entries: prepared.items.map((item, nativeIndex) => {
          const index = prepared.queueIndices?.[nativeIndex] ?? nativeIndex
          return { id: item.id, index, queueEntryId: queue[index]?.queueEntryId }
        })
      }
    }
  }

  findLogicalIndex(
    info: { queueIndex: number; queueToken?: string },
    queue: readonly Track[]
  ): number {
    if (!this.committed || !info.queueToken || info.queueToken !== this.committed.token) return -1
    const entry = this.committed.entries[info.queueIndex]
    if (!entry) return -1
    const track = queue[entry.index]
    return track?.id === entry.id &&
      (!entry.queueEntryId || track.queueEntryId === entry.queueEntryId)
      ? entry.index
      : -1
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
    let prepared = await preparePlayerNativeQueue(
      { ...options, canReuseQueue: (items) => !!api.selectQueueItem && this.matches(items) },
      boundary
    )
    if (!prepared || options.isCurrent?.() === false) return null
    if (this.committed && api.selectQueueItem && this.matches(prepared.items)) {
      const item = prepared.items[prepared.startIndex]
      const selected = await api.selectQueueItem({
        queueToken: this.committed.token,
        index: prepared.startIndex,
        id: item.id,
        source: item.source
      })
      if (options.isCurrent?.() === false) {
        this.clear()
        return null
      }
      if (selected) {
        this.committed.window = !!prepared.queueIndices
        this.committed.entries = prepared.items.map((item, nativeIndex) => {
          const index = prepared!.queueIndices?.[nativeIndex] ?? nativeIndex
          return { id: item.id, index, queueEntryId: options.queue[index]?.queueEntryId }
        })
        return prepared
      }
      // Token invalidation, a changed symlink or a service restart: run the
      // full availability checks again, including singleton degradation.
      this.clear()
      prepared = await preparePlayerNativeQueue({ ...options, canReuseQueue: undefined }, boundary)
      if (!prepared || options.isCurrent?.() === false) return null
    }
    await this.loadPrepared(prepared, api, options.queue)
    if (options.isCurrent?.() === false) {
      this.clear()
      return null
    }
    return prepared
  }
}
