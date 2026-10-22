import type { PlaybackSession } from '../types/music.ts'
import {
  isPersistentDataRevisionConflict,
  type VersionedDataEnvelope
} from '../../../shared/versionedPersistence.ts'

const MAX_REVISION_CONFLICT_ATTEMPTS = 3

export interface PlaybackSessionWriteApi {
  clearPlaybackSession: (
    expectedRevision: number
  ) => Promise<VersionedDataEnvelope<PlaybackSession | null> | void>
  savePlaybackSession: (
    session: PlaybackSession,
    expectedRevision: number
  ) => Promise<VersionedDataEnvelope<PlaybackSession> | void>
  syncQueueReferences?: (owner: string, ids: string[]) => Promise<void>
}

export interface PlaybackSessionWriteReceipt {
  sequence: number
  completion: Promise<void>
}

export class PlaybackSessionWriter {
  private readonly referenceOwner = 'playback-session'
  private tail: Promise<void> = Promise.resolve()
  private nextSequence = 0
  private committedSequence = 0
  private revision = 0
  private savedQueueRef: object | null = null
  private savedLibraryQueueId: string | null = null
  private lastSnapshotSignature: string | null = null
  private pendingWrites = 0
  private autosaveScheduler: (() => void) | null = null
  private autosaveFlush: (() => Promise<void>) | null = null

  registerAutosaveScheduler(schedule: () => void, flush?: () => Promise<void>): () => void {
    this.autosaveScheduler = schedule
    this.autosaveFlush = flush ?? null
    return () => {
      if (this.autosaveScheduler === schedule) {
        this.autosaveScheduler = null
        this.autosaveFlush = null
      }
    }
  }

  /** Backup reads the persisted selection, so drain a fresh compact snapshot
   * instead of exporting an old occurrence while its debounce is pending. */
  async flushAutosave(): Promise<void> {
    await this.autosaveFlush?.()
    await this.whenIdle()
  }

  requestAutosave(): boolean {
    if (!this.autosaveScheduler) return false
    this.autosaveScheduler()
    return true
  }

  save(api: PlaybackSessionWriteApi, session: PlaybackSession): PlaybackSessionWriteReceipt {
    return this.enqueue(async (expectedRevision) => {
      await this.prepareLibraryReference(api, session.libraryQueue?.id)
      const receipt = await api.savePlaybackSession(session, expectedRevision)
      if (session.libraryQueue) {
        await this.syncReference(api, [session.libraryQueue.id], false)
        this.savedLibraryQueueId = session.libraryQueue.id
      } else {
        await this.syncReference(api, [], false)
        this.savedLibraryQueueId = null
      }
      this.lastSnapshotSignature = null
      if (session.queue !== undefined || session.libraryQueue) this.savedQueueRef = null
      return receipt
    })
  }

  saveSnapshot(
    api: PlaybackSessionWriteApi,
    session: PlaybackSession | null,
    queueRef: object | null,
    createQueue: () => NonNullable<PlaybackSession['queue']>
  ): PlaybackSessionWriteReceipt {
    const mayCoalesce = this.pendingWrites > 0
    // Only the compact session is compared. Queue snapshots remain lazy.
    const signature = session
      ? JSON.stringify({ ...session, savedAt: undefined, queue: undefined })
      : null
    let snapshot: PlaybackSession | null | undefined
    return this.enqueue(async (expectedRevision) => {
      if (snapshot === undefined) {
        snapshot =
          session &&
          queueRef !== null &&
          queueRef !== this.savedQueueRef &&
          !session.queue &&
          !session.libraryQueue
            ? { ...session, queue: createQueue() }
            : session
      }
      if (!snapshot) {
        const receipt = await api.clearPlaybackSession(expectedRevision)
        await this.syncReference(api, [], false)
        this.savedLibraryQueueId = null
        this.savedQueueRef = null
        this.lastSnapshotSignature = null
        return receipt
      }
      // Store and App autosave producers can enqueue the same selection while
      // an IPC write is pending. Share that successful commit, while explicit
      // later saves still perform CAS and detect other writers.
      if (mayCoalesce && !snapshot.queue && signature === this.lastSnapshotSignature) return
      try {
        await this.prepareLibraryReference(api, snapshot.libraryQueue?.id)
        const receipt = await api.savePlaybackSession(snapshot, expectedRevision)
        if (snapshot.libraryQueue) {
          await this.syncReference(api, [snapshot.libraryQueue.id], false)
          this.savedLibraryQueueId = snapshot.libraryQueue.id
        } else {
          await this.syncReference(api, [], false)
          this.savedLibraryQueueId = null
        }
        if (snapshot.libraryQueue) this.savedQueueRef = null
        if (snapshot.queue !== undefined) this.savedQueueRef = queueRef
        this.lastSnapshotSignature = signature
        return receipt
      } catch (error) {
        if (isPersistentDataRevisionConflict(error)) {
          this.savedQueueRef = null
          this.lastSnapshotSignature = null
          snapshot = undefined
        }
        throw error
      }
    })
  }

