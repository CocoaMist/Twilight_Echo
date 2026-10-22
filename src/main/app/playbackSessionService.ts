import type { PlaybackSession } from '../core/types.ts'
import { runtime } from '../core/runtime.ts'
import { getPlaybackSessionStoreBundle } from '../persistence/playbackSessionStore.ts'
import { PersistentDataRevisionConflictError } from '../../shared/versionedPersistence.ts'
import { LIBRARY_PAGE_SIZE } from '../../shared/libraryDatabase.ts'
import type { LibraryQueueSnapshot } from '../../shared/libraryDatabase.ts'
import type { LibraryPlaybackQueueReference } from '../../shared/playbackSession.ts'
import type { PlayMode } from '../../shared/audioEngineTypes.ts'
import type { SleepTimerState } from '../../shared/sleepTimer.ts'
import {
  resolveAfterglowQueueIndex,
  afterglowTrackPathOf,
  type AfterglowNativeQueueEntry,
  type AfterglowRendererSnapshot
} from '../../shared/afterglowMode.ts'

export interface LoadedPlaybackSession {
  session: PlaybackSession
  revision: number
}

export interface EnginePlaybackState {
  state: 'stopped' | 'playing' | 'paused'
  position: number
  queueIndex: number
  source: string
  playMode?: string
}

export interface EngineSessionOptions {
  force?: boolean
  logicalIndex?: number
  /** Exact occurrence held in the native slot; positions alone do not identify duplicates. */
  entryId?: string
  nativeEntries?: readonly AfterglowNativeQueueEntry[]
  isCurrent?: () => boolean
}

type PendingEngineState = {
  status: EnginePlaybackState
  options: EngineSessionOptions
  cached: LoadedPlaybackSession
}

const POSITION_PERSIST_INTERVAL_MS = 5_000
const MAX_CAS_RETRIES = 2

/**
 * Keeps `playback-session.json` authoritative while no renderer exists.
 *
 * The renderer normally writes this file. During Afterglow the main process is
 * the only writer, so it caches one revision and writes track/position changes
 * back with the same compare-and-swap contract the IPC path uses.
 */
class PlaybackSessionService {
  private cached: LoadedPlaybackSession | null = null
  private lastPositionWriteAt = 0
  private writeTail: Promise<void> = Promise.resolve()
  private engineTail: Promise<void> | null = null
  private pendingEngineState: PendingEngineState | null = null
  private libraryQueueTotal: number | null = null
  /**
   * The queue is written once when a renderer snapshot is adopted. Later track
   * and position writes omit it so a 32 MB queue file is not rewritten on every
   * persistence tick.
   */
  private queueDirty = false
  /**
   * True when the session exists only for this Afterglow run. Users with
   * playback-resume disabled must not get a resume record written on their behalf.
   */
  private memoryOnly = false

  /** Asks the renderer to flush navigation + playback state before it unloads. */
  async flushFromRenderer(options: { includeQueue?: boolean } = {}): Promise<void> {
    const { requestRendererPlaybackSessionSave } = await import('./window')
    await requestRendererPlaybackSessionSave(options)
  }

  async load(): Promise<LoadedPlaybackSession | null> {
    const { storage } = getPlaybackSessionStoreBundle()
    const envelope = await storage.load()
    this.memoryOnly = false
    this.queueDirty = false
    this.pendingEngineState = null
    this.libraryQueueTotal = null
    if (!envelope?.data) {
      this.cached = null
      return null
    }
    const session = envelope.data
    if ((!Array.isArray(session.queue) || session.queue.length === 0) && !session.libraryQueue) {
      this.cached = null
      return null
    }
    this.cached = { session, revision: envelope.revision }
    return this.cached
  }

