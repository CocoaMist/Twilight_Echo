import { onBeforeUnmount, watch, type Ref } from 'vue'
import type { MiniPlayerCommand, MiniPlayerStateSnapshot } from '../../../shared/miniPlayer'
import type { Track } from '../types/music'
import type { PlayMode } from '../types/settings'

interface MiniPlayerStateSource {
  track: Track | null
  isPlaying: boolean
  isLoading: boolean
  currentTime: number
  duration: number
  playbackRate: number
  volume: number
  playMode: PlayMode
  favoriteAvailable: boolean
  favoriteLiked: boolean
  favoriteLoading: boolean
  dominantColor: string
  queueIndex: number
  queueLength: number
}

interface MiniPlayerSyncOptions {
  positionAt?: () => number
  currentTrack: Ref<Track | null>
  isPlaying: Ref<boolean>
  isLoading: Ref<boolean>
  currentTime: Ref<number>
  duration: Ref<number>
  playbackRate: Ref<number>
  volume: Ref<number>
  playMode: Ref<PlayMode>
  favoriteAvailable: Ref<boolean>
  favoriteLiked: Ref<boolean>
  favoriteLoading: Ref<boolean>
  dominantColor: Ref<string>
  queueIndex: Ref<number>
  queue: Ref<Track[]>
  togglePlay: () => Promise<void>
  next: () => void
  prev: () => void
  seek: (time: number) => void
  setVolume: (volume: number) => void
  cyclePlayMode: () => void
  setPlayMode: (mode: PlayMode) => void
  toggleFavorite: () => Promise<void>
  openQueue?: () => void
}

export function buildMiniPlayerStateSnapshot(
  source: MiniPlayerStateSource
): MiniPlayerStateSnapshot {
  const track = source.track
  return {
    capturedAtMs: Date.now(),
    track: track
      ? {
          id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          albumArtist: track.albumArtist ?? '',
          trackNumber: typeof track.trackNumber === 'number' ? track.trackNumber : 0,
          cover: track.cover,
          format: track.format ?? null,
          sampleRate: typeof track.sampleRate === 'number' ? track.sampleRate : null,
          bitDepth: typeof track.bitDepth === 'number' ? track.bitDepth : null,
          coverSource: track.coverSource ?? null
        }
      : null,
    isPlaying: source.isPlaying,
    isLoading: source.isLoading,
    currentTime: source.currentTime,
    duration: source.duration,
    playbackRate: source.playbackRate,
    volume: source.volume,
    playMode: source.playMode,
    favoriteAvailable: source.favoriteAvailable,
    favoriteLiked: source.favoriteLiked,
    favoriteLoading: source.favoriteLoading,
    dominantColor: source.dominantColor,
    queueIndex: source.queueIndex,
    queueLength: source.queueLength
  }
}

/**
 * Coarse progress identity for the throttled currentTime path: satellite
 * windows extrapolate the clock themselves, so they only need a fresh snapshot
 * when the whole second changes, not on every 250 ms clock tick.
 */
export function miniPlayerProgressKey(currentTime: number): string {
  return String(Number.isFinite(currentTime) ? Math.floor(Math.max(0, currentTime)) : -1)
}

export const MINI_PLAYER_PROGRESS_THROTTLE_MS = 500

export interface MiniPlayerPublishSchedulerOptions {
  publish: () => void
  progressKey: () => string
  now?: () => number
  setTimeout?: (callback: () => void, delayMs: number) => unknown
  clearTimeout?: (handle: unknown) => void
  throttleMs?: number
}

export interface MiniPlayerPublishScheduler {
  /** Metadata / transport change: publish immediately and drop any pending progress publish. */
  publishNow: () => void
  /** Playback clock tick: publish only when the progress key changed, trailing-throttled. */
  notifyProgress: () => void
  dispose: () => void
}

/**
 * Splits mini player publishing into an immediate path (track, transport,
 * favourite, volume...) and a throttled progress path so the 250 ms playback
 * clock no longer fans out a full snapshot four times a second to the main
 * process, SMTC, tray and satellite windows.
 */
