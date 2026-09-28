import type { PlaybackSession } from '../core/types.ts'
import { VersionedDataStore } from './versionedDataStore.ts'
import {
  PersistentDataRevisionConflictError,
  type VersionedDataEnvelope
} from '../../shared/versionedPersistence.ts'
import { trackCueRangePropertyIsValid } from '../../shared/cue.ts'

export function isPlaybackQueueSnapshot(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        !!item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        typeof (item as Record<string, unknown>).id === 'string' &&
        trackCueRangePropertyIsValid(item)
    )
  )
}

export class PlaybackSessionStorage {
  private readonly stateStore: VersionedDataStore<PlaybackSession | null>
  private readonly queueStore: VersionedDataStore<unknown[]>

  constructor(
    stateStore: VersionedDataStore<PlaybackSession | null>,
    queueStore: VersionedDataStore<unknown[]>
  ) {
    this.stateStore = stateStore
    this.queueStore = queueStore
  }

  async load(): Promise<VersionedDataEnvelope<PlaybackSession | null> | null> {
    const envelope = await this.stateStore.load()
    if (!envelope?.data || envelope.data.queue || envelope.data.queueRevision === undefined)
      return envelope
    const savedQueue = await this.queueStore.load()
    if (savedQueue?.revision !== envelope.data.queueRevision) {
      const backupQueue = await this.queueStore.loadBackup()
      if (backupQueue?.revision === envelope.data.queueRevision) {
        return { ...envelope, data: { ...envelope.data, queue: backupQueue.data } }
      }
      return {
        ...envelope,
        data: { ...envelope.data, queueRevision: undefined, queueIndex: undefined }
      }
    }
    return { ...envelope, data: { ...envelope.data, queue: savedQueue.data } }
  }

  async save(
    session: PlaybackSession,
    expectedRevision: number
  ): Promise<VersionedDataEnvelope<PlaybackSession>> {
    const current = await this.stateStore.load()
    if ((current?.revision ?? 0) !== expectedRevision) {
      throw new PersistentDataRevisionConflictError(current, expectedRevision)
    }
    const { queue, queueRevision: _incomingQueueRevision, ...state } = session
    let queueRevision = current?.data?.queueRevision
    if (queue !== undefined) {
      queueRevision = await this.saveQueue(queue)
    } else if (queueRevision === undefined && current?.data?.queue) {
      queueRevision = await this.saveQueue(current.data.queue)
    }
    const saved = await this.stateStore.save(
      queueRevision === undefined ? state : { ...state, queueRevision },
      expectedRevision
    )
    return saved as VersionedDataEnvelope<PlaybackSession>
  }

  async clear(expectedRevision: number) {
    const saved = await this.stateStore.save(null, expectedRevision)
    await this.queueStore.removeFiles()
    return saved
  }

  private async saveQueue(queue: unknown[]): Promise<number> {
    const current = await this.queueStore.load()
    const saved = await this.queueStore.save(queue, current?.revision ?? 0)
    return saved.revision
  }
}