  /**
   * Adopts the renderer's pre-unload snapshot. With playback resume enabled the
   * existing session envelope (and its revision) is reused so position/track
   * updates survive an unexpected exit; with resume disabled the snapshot lives
   * in memory only and is dropped when the UI comes back.
   */
  async adoptRendererSnapshot(snapshot: AfterglowRendererSnapshot): Promise<void> {
    const nextSession: PlaybackSession = {
      version: 1,
      savedAt: new Date().toISOString(),
      mode: 'trackAndPosition',
      playMode: normalizePersistedPlayMode(snapshot.playMode, undefined),
      track: snapshot.track,
      position: snapshot.position,
      ...(snapshot.libraryQueue
        ? {
            libraryQueue: { ...snapshot.libraryQueue, index: snapshot.queueIndex }
          }
        : { queue: snapshot.queue, queueIndex: snapshot.queueIndex })
    }
    this.pendingEngineState = null
    this.libraryQueueTotal = null
    const cached = { session: nextSession, revision: 0 }
    this.cached = cached
    if (runtime.appSettings.playbackResumeMode === 'off') {
      this.memoryOnly = true
      this.queueDirty = false
      return
    }
    try {
      const { storage } = getPlaybackSessionStoreBundle()
      const envelope = await storage.load()
      if (this.cached !== cached) return
      this.memoryOnly = false
      this.queueDirty = true
      cached.session = {
        ...nextSession,
        mode: envelope?.data?.mode ?? nextSession.mode,
        ...(envelope?.data?.sleepTimer ? { sleepTimer: envelope.data.sleepTimer } : {})
      }
      cached.revision = envelope?.revision ?? 0
      await this.writeCurrent()
    } catch (error) {
      // The in-memory snapshot is sufficient for Afterglow. A locked, corrupt
      // or read-only playback-session store must not block the UI unload; keep
      // serving restore/handoff from memory and skip further disk writes.
      console.warn(
        '[afterglow] playback session persistence unavailable; continuing in memory:',
        error
      )
      if (this.cached === cached) this.memoryOnly = true
    }
  }

  /** Releases main's cached ownership after handoff; durable files remain intact. */
  clearRuntimeSnapshot(): void {
    this.pendingEngineState = null
    this.memoryOnly = false
    this.queueDirty = false
    this.libraryQueueTotal = null
    this.cached = null
  }

  getCachedSession(): PlaybackSession | null {
    return this.cached?.session ?? null
  }

  /** A fired/cancelled timer must not survive in an older disk session. */
  syncSleepTimer(state: SleepTimerState | null): void {
    if (!this.cached) return
    const { sleepTimer: _previous, ...session } = this.cached.session
    this.cached.session = {
      ...session,
      ...(state?.active ? { sleepTimer: { ...state } } : {})
    }
    if (!this.memoryOnly) this.enqueueWrite({ force: true })
  }

  getCachedQueue(): unknown[] {
    const queue = this.cached?.session.queue
    return Array.isArray(queue) ? queue : []
  }

  getCachedQueueLength(): number {
    return this.cached?.session.libraryQueue
      ? (this.libraryQueueTotal ?? 0)
      : this.getCachedQueue().length
  }

  /** Adopt a confirmed order/mode transaction while presentation is suspended.
   * The current occurrence and decoder stay the same even if shuffle moved it. */
  adoptLibraryQueueMode(
    expected: LibraryPlaybackQueueReference,
    queue: LibraryQueueSnapshot,
    mode: PlayMode
  ): void {
    const cached = this.cached
    const current = cached?.session.libraryQueue
    if (
      !cached ||
      !current ||
      this.engineTail ||
      current.id !== expected.id ||
      current.revision !== expected.revision ||
      current.index !== expected.index ||
      current.entryId !== expected.entryId ||
      queue.id !== expected.id ||
      queue.selectedEntryId !== expected.entryId ||
      (queue.playMode !== undefined && queue.playMode !== mode) ||
      !Number.isSafeInteger(queue.revision) ||
      queue.revision < expected.revision ||
      !Number.isSafeInteger(queue.index) ||
      !Number.isSafeInteger(queue.total) ||
      queue.index < 0 ||
      queue.index >= queue.total ||
      !['sequential', 'listLoop', 'repeat', 'shuffle', 'heart'].includes(mode)
    )
      throw new Error('afterglow_library_queue_changed')
    this.libraryQueueTotal = queue.total
    cached.session = {
      ...cached.session,
      savedAt: new Date().toISOString(),
      playMode: mode,
      libraryQueue: {
        id: queue.id,
        revision: queue.revision,
        index: queue.index,
        entryId: expected.entryId
      }
    }
    if (!this.memoryOnly) this.enqueueWrite({ force: true })
  }