export function createMiniPlayerPublishScheduler(
  options: MiniPlayerPublishSchedulerOptions
): MiniPlayerPublishScheduler {
  const now = options.now ?? (() => Date.now())
  const schedule = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle as number))
  const throttleMs = Math.max(0, options.throttleMs ?? MINI_PLAYER_PROGRESS_THROTTLE_MS)
  let timer: unknown = null
  let lastPublishedAt = Number.NEGATIVE_INFINITY
  let lastProgressKey = ''
  let disposed = false

  function clearTimer(): void {
    if (timer === null) return
    cancel(timer)
    timer = null
  }

  function publishNow(): void {
    if (disposed) return
    clearTimer()
    lastProgressKey = options.progressKey()
    lastPublishedAt = now()
    options.publish()
  }

  function notifyProgress(): void {
    if (disposed || timer !== null) return
    if (options.progressKey() === lastProgressKey) return
    const elapsed = now() - lastPublishedAt
    if (elapsed >= throttleMs) {
      publishNow()
      return
    }
    timer = schedule(() => {
      timer = null
      if (disposed) return
      if (options.progressKey() !== lastProgressKey) publishNow()
    }, throttleMs - elapsed)
  }

  return {
    publishNow,
    notifyProgress,
    dispose: () => {
      disposed = true
      clearTimer()
    }
  }
}

export function useMiniPlayerSync(options: MiniPlayerSyncOptions): void {
  function publishState(): void {
    window.api.miniPlayer.publishState(
      buildMiniPlayerStateSnapshot({
        track: options.currentTrack.value,
        isPlaying: options.isPlaying.value,
        isLoading: options.isLoading.value,
        currentTime: options.positionAt?.() ?? options.currentTime.value,
        duration: options.duration.value,
        playbackRate: options.playbackRate.value,
        volume: options.volume.value,
        playMode: options.playMode.value,
        favoriteAvailable: options.favoriteAvailable.value,
        favoriteLiked: options.favoriteLiked.value,
        favoriteLoading: options.favoriteLoading.value,
        dominantColor: options.dominantColor.value,
        queueIndex: options.queueIndex.value,
        queueLength: options.queue.value.length
      })
    )
  }

  function runCommand(command: MiniPlayerCommand): void {
    switch (command.type) {
      case 'toggle-play':
        void options.togglePlay().catch((error) => {
          console.error('[mini-player] Failed to toggle playback:', error)
        })
        break
      case 'play':
        if (!options.isPlaying.value) {
          void options.togglePlay().catch((error) => {
            console.error('[mini-player] Failed to start playback:', error)
          })
        }
        break
      case 'pause':
        if (options.isPlaying.value) {
          void options.togglePlay().catch((error) => {
            console.error('[mini-player] Failed to pause playback:', error)
          })
        }
        break
      case 'previous':
        options.prev()
        break
      case 'next':
        options.next()
        break
      case 'open-queue':
        options.openQueue?.()
        break
      case 'seek':
        options.seek(command.value)
        break
      case 'set-volume':
        options.setVolume(command.value)
        break
      case 'cycle-play-mode':
        options.cyclePlayMode()
        break
      case 'set-play-mode':
        options.setPlayMode(command.value)
        break
      case 'toggle-favorite':
        void options.toggleFavorite().catch((error) => {
          console.error('[tray] Failed to toggle favorite:', error)
        })
        break
    }
  }

  const scheduler = createMiniPlayerPublishScheduler({
    publish: publishState,
    progressKey: () => miniPlayerProgressKey(options.currentTime.value)
  })

  const stopStateWatch = watch(
    [
      () => options.currentTrack.value?.id,
      () => options.currentTrack.value?.title,
      () => options.currentTrack.value?.artist,
      () => options.currentTrack.value?.album,
      () => options.currentTrack.value?.cover,
      () => options.currentTrack.value?.coverSource,
      options.isPlaying,
      options.isLoading,
      options.duration,
      options.playbackRate,
      options.volume,
      options.playMode,
      options.favoriteAvailable,
      options.favoriteLiked,
      options.favoriteLoading,
      options.dominantColor,
      options.queueIndex,
      () => options.queue.value.length
    ],
    () => scheduler.publishNow(),
    { immediate: true }
  )
  const stopProgressWatch = watch(options.currentTime, () => scheduler.notifyProgress())
  const removeCommandListener = window.api.miniPlayer.onCommand(runCommand)

  onBeforeUnmount(() => {
    stopStateWatch()
    stopProgressWatch()
    scheduler.dispose()
    removeCommandListener()
  })
}
