import type { NativeQueueCommit, NativeQueueSelection } from '../../../shared/nativeQueue.ts'
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
  private committed: { json: string; token: string } | null = null

  clear(): void {
    this.committed = null
  }

  private matches(items: NativeQueueLoadItem[]): boolean {
    return this.committed !== null && JSON.stringify(items) === this.committed.json
  }

  async loadPrepared(prepared: PreparedNativeQueue, api: QueueApi): Promise<void> {
    this.clear()
    const commit = await api.loadQueue(prepared.items, prepared.startIndex)
    if (commit?.queueToken) {
      this.committed = { json: JSON.stringify(prepared.items), token: commit.queueToken }
    }
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
      if (selected) return prepared
      // Token invalidation, a changed symlink or a service restart: run the
      // full availability checks again, including singleton degradation.
      this.clear()
      prepared = await preparePlayerNativeQueue({ ...options, canReuseQueue: undefined }, boundary)
      if (!prepared || options.isCurrent?.() === false) return null
    }
    await this.loadPrepared(prepared, api)
    if (options.isCurrent?.() === false) {
      this.clear()
      return null
    }
    return prepared
  }
}