  /**
   * Mirrors the engine onto the persisted session. Track changes are written
   * immediately; position-only updates are throttled so a 4Hz status stream does
   * not turn into a 4Hz disk write.
   */
  applyEngineState(status: EnginePlaybackState, options: EngineSessionOptions = {}): Promise<void> {
    const cached = this.cached
    if (!cached || options.isCurrent?.() === false) return Promise.resolve()
    if (!cached.session.libraryQueue) {
      this.applyArrayEngineState(status, options, cached)
      return Promise.resolve()
    }
    // A slow SQL read retains one latest demand, never a promise/Track per tick.
    this.pendingEngineState = { status: { ...status }, options: { ...options }, cached }
    if (!this.engineTail) {
      const run = Promise.resolve().then(() => this.drainLibraryEngineState())
      this.engineTail = run
    }
    return this.engineTail
  }

  private async drainLibraryEngineState(): Promise<void> {
    try {
      while (this.pendingEngineState) {
        const request = this.pendingEngineState
        this.pendingEngineState = null
        await this.applyLibraryEngineState(request)
      }
    } catch (error) {
      this.pendingEngineState = null
      throw error
    } finally {
      this.engineTail = null
    }
  }

  private async applyLibraryEngineState(request: PendingEngineState): Promise<void> {
    const { status, options, cached } = request
    const current = () => this.cached === cached && options.isCurrent?.() !== false
    if (!current()) return
    const previousReference = cached.session.libraryQueue!
    let reference = previousReference
    const index = options.logicalIndex
    if (!Number.isSafeInteger(index) || index! < 0 || !options.entryId)
      throw new Error('afterglow_requires_mappable_current_track')
    let track = cached.session.track
    let nextReference = reference
    if (
      options.force ||
      this.libraryQueueTotal === null ||
      index !== reference.index ||
      options.entryId !== reference.entryId
    ) {
      const database = runtime.libraryDatabase?.database
      if (!database) throw new Error('afterglow_requires_library_database')
      if (options.force) {
        const actual = await database.getLibraryQueue(reference.id)
        if (!current()) return
        if (actual.revision !== reference.revision) {
          // Explicit restore can reconcile a lost cursor ACK, never replay it.
          // Verify every already-loaded native occurrence against the new SQL
          // order, retaining only one detail page at a time.
          const entries = options.nativeEntries
          if (
            actual.selectedEntryId !== options.entryId ||
            actual.index !== index ||
            !entries?.length ||
            entries.some(
              (entry) =>
                !Number.isSafeInteger(entry.index) || entry.index < 0 || entry.index >= actual.total
            )
          )
            throw new Error('afterglow_library_queue_changed')
          for (const pageNumber of new Set(
            entries.map((entry) => Math.floor(entry.index / LIBRARY_PAGE_SIZE))
          )) {
            const page = await database.readLibraryQueue(
              reference.id,
              pageNumber * LIBRARY_PAGE_SIZE,
              LIBRARY_PAGE_SIZE,
              { expectedRevision: actual.revision }
            )
            if (!current()) return
            for (const entry of entries) {
              if (Math.floor(entry.index / LIBRARY_PAGE_SIZE) !== pageNumber) continue
              const row = page.items[entry.index % LIBRARY_PAGE_SIZE]
              if (row?.queueEntryId !== entry.queueEntryId || row.track?.id !== entry.id)
                throw new Error('afterglow_library_queue_changed')
            }
          }
          reference = {
            id: actual.id,
            revision: actual.revision,
            index: actual.index,
            entryId: actual.selectedEntryId!
          }
        }
      }
      nextReference = reference
      const page = await database.readLibraryQueue(reference.id, index, 1, {
        expectedRevision: reference.revision
      })
      if (!current()) return
      const newer = this.pendingEngineState
      if (
        newer &&
        (newer.options.logicalIndex !== index || newer.options.entryId !== options.entryId)
      )
        return
      const item = page.items[0]
      if (
        page.revision !== reference.revision ||
        page.offset !== index ||
        index! >= page.total ||
        item?.position !== index ||
        item.queueEntryId !== options.entryId ||
        !item.track
      )
        throw new Error('afterglow_requires_mappable_current_track')
      this.libraryQueueTotal = page.total
      track = { ...item.track, queueEntryId: item.queueEntryId }
      if (reference.entryId !== item.queueEntryId || reference.index !== index) {
        const result = await database.editLibraryQueue(reference.id, reference.revision, {
          kind: 'select',
          entryId: item.queueEntryId
        })
        // A dispatched commit belongs to this source even if its presentation
        // was stopped meanwhile. Retain its new CAS revision before draining
        // the latest demand; a replaced source must not receive the reply.
        if (this.cached !== cached) return
        if (result.queue.selectedEntryId !== item.queueEntryId || result.queue.index !== index)
          throw new Error('afterglow_library_queue_changed')
        nextReference = {
          id: result.queue.id,
          revision: result.queue.revision,
          entryId: item.queueEntryId,
          index: index!
        }
      }
    }
    if (this.cached !== cached) return
    const changed =
      nextReference.entryId !== previousReference.entryId ||
      nextReference.revision !== previousReference.revision
    this.updateSession(status, options, cached, track, { libraryQueue: nextReference }, changed)
  }

