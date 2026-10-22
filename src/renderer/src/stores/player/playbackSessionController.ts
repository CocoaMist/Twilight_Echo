import type { Ref } from 'vue'
import type { PlaybackSession, Track } from '../../types/music'
import type { AppSettings, PlaybackResumeMode, PlayMode } from '../../types/settings'
import type { SleepTimerState } from '../../../../shared/sleepTimer.ts'
import { playbackSessionWriter } from '../../app/playbackSessionWriter.ts'
import type { LibraryPlaybackQueueReference } from '../../../../shared/playbackSession.ts'
import {
  getRestorableSleepTimerState,
  createSleepTimerController
} from '../sleepTimerController.ts'
import {
  cloneTrackForPlaybackQueue,
  cloneTrackForPlaybackSession
} from '../../utils/playerSessionTrack.ts'
import { clampCuePlaybackPosition, cueDuration } from '../../utils/cuePlayback.ts'
import { toPlaybackQueueSnapshots } from '../../utils/playbackQueueVirtualization.ts'
import {
  onLocalTracksUnavailable,
  pruneUnavailableLocalTracks
} from '../../utils/localTrackRemovalPolicy.ts'

export interface PlaybackSessionControllerOptions {
  getLibraryQueueReference?: () => LibraryPlaybackQueueReference | null
  restoreLibraryQueue?: (
    session: PlaybackSession,
    isCurrent: () => boolean
  ) => Promise<{
    track: Track
    reference: LibraryPlaybackQueueReference
    playMode?: PlayMode
  } | null>
  detachLibraryQueue?: () => void
  currentTrack: Ref<Track | null>
  queue: Ref<Track[]>
  originalQueue: Ref<Track[]>
  queueIndex: Ref<number>
  playMode: Ref<PlayMode>
  duration: Ref<number>
  currentTime: Ref<number>
  isPlaying: Ref<boolean>
  isLoading: Ref<boolean>
  sleepTimerState: Ref<SleepTimerState | null>
  getAppSettings: () => Ref<AppSettings>
  getSleepTimerController: () => ReturnType<typeof createSleepTimerController>
  hydratePlaybackTrack: (track: Track) => Track
  resetPlaybackRuntimeStateForRestore: () => void
  setPlayModeInternal: (mode: PlayMode, options?: { persist?: boolean }) => void
  loadLyricsForTrack: (track: Track) => void
  clearCrossfadeTimer: () => void
  setCurrentTimeImmediate: (time: number, clockAlreadyUpdated?: boolean) => void
  clearSleepTimerIntervals: () => void
  flushLatestCurrentTime: () => void
  queueNativeQueueStateSync: () => Promise<void>
  deleteAutomaticLyricsBaseline: (trackId: string) => void
  getRestoredPlaybackPending: () => boolean
  setRestoredPlaybackPending: (value: boolean) => void
  getRestoredPlaybackPosition: () => number
  setRestoredPlaybackPosition: (value: number) => void
  getPendingLoadStartTime: () => number
  setPendingLoadStartTime: (value: number) => void
  getAutoAdvanceInFlight: () => boolean
  setAutoAdvanceInFlight: (value: boolean) => void
  getAdvancingFromEndedTrackId: () => string
  setAdvancingFromEndedTrackId: (value: string) => void
  getNativePlaybackActive: () => boolean
}

// 换曲同步 watch 每首触发一次全队列克隆+落盘；快速连切时合并为一次写。
// 退出路径由 usePlaybackSessionPersistence.savePlaybackSessionForQuit 独立兜底，
// 不依赖此防抖的即时性。
const PERSIST_SELECTED_SESSION_DEBOUNCE_MS = 1200

