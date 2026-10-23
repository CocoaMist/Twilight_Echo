import {
  createQueueWorkspaceStore,
  type QueueWorkspaceApi,
  type QueueWorkspaceRuntime
} from './controller.ts'
import { captureLibraryQueueSession, restoreQueueTrackIdentity } from './tracks.ts'
import type {
  CoreWorkspaceEdit,
  CoreWorkspacePageQuery,
  CoreWorkspaceState,
  CoreWorkspaceSessionsPage,
  CoreWorkspaceHistoryPage
} from '../../shared/coreWorkspace.ts'
import type {
  CoreWorkspaceRestore,
  CoreWorkspaceRestoreResult
} from '../../shared/coreWorkspace.ts'
import type { NamedQueueSession } from '../../shared/queueWorkspace.ts'
import type { QueueSessionRestoreOutcome } from './restoration.ts'
import type { LibraryPlaybackQueueReference } from '../../shared/playbackSession.ts'
import type { PlayMode, PlaybackInfo } from '../../shared/audioEngineTypes.ts'
import type { TrackData } from '../../shared/track.ts'
import { isPersistentDataRevisionConflict } from '../../shared/versionedPersistence.ts'
import { projectCoreError, projectCoreTrack } from '../projections.ts'

export interface CoreWorkspaceOptions extends Omit<QueueWorkspaceRuntime, 'cell'> {
  repository: QueueWorkspaceApi
  capture(): Promise<{ reference: LibraryPlaybackQueueReference; position: number; mode: PlayMode }>
  restore(
    session: NamedQueueSession,
    play: boolean,
    guard: () => void,
    signal?: AbortSignal
  ): Promise<QueueSessionRestoreOutcome>
  failed(error: unknown): void
}