  private applyArrayEngineState(
    status: EnginePlaybackState,
    options: EngineSessionOptions,
    cached: LoadedPlaybackSession
  ): void {
    const queue = Array.isArray(cached.session.queue) ? cached.session.queue : []
    const resolved =
      typeof options.logicalIndex === 'number' &&
      Number.isInteger(options.logicalIndex) &&
      options.logicalIndex >= 0 &&
      options.logicalIndex < queue.length
        ? options.logicalIndex
        : resolveAfterglowQueueIndex(queue, status)
    const index = resolved
    if (index < 0) return

    const track = queue[index] ?? cached.session.track
    const trackChanged =
      cached.session.track !== track ||
      cached.session.queueIndex !== index ||
      afterglowTrackPathOf(cached.session.track) !== afterglowTrackPathOf(track)
    this.updateSession(status, options, cached, track, { queueIndex: index }, trackChanged)
  }

  private updateSession(
    status: EnginePlaybackState,
    options: EngineSessionOptions,
    cached: LoadedPlaybackSession,
    track: unknown,
    cursor: Pick<PlaybackSession, 'libraryQueue' | 'queueIndex'>,
    trackChanged: boolean
  ): void {
    const now = Date.now()
    const positionDue = now - this.lastPositionWriteAt >= POSITION_PERSIST_INTERVAL_MS
    const playMode = cached.session.libraryQueue
      ? cached.session.playMode // Native sequential describes a window, not logical shuffle/listLoop.
      : normalizePersistedPlayMode(status.playMode, cached.session.playMode)
    const modeChanged = playMode !== cached.session.playMode

    cached.session = {
      ...cached.session,
      savedAt: new Date(now).toISOString(),
      track,
      ...cursor,
      position: Number.isFinite(status.position) ? Math.max(0, status.position) : 0,
      playMode
    }
    if (this.memoryOnly) return
    if (!options.force && !trackChanged && !modeChanged && !positionDue) return
    this.lastPositionWriteAt = now
    if (trackChanged) {
      this.enqueueWrite({ force: true })
      return
    }
    this.enqueueWrite({ force: false })
  }

  /** Flushes any pending engine-state change before the process exits or restores. */
  async flush(): Promise<void> {
    await this.engineTail
    if (this.memoryOnly) return
    await this.writeTail
    await this.writeCurrent()
  }

  private enqueueWrite(options: { force: boolean }): void {
    if (options.force) this.lastPositionWriteAt = Date.now()
    this.writeTail = this.writeTail.then(
      () =>
        this.writeCurrent().catch((error) => {
          console.warn('[afterglow] failed to persist playback session:', error)
        }),
      () => undefined
    )
  }

  private async writeCurrent(): Promise<void> {
    const cached = this.cached
    if (!cached || this.memoryOnly) return
    const { storage } = getPlaybackSessionStoreBundle()
    for (let attempt = 0; attempt <= MAX_CAS_RETRIES; attempt += 1) {
      if (this.cached !== cached || this.memoryOnly) return
      try {
        const saved = await storage.save(
          this.queueDirty ? cached.session : { ...cached.session, queue: undefined },
          cached.revision
        )
        if (this.cached === cached) this.queueDirty = false
        cached.revision = saved.revision
        return
      } catch (error) {
        if (!(error instanceof PersistentDataRevisionConflictError)) throw error
        // Another writer (a still-alive renderer, or a personal restore) moved
        // the revision. Adopt it and retry with our in-memory state.
        const current = error.current
        if (!current || !current.data) return
        cached.revision = current.revision
      }
    }
  }
}

const normalizePersistedPlayMode = (
  value: string | undefined,
  fallback: PlaybackSession['playMode']
): PlaybackSession['playMode'] => {
  return value === 'sequential' ||
    value === 'listLoop' ||
    value === 'repeat' ||
    value === 'shuffle' ||
    value === 'heart'
    ? value
    : fallback
}

export const playbackSessionService = new PlaybackSessionService()