export function createPlaybackSessionController(options: PlaybackSessionControllerOptions) {
  let persistSessionDebounceTimer: ReturnType<typeof setTimeout> | null = null

  function cancelPersistSessionDebounce(): void {
    if (persistSessionDebounceTimer !== null) {
      clearTimeout(persistSessionDebounceTimer)
      persistSessionDebounceTimer = null
    }
  }

  function writeSelectedTrackSession(): void {
    if (playbackSessionWriter.requestAutosave()) return
    const mode = options.getAppSettings().value.playbackResumeMode
    if (mode === 'off') return

    // 快照在防抖触发时才构建，连切只保留最新状态的一份克隆。
    const dataApi = window.api?.data
    if (!dataApi) return

    const queueRef = options.queue.value
    const session = createPlaybackSession(mode)
    if (!session) return
    const write = playbackSessionWriter.saveSnapshot(dataApi, session, queueRef, () =>
      queueRef.map(cloneTrackForPlaybackQueue)
    )
    void write.completion.catch((err) => {
      console.warn('保存已选曲目播放会话失败:', err)
    })
  }

  function persistSelectedTrackSession(): void {
    cancelPersistSessionDebounce()
    // Once App persistence is running, both producers use its single timer.
    if (playbackSessionWriter.requestAutosave()) return
    persistSessionDebounceTimer = setTimeout(() => {
      persistSessionDebounceTimer = null
      writeSelectedTrackSession()
    }, PERSIST_SELECTED_SESSION_DEBOUNCE_MS)
  }

  function clearPersistedSelectedTrackSession(): void {
    // 取消挂起的防抖写，否则它会在显式清理之后重新写一份过期会话。
    cancelPersistSessionDebounce()
    const dataApi = window.api?.data
    if (!dataApi) return
    const write = playbackSessionWriter.clear(dataApi)
    void write.completion.catch((error) => {
      console.warn('清理不可用队列的播放会话失败:', error)
    })
  }

  function persistPlaybackSessionAfterQueueMutation(): void {
    if (
      !options.currentTrack.value ||
      options.getAppSettings().value.playbackResumeMode === 'off'
    ) {
      clearPersistedSelectedTrackSession()
      return
    }
    persistSelectedTrackSession()
  }

  function restorePlaybackSession(
    session: PlaybackSession,
    isCurrent = () => true
  ): void | Promise<boolean> {
    if (session.libraryQueue) return restoreLibraryPlaybackSession(session, isCurrent)
    if (!isCurrent()) return
    options.detachLibraryQueue?.()
    if (session.playMode) {
      options.setPlayModeInternal(session.playMode, { persist: false })
    }

    const savedQueue =
      Array.isArray(session.queue) && session.queue.length > 0
        ? session.queue.map(cloneTrackForPlaybackSession)
        : [cloneTrackForPlaybackSession(session.track)]
    const queue = toPlaybackQueueSnapshots(savedQueue)
    const rawIndex = session.queueIndex
    let savedIndex = session.track.queueEntryId
      ? queue.findIndex(
          (item) => item.queueEntryId === session.track.queueEntryId && item.id === session.track.id
        )
      : -1
    if (
      savedIndex === -1 &&
      typeof rawIndex === 'number' &&
      Number.isInteger(rawIndex) &&
      rawIndex >= 0 &&
      rawIndex < queue.length &&
      queue[rawIndex].id === session.track.id
    ) {
      savedIndex = rawIndex
    }
    if (savedIndex === -1) savedIndex = queue.findIndex((item) => item.id === session.track.id)
    const sameSelection =
      savedIndex >= 0 &&
      (!session.track.queueEntryId || queue[savedIndex].queueEntryId === session.track.queueEntryId)
    if (savedIndex === -1) savedIndex = 0
    const track = queue[savedIndex]
    const position =
      sameSelection && session.mode === 'trackAndPosition'
        ? clampCuePlaybackPosition(track, session.position)
        : 0
    options.queue.value = queue
    options.originalQueue.value = [...queue]
    options.queueIndex.value = savedIndex
    const selectedTrack =
      sameSelection && session.track.cover && !track.cover
        ? { ...track, cover: session.track.cover, coverSource: session.track.coverSource ?? null }
        : track
    prepareQueueSelection(selectedTrack, position)
    options.clearSleepTimerIntervals()
    const sleepTimer = getRestorableSleepTimerState(session.sleepTimer)
    if (sleepTimer) {
      options.getSleepTimerController().applyAuthoritativeState(sleepTimer)
      void window.api.sleepTimer?.configure(sleepTimer).catch(() => {})
    }
  }

  async function restoreLibraryPlaybackSession(
    session: PlaybackSession,
    isCurrent: () => boolean
  ): Promise<boolean> {
    if (!isCurrent()) return false
    if (!options.restoreLibraryQueue) throw new Error('数据库播放队列恢复尚未接入')
    const restored = await options.restoreLibraryQueue(session, isCurrent)
    if (!restored || !isCurrent()) return false
    if (restored.track.queueEntryId !== restored.reference.entryId)
      throw new Error('数据库播放队列恢复的 occurrence 不匹配')
    const mode = restored.playMode ?? session.playMode
    if (mode) options.setPlayModeInternal(mode, { persist: false })
    // These arrays retain their legacy full-queue meaning. A database window
    // belongs to its source, never to queue or originalQueue.
    options.queue.value = []
    options.originalQueue.value = []
    options.queueIndex.value = -1
    const sameSelection =
      session.track.id === restored.track.id &&
      session.libraryQueue?.entryId === restored.reference.entryId
    prepareQueueSelection(
      restored.track,
      sameSelection && session.mode === 'trackAndPosition'
        ? clampCuePlaybackPosition(restored.track, session.position)
        : 0
    )
    options.clearSleepTimerIntervals()
    const sleepTimer = getRestorableSleepTimerState(session.sleepTimer)
    if (sleepTimer) {
      options.getSleepTimerController().applyAuthoritativeState(sleepTimer)
      void window.api.sleepTimer?.configure(sleepTimer).catch(() => {})
    }
    return true
  }

  function prepareQueueSelection(track: Track | null, position = 0): void {
    options.resetPlaybackRuntimeStateForRestore()
    options.clearCrossfadeTimer()
    const hydrated = track
      ? options.hydratePlaybackTrack(cloneTrackForPlaybackSession(track))
      : null
    options.currentTrack.value = hydrated
    options.duration.value = hydrated ? cueDuration(hydrated) : 0
    options.isPlaying.value = false
    options.isLoading.value = false
    options.setRestoredPlaybackPending(!!hydrated)
    options.setRestoredPlaybackPosition(position)
    options.setPendingLoadStartTime(0)
    options.setAutoAdvanceInFlight(false)
    options.setAdvancingFromEndedTrackId('')
    options.setCurrentTimeImmediate(position)
    if (hydrated) options.loadLyricsForTrack(hydrated)
  }

  function createPlaybackSession(mode: PlaybackResumeMode): PlaybackSession | null {
    const track = options.currentTrack.value
    if (!track || mode === 'off') return null
    const libraryQueue = options.getLibraryQueueReference?.()
    if (libraryQueue && libraryQueue.entryId !== track.queueEntryId)
      throw new Error('数据库播放队列与当前曲目不匹配')

    options.flushLatestCurrentTime()
    const rawPosition =
      mode === 'trackAndPosition'
        ? Math.max(0, Number.isFinite(options.currentTime.value) ? options.currentTime.value : 0)
        : 0
    const position =
      options.duration.value > 0
        ? Math.min(rawPosition, Math.max(0, options.duration.value - 1))
        : rawPosition

    return {
      version: 1,
      savedAt: new Date().toISOString(),
      mode,
      playMode: options.playMode.value === 'heart' ? 'sequential' : options.playMode.value,
      track: cloneTrackForPlaybackSession(track),
      position,
      ...(libraryQueue
        ? { libraryQueue: { ...libraryQueue } }
        : { queueIndex: options.queueIndex.value }),
      ...(options.sleepTimerState.value?.active
        ? { sleepTimer: options.sleepTimerState.value }
        : {})
    }
  }

  function clearPendingPlaybackPosition(): void {
    options.setRestoredPlaybackPending(false)
    options.setRestoredPlaybackPosition(0)
  }

  function consumePendingPlaybackPosition(track: Track, startTime: number): number {
    const position = options.getRestoredPlaybackPosition()
    const resumeAt =
      options.getRestoredPlaybackPending() && Number.isFinite(position)
        ? clampCuePlaybackPosition(track, position)
        : startTime
    clearPendingPlaybackPosition()
    return resumeAt
  }

  function removeUnavailableTracks(trackIds: string[], filePaths: string[]): void {
    for (const trackId of trackIds) options.deleteAutomaticLyricsBaseline(trackId)
    const nextState = pruneUnavailableLocalTracks(
      {
        currentTrack: options.currentTrack.value,
        queue: options.queue.value,
        originalQueue: options.originalQueue.value,
        queueIndex: options.queueIndex.value
      },
      trackIds,
      filePaths
    )
    const queueChanged =
      nextState.queue.length !== options.queue.value.length ||
      nextState.originalQueue.length !== options.originalQueue.value.length ||
      nextState.queueIndex !== options.queueIndex.value

    options.queue.value = nextState.queue
    options.originalQueue.value = nextState.originalQueue
    options.queueIndex.value = nextState.queueIndex
    if (nextState.activeTrackRemoved) {
      options.clearCrossfadeTimer()
      options.resetPlaybackRuntimeStateForRestore()
      options.currentTrack.value = null
      options.isPlaying.value = false
      options.isLoading.value = false
      options.duration.value = 0
      options.setCurrentTimeImmediate(0)
      clearPersistedSelectedTrackSession()
      return
    }

    options.currentTrack.value = nextState.currentTrack
    if (queueChanged) persistPlaybackSessionAfterQueueMutation()
    if (options.getNativePlaybackActive()) {
      void options.queueNativeQueueStateSync().catch((error) => {
        console.warn('[audio-engine] Failed to synchronize queue after library removal:', error)
      })
    }
  }

  onLocalTracksUnavailable(removeUnavailableTracks)

  return {
    persistSelectedTrackSession,
    clearPersistedSelectedTrackSession,
    persistPlaybackSessionAfterQueueMutation,
    restorePlaybackSession,
    prepareQueueSelection,
    createPlaybackSession,
    clearPendingPlaybackPosition,
    consumePendingPlaybackPosition,
    removeUnavailableTracks
  }
}