/** Actual playback order is separate from the established listening counters. */
export class CoreWorkspaceService {
  private readonly store: ReturnType<typeof createQueueWorkspaceStore>
  private readonly options: CoreWorkspaceOptions
  private contentRevision = 0
  private stopped = false
  private lastEntry = ''
  private previous: Pick<PlaybackInfo, 'state' | 'naturalBoundaries'> | null = null
  constructor(options: CoreWorkspaceOptions) {
    this.options = options
    this.store = createQueueWorkspaceStore(
      {
        ...options,
        cell: (value) => ({ value }),
        changed: () => {
          this.contentRevision++
          options.changed()
        }
      },
      () => options.repository,
      options.failed
    )
  }
  async initialize(): Promise<void> {
    await this.store.ensureLoaded()
  }
  getRevision(): number {
    return this.store.getRevision()
  }
  getContentRevision(): number {
    return this.contentRevision
  }
  state(): CoreWorkspaceState {
    return {
      revision: this.getRevision(),
      contentRevision: this.contentRevision,
      sessions: this.store.sessions.value.length,
      history: this.store.history.value.length,
      error: this.store.error.value ? projectCoreError(this.store.error.value) : null
    }
  }
  private fence(query: CoreWorkspacePageQuery): void {
    if (query.revision !== this.getRevision() || query.contentRevision !== this.contentRevision)
      throw stale('Queue workspace changed; read fresh state')
  }
  sessions(query: CoreWorkspacePageQuery): CoreWorkspaceSessionsPage {
    this.fence(query)
    const offset = query.offset ?? 0,
      limit = query.limit ?? 20
    return {
      revision: query.revision,
      contentRevision: query.contentRevision,
      offset,
      total: this.store.sessions.value.length,
      items: this.store.sessions.value.slice(offset, offset + limit).map((session) => ({
        id: session.id,
        name: session.name,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        playMode: session.playMode,
        currentEntryId: session.currentEntryId,
        position: session.position,
        count: session.libraryQueue ? null : session.entries.length,
        storage: session.libraryQueue ? 'libraryQueue' : 'entries'
      }))
    }
  }
  history(query: CoreWorkspacePageQuery): CoreWorkspaceHistoryPage {
    this.fence(query)
    const offset = query.offset ?? 0,
      limit = query.limit ?? 200
    return {
      revision: query.revision,
      contentRevision: query.contentRevision,
      offset,
      total: this.store.history.value.length,
      items: this.store.history.value.slice(offset, offset + limit).map((entry) => ({
        id: entry.id,
        playedAt: entry.playedAt,
        playMode: entry.playMode,
        track: projectCoreTrack(restoreQueueTrackIdentity(entry.track), entry.track.queueEntryId)
      }))
    }
  }
  async edit(command: CoreWorkspaceEdit, signal?: AbortSignal): Promise<CoreWorkspaceState> {
    if (this.stopped) throw new Error('Queue workspace is shutting down')
    const context = { revision: command.revision, signal }
    signal?.throwIfAborted()
    try {
      const edit = command.edit
      switch (edit.kind) {
        case 'saveCurrent': {
          const capture = await this.options.capture()
          signal?.throwIfAborted()
          const session = captureLibraryQueueSession(
            this.options,
            edit.name,
            capture.reference,
            capture.position,
            capture.mode,
            edit.id
          )
          await this.store.save(session, !!edit.id, context)
          break
        }
        case 'rename':
          await this.store.rename(edit.id, edit.name, context)
          break
        case 'remove':
          await this.store.remove(edit.id, context)
          break
      }
    } catch (error) {
      const cause = error instanceof Error ? error.cause : null
      if (
        isPersistentDataRevisionConflict(cause) ||
        (cause as { code?: string })?.code === 'STALE_REVISION'
      )
        throw stale('Queue workspace changed; read fresh state')
      throw error
    }
    return this.state()
  }
  async restore(
    command: CoreWorkspaceRestore,
    signal?: AbortSignal
  ): Promise<CoreWorkspaceRestoreResult> {
    if (this.stopped) throw new Error('Queue workspace is shutting down')
    if (command.revision !== this.getRevision())
      throw stale('Queue workspace changed; read fresh state')
    const session = this.store.sessions.value.find((item) => item.id === command.id)
    if (!session) throw new Error('此会话已删除，请刷新后重试')
    const generation = this.store.getSessionGeneration()
    const guard = () => {
      signal?.throwIfAborted()
      if (this.stopped || generation !== this.store.getSessionGeneration())
        throw stale('会话已变化，已取消恢复，请重新选择会话')
    }
    const result = await this.options.restore(
      structuredClone(session),
      command.play === true,
      guard,
      signal
    )
    return {
      restored: result.restored,
      unavailable: result.missing.length,
      deferred: result.deferred,
      issues: result.missing.slice(0, 200).map(({ entry, reason }) => ({
        occurrenceId: entry.queueEntryId,
        title: entry.title,
        reason
      }))
    }
  }
  recordStart(track: TrackData, mode: PlayMode, restart = false): void {
    if (this.stopped) return
    const identity = `${track.queueEntryId ?? ''}\0${track.id}`
    if (!restart && identity === this.lastEntry) return
    this.lastEntry = identity
    this.store.record(track, mode)
  }
  beginAttempt(): void {
    this.lastEntry = ''
  }
  /** A queue-only native rebind changes membership, not the listening attempt. */
  rebindOccurrence(previous: TrackData, current: TrackData): void {
    if (this.lastEntry === `${previous.queueEntryId ?? ''}\0${previous.id}`)
      this.lastEntry = `${current.queueEntryId ?? ''}\0${current.id}`
  }
  observe(track: TrackData | null, info: PlaybackInfo): void {
    if (this.stopped) return
    const naturalRepeat =
      this.previous?.naturalBoundaries &&
      info.naturalBoundaries &&
      info.naturalBoundaries.trackSerial > this.previous.naturalBoundaries.trackSerial
    if (track && info.state === 'playing') this.recordStart(track, info.playMode, !!naturalRepeat)
    // Stop followed by Play is a new attempt; Pause followed by Play is the same one.
    if (info.state === 'stopped') this.lastEntry = ''
    this.previous = {
      state: info.state,
      naturalBoundaries: info.naturalBoundaries ? { ...info.naturalBoundaries } : undefined
    }
  }
  async flush(): Promise<void> {
    await this.store.flush()
  }
  async shutdown(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.store.dispose()
    await this.flush()
  }
}
function stale(message: string): Error {
  return Object.assign(new Error(message), { code: 'STALE_REVISION' })
}