  clear(api: PlaybackSessionWriteApi): PlaybackSessionWriteReceipt {
    return this.enqueue(async (expectedRevision) => {
      const receipt = await api.clearPlaybackSession(expectedRevision)
      await this.syncReference(api, [], false)
      this.savedLibraryQueueId = null
      this.savedQueueRef = null
      this.lastSnapshotSignature = null
      return receipt
    })
  }

  whenIdle(): Promise<void> {
    return this.tail
  }

  setRevision(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error('Playback session revision must be a non-negative safe integer')
    }
    if (revision > this.revision) this.lastSnapshotSignature = null
    this.revision = Math.max(this.revision, revision)
  }

  getRevision(): number {
    return this.revision
  }

  getCommittedSequence(): number {
    return this.committedSequence
  }

  setSavedQueueRef(queueRef: object | null): void {
    this.savedQueueRef = queueRef
  }

  setSavedLibraryQueueId(id: string | null): void {
    this.savedLibraryQueueId = id
  }

  private async prepareLibraryReference(
    api: PlaybackSessionWriteApi,
    nextId: string | undefined
  ): Promise<void> {
    const ids = [...new Set([this.savedLibraryQueueId, nextId].filter((id): id is string => !!id))]
    if (ids.length) await this.syncReference(api, ids, true)
  }

  private async syncReference(
    api: PlaybackSessionWriteApi,
    ids: string[],
    required: boolean
  ): Promise<void> {
    const sync = api.syncQueueReferences
    if (!sync) return
    if (required) {
      await sync(this.referenceOwner, ids)
      return
    }
    await sync(this.referenceOwner, ids).catch(() => {})
  }

  private enqueue(
    operation: (
      expectedRevision: number
    ) => Promise<VersionedDataEnvelope<PlaybackSession | null> | void>
  ): PlaybackSessionWriteReceipt {
    const sequence = ++this.nextSequence
    ++this.pendingWrites
    const completion = this.tail
      .then(async () => {
        for (let attempt = 0; attempt < MAX_REVISION_CONFLICT_ATTEMPTS; attempt++) {
          try {
            const receipt = await operation(this.revision)
            if (receipt) this.revision = receipt.revision
            this.committedSequence = sequence
            return
          } catch (error) {
            if (!isPersistentDataRevisionConflict(error)) throw error
            // Always adopt the authoritative revision so a later Retry close /
            // queued write does not keep sending the stale expected revision.
            const currentRevision = error.current?.revision ?? 0
            if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) throw error
            this.revision = currentRevision
            if (attempt === MAX_REVISION_CONFLICT_ATTEMPTS - 1) throw error
          }
        }
      })
      .finally(() => {
        --this.pendingWrites
      })
    this.tail = completion.then(
      () => {},
      () => {}
    )
    return { sequence, completion }
  }
}

export const playbackSessionWriter = new PlaybackSessionWriter()
