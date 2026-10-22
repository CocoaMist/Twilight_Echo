import type { PlaybackInfo } from '../audio/audioEngineTypes.ts'
import type { MiniPlayerPlayMode, MiniPlayerStateSnapshot } from '../../shared/miniPlayer.ts'
import type { RemotePlayMode } from '../../shared/remoteControl.ts'
import { runtime } from '../core/runtime.ts'
import { normalizeAppSettings, writeAppSettings } from '../core/settings.ts'
import { updateDiscordActivity } from '../integrations/discord.ts'
import {
  getCoverCacheContentType,
  isCoverCacheFileName,
  readCoverCacheFileBytes,
  resizeCoverImageBytes
} from '../library/coverCache.ts'
import { playbackSessionService } from './playbackSessionService.ts'
import {
  resolveAfterglowEngineMapping,
  type AfterglowRestoreState
} from '../../shared/afterglowMode.ts'
import { libraryQueueResumeMode } from '../../shared/libraryDatabase.ts'

const SMTC_REFRESH_INTERVAL_MS = 1_000
const REMOTE_PUBLISH_INTERVAL_MS = 1_000
const MAX_REMOTE_COVER_BYTES = 180_000
const MAX_REMOTE_COVER_DATA_URL = 250_000
const SAFE_REMOTE_COVER_DATA_URL = /^data:image\/(?:png|jpe?g|webp);base64,/i

let listener: ((info: PlaybackInfo) => void) | null = null
let propertyListener: ((event: { name: string; data: unknown }) => void) | null = null
let lastEngineInfo: PlaybackInfo | null = null
let lastPresentationKey = ''
let lastSmtcRefreshAt = 0
let lastRemotePublishAt = 0
let lastRemoteCoverKey = ''
let lastRemoteCoverGeneration = 0
let presentationGeneration = 0
let infoRevision = 0
let pendingInfo: PlaybackInfo | null = null
let publishing: Promise<void> | null = null
/** Logical queue index for each native queue entry (window -> logical). */
let engineLogicalIndices: number[] | null = null

export function setAfterglowEngineMapping(mapping: number[] | null): void {
  engineLogicalIndices = mapping ? [...mapping] : null
}

export function getAfterglowEngineMapping(): number[] | null {
  return engineLogicalIndices ? [...engineLogicalIndices] : null
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const buildTrackSnapshot = (track: unknown): MiniPlayerStateSnapshot['track'] => {
  if (!track || typeof track !== 'object') return null
  const record = track as Record<string, unknown>
  const id = text(record.id)
  if (!id) return null
  return {
    id,
    title: text(record.title),
    artist: text(record.artist),
    album: text(record.album),
    albumArtist: text(record.albumArtist),
    trackNumber: number(record.trackNumber) ?? 0,
    cover: typeof record.cover === 'string' ? record.cover : null,
    format: typeof record.format === 'string' ? record.format : null,
    sampleRate: number(record.sampleRate),
    bitDepth: number(record.bitDepth),
    coverSource: typeof record.coverSource === 'string' ? record.coverSource : null
  }
}

const normalizePlayMode = (value: unknown): MiniPlayerPlayMode => {
  return value === 'listLoop' || value === 'repeat' || value === 'shuffle' || value === 'heart'
    ? value
    : 'sequential'
}

const buildSnapshot = (info: PlaybackInfo): MiniPlayerStateSnapshot | null => {
  const session = playbackSessionService.getCachedSession()
  if (!session) return null
  const queueLength = playbackSessionService.getCachedQueueLength()
  const track = buildTrackSnapshot(session.track)
  if (!track) return null
  return {
    capturedAtMs: Date.now(),
    track,
    isPlaying: info.state === 'playing',
    isLoading: false,
    currentTime: Number.isFinite(info.position) ? Math.max(0, info.position) : 0,
    duration: Number.isFinite(info.duration) ? Math.max(0, info.duration) : 0,
    playbackRate: info.playbackRate ?? 1,
    volume: Number.isFinite(info.volume) ? info.volume : 1,
    playMode: normalizePlayMode(session.libraryQueue ? session.playMode : info.playMode),
    favoriteAvailable: false,
    favoriteLiked: false,
    favoriteLoading: false,
    dominantColor: '',
    queueIndex: session.libraryQueue?.index ?? session.queueIndex ?? -1,
    queueLength
  }
}

const presentationKeyOf = (snapshot: MiniPlayerStateSnapshot): string =>
  [
    snapshot.track?.id ?? '',
    snapshot.isPlaying ? '1' : '0',
    snapshot.playMode,
    String(snapshot.queueIndex),
    String(snapshot.queueLength)
  ].join('\u0000')

const RENDERER_FREE_MODES = new Set(['sequential', 'listLoop', 'repeat', 'shuffle'])

const toRemotePlayMode = (mode: MiniPlayerPlayMode): RemotePlayMode => {
  if (mode === 'repeat') return 'single'
  if (mode === 'listLoop' || mode === 'shuffle') return 'loop'
  return 'sequence'
}

/**
 * The renderer publishes a small raster data URL as the remote cover. While it
 * is unloaded, read the same local cover cache and hand the web remote an
 * equivalent data URL (resized when the cached art is large).
 */
const resolveRemoteCoverDataUrl = async (
  cover: string | null | undefined
): Promise<string | null> => {
  if (!cover) return null
  if (SAFE_REMOTE_COVER_DATA_URL.test(cover)) {
    return cover.length <= MAX_REMOTE_COVER_DATA_URL ? cover : null
  }
  if (!cover.startsWith('cover://')) return null
  const fileName = cover.slice('cover://'.length).replace(/^\/+/, '')
  if (!isCoverCacheFileName(fileName)) return null
  const bytes = await readCoverCacheFileBytes(fileName)
  if (!bytes) return null
  let buffer: Uint8Array = bytes
  let mime = getCoverCacheContentType(fileName)
  if (buffer.byteLength > MAX_REMOTE_COVER_BYTES) {
    const resized = resizeCoverImageBytes(buffer, mime)
    if (!resized) return null
    buffer = resized.bytes
    mime = resized.mime
  }
  const dataUrl = `data:${mime};base64,${Buffer.from(buffer).toString('base64')}`
  return dataUrl.length <= MAX_REMOTE_COVER_DATA_URL ? dataUrl : null
}

const syncRemoteCover = (cover: string | null | undefined, key: string): void => {
  const generation = ++lastRemoteCoverGeneration
  void resolveRemoteCoverDataUrl(cover)
    .then((coverUrl) => {
      if (generation !== lastRemoteCoverGeneration || key !== lastRemoteCoverKey) return
      runtime.publishRemotePlaybackSnapshot?.({ coverUrl })
    })
    .catch(() => undefined)
}

/**
 * The tray changes the play mode through the renderer-free dispatcher. Persist
 * it so the recreated renderer's startup snapshot does not flip the engine back
 * to the stale mode it saved before the unload.
 */
const syncPlayModeSetting = (mode: string): void => {
  if (!RENDERER_FREE_MODES.has(mode)) return
  if (runtime.appSettings.playMode === mode) return
  runtime.appSettings = normalizeAppSettings({
    ...runtime.appSettings,
    playMode: mode as typeof runtime.appSettings.playMode
  })
  writeAppSettings(runtime.appSettings)
}

/** Keeps the LAN web remote and Discord presence alive without a renderer. */
const publishExternalSurfaces = (
  snapshot: MiniPlayerStateSnapshot,
  options: { keyChanged: boolean; engineState: PlaybackInfo['state'] }
): void => {
  const now = Date.now()
  if (options.keyChanged && runtime.appSettings.discordRpcEnabled && snapshot.track) {
    updateDiscordActivity({
      title: snapshot.track.title,
      artist: snapshot.track.artist,
      album: snapshot.track.album,
      playing: snapshot.isPlaying,
      startTime: snapshot.isPlaying ? Math.round(now - snapshot.currentTime * 1000) : undefined
    })
  }
  if (options.keyChanged) {
    const coverKey = `${snapshot.track?.id ?? ''}\u0000${snapshot.track?.cover ?? ''}`
    if (coverKey !== lastRemoteCoverKey) {
      lastRemoteCoverKey = coverKey
      syncRemoteCover(snapshot.track?.cover ?? null, coverKey)
    }
  }
  if (!options.keyChanged && now - lastRemotePublishAt < REMOTE_PUBLISH_INTERVAL_MS) return
  lastRemotePublishAt = now
  runtime.publishRemotePlaybackSnapshot?.({
    state:
      options.engineState === 'stopped' ? 'stopped' : snapshot.isPlaying ? 'playing' : 'paused',
    title: snapshot.track?.title ?? '',
    artist: snapshot.track?.artist ?? '',
    album: snapshot.track?.album ?? '',
    position: snapshot.currentTime,
    duration: snapshot.duration,
    volume: snapshot.volume,
    muted: snapshot.volume <= 0,
    queueIndex: snapshot.queueIndex,
    queueLength: snapshot.queueLength,
    isLive: false,
    castTarget: null,
    playMode: toRemotePlayMode(snapshot.playMode)
  })
}

/**
 * Drives the renderer-free surfaces (tray, SMTC, Discord mirror) from engine
 * state while Afterglow has no renderer to publish `MiniPlayerStateSnapshot`.
 */
export function applyAfterglowEngineState(
  info: PlaybackInfo,
  force = false,
  isCurrent?: () => boolean
): Promise<void> {
  const manager = runtime.audioEngineManager
  const queueToken = manager?.getQueueToken?.()
  // An unknown mutation leaves this mirror stale. Even identical media/CUE
  // sources cannot establish which occurrence the engine actually selected.
  if (playbackSessionService.getCachedSession()?.libraryQueue && !queueToken)
    return Promise.reject(new Error('afterglow_library_queue_changed'))
  const logicalIndex = engineLogicalIndices?.[info.queueIndex]
  const engineQueue = runtime.audioEngineManager?.getQueueSnapshot() ?? []
  if (
    playbackSessionService.getCachedSession()?.libraryQueue &&
    info.state !== 'stopped' &&
    info.source !== engineQueue[info.queueIndex]?.source
  )
    return Promise.reject(new Error('afterglow_requires_mappable_current_track'))
  return playbackSessionService.applyEngineState(
    {
      state: info.state,
      position: info.position,
      queueIndex: info.queueIndex,
      source: info.source,
      playMode: info.playMode
    },
    {
      force,
      isCurrent: () =>
        isCurrent?.() !== false &&
        manager === runtime.audioEngineManager &&
        queueToken === manager?.getQueueToken?.(),
      ...(typeof logicalIndex === 'number' && logicalIndex >= 0 ? { logicalIndex } : {}),
      entryId: engineQueue[info.queueIndex]?.queueEntryId,
      ...(force
        ? {
            nativeEntries: engineQueue.map((entry, native) => ({
              id: entry.id,
              queueEntryId: entry.queueEntryId ?? '',
              index: engineLogicalIndices?.[native] ?? -1
            }))
          }
        : {})
    }
  )
}

/** Read-only payload after the explicit restore owner has confirmed Stop.
 * No native index/source is used to choose SQL's durable occurrence. */
export async function buildStoppedLibraryRestoreState(
  isCurrent: () => boolean
): Promise<AfterglowRestoreState | null> {
  const manager = runtime.audioEngineManager
  const database = runtime.libraryDatabase?.database
  const session = playbackSessionService.getCachedSession()
  if (!manager || !database || !session?.libraryQueue || !isCurrent()) return null
  const queue = await database.getLibraryQueue(session.libraryQueue.id)
  if (!isCurrent()) throw new Error('afterglow_library_queue_changed')
  const row = queue.selectedEntryId
    ? (
        await database.readLibraryQueue(queue.id, queue.index, 1, {
          expectedRevision: queue.revision
        })
      ).items[0]
    : undefined
  const info = await manager.getPlaybackInfo()
  const latest = await database.getLibraryQueue(queue.id)
  if (
    !isCurrent() ||
    info.state !== 'stopped' ||
    latest.revision !== queue.revision ||
    latest.index !== queue.index ||
    latest.selectedEntryId !== queue.selectedEntryId ||
    (queue.selectedEntryId &&
      (row?.position !== queue.index || row.queueEntryId !== queue.selectedEntryId))
  )
    throw new Error('afterglow_library_queue_changed')
  return {
    recovery: 'native-queue-unknown',
    queueToken: '',
    queue: [],
    nativeQueueIndices: [],
    nativeQueueEntries: [],
    queueIndex: queue.index,
    queueLength: queue.total,
    ...(queue.selectedEntryId
      ? {
          libraryQueue: {
            id: queue.id,
            revision: queue.revision,
            index: queue.index,
            entryId: queue.selectedEntryId
          }
        }
      : {}),
    track: row?.track ? { ...row.track, queueEntryId: row.queueEntryId } : null,
    state: 'stopped',
    position: 0,
    duration: Math.max(0, number(row?.track?.duration) ?? 0),
    volume: Number.isFinite(info.volume) ? info.volume : 1,
    playbackRate: info.playbackRate ?? 1,
    playMode: libraryQueueResumeMode(queue, session.playMode ?? 'sequential')
  }
}

const publishSnapshot = (info: PlaybackInfo): void => {
  const snapshot = buildSnapshot(info)
  if (!snapshot) return
  runtime.latestMiniPlayerState = snapshot

  const key = presentationKeyOf(snapshot)
  const now = Date.now()
  const keyChanged = key !== lastPresentationKey
  if (keyChanged) {
    lastPresentationKey = key
    syncPlayModeSetting(snapshot.playMode)
    runtime.refreshTrayMenu?.()
    runtime.refreshWindowsSmtc?.()
    lastSmtcRefreshAt = now
    publishExternalSurfaces(snapshot, { keyChanged: true, engineState: info.state })
    return
  }
  if (snapshot.isPlaying && now - lastSmtcRefreshAt >= SMTC_REFRESH_INTERVAL_MS) {
    lastSmtcRefreshAt = now
    runtime.refreshWindowsSmtc?.()
  }
  publishExternalSurfaces(snapshot, { keyChanged: false, engineState: info.state })
}

const publishFromEngine = (info: PlaybackInfo): void => {
  lastEngineInfo = info
  infoRevision++
  pendingInfo = info
  if (publishing) return
  const generation = presentationGeneration
  const current = () => generation === presentationGeneration && listener !== null
  const run = Promise.resolve().then(async () => {
    try {
      while (current() && pendingInfo) {
        const next = pendingInfo
        pendingInfo = null
        await applyAfterglowEngineState(next, false, current)
        if (!current()) return
        if (!pendingInfo) publishSnapshot(next)
      }
    } catch (error) {
      if (current()) console.warn('[afterglow] failed to update playback state:', error)
    } finally {
      if (publishing === run) publishing = null
    }
  })
  publishing = run
}

export function startAfterglowPresentation(): void {
  stopAfterglowPresentation()
  lastPresentationKey = ''
  lastSmtcRefreshAt = 0
  lastRemotePublishAt = 0
  lastRemoteCoverKey = ''
  const manager = runtime.audioEngineManager
  if (!manager) return
  if (playbackSessionService.getCachedSession()?.libraryQueue && !manager.getQueueToken()) return
  const generation = presentationGeneration
  const onPlaybackInfo = (info: PlaybackInfo): void => {
    if (generation === presentationGeneration) publishFromEngine(info)
  }
  listener = onPlaybackInfo
  manager.on('playback-info', onPlaybackInfo)
  // `playback-info` drops position-only ticks. Progress still has to reach the
  // tray-adjacent snapshot, the web remote and the persisted session, so fold
  // the periodic `time-pos` property into the last engine snapshot.
  const onPropertyChange = (event: { name: string; data: unknown }): void => {
    if (event.name !== 'time-pos' || typeof event.data !== 'number' || !lastEngineInfo) return
    publishFromEngine({ ...lastEngineInfo, position: event.data })
  }
  propertyListener = onPropertyChange
  manager.on('property-change', onPropertyChange)
  // Publish the current state immediately; the next engine tick follows in 250ms.
  const revision = infoRevision
  void manager
    .getPlaybackInfo()
    .then((info) => {
      if (generation === presentationGeneration && revision === infoRevision)
        publishFromEngine(info)
    })
    .catch(() => undefined)
}

export function stopAfterglowPresentation(): void {
  presentationGeneration++
  infoRevision++
  pendingInfo = null
  publishing = null
  const manager = runtime.audioEngineManager
  if (manager && listener) manager.off('playback-info', listener)
  if (manager && propertyListener) manager.off('property-change', propertyListener)
  listener = null
  propertyListener = null
  lastEngineInfo = null
  lastPresentationKey = ''
  lastSmtcRefreshAt = 0
  lastRemotePublishAt = 0
  lastRemoteCoverKey = ''
  lastRemoteCoverGeneration++
}

export function refreshAfterglowPresentationNow(): void {
  const manager = runtime.audioEngineManager
  if (!manager || !listener) return
  const generation = presentationGeneration
  const revision = infoRevision
  void manager
    .getPlaybackInfo()
    .then((info) => {
      if (generation === presentationGeneration && revision === infoRevision)
        publishFromEngine(info)
    })
    .catch(() => undefined)
}

/** State handed to the recreated renderer so it adopts live playback. */
export async function buildRestoreState(): Promise<AfterglowRestoreState | null> {
  const manager = runtime.audioEngineManager
  if (!manager) return null
  const generation = presentationGeneration
  const info = await manager.getPlaybackInfo()
  const queueToken = manager.getQueueToken?.() ?? ''
  const engineQueue = manager.getQueueSnapshot()
  await applyAfterglowEngineState(
    info,
    true,
    () =>
      generation === presentationGeneration &&
      manager === runtime.audioEngineManager &&
      queueToken === (manager.getQueueToken?.() ?? '')
  )
  try {
    await playbackSessionService.flush()
  } catch (error) {
    console.warn('[afterglow] session persistence unavailable during live restore:', error)
  }
  const session = playbackSessionService.getCachedSession()
  if (!session || generation !== presentationGeneration) return null
  if (queueToken !== (manager.getQueueToken?.() ?? ''))
    throw new Error('afterglow_library_queue_changed')
  if (session.libraryQueue && !queueToken) throw new Error('afterglow_library_queue_changed')
  const queue = Array.isArray(session.queue) ? session.queue : []
  const queueLength = playbackSessionService.getCachedQueueLength()
  const mapping = session.libraryQueue
    ? engineLogicalIndices
    : resolveAfterglowEngineMapping(queue, engineQueue, engineLogicalIndices ?? undefined)
  if (
    !mapping ||
    mapping.length !== engineQueue.length ||
    (session.libraryQueue &&
      mapping.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= queueLength))
  )
    throw new Error('afterglow_requires_mappable_current_track')
  const logicalIndex = mapping[info.queueIndex]
  if (!(logicalIndex >= 0)) throw new Error('afterglow_requires_mappable_current_track')
  const nativeQueueEntries = session.libraryQueue
    ? engineQueue.map((entry, index) => {
        if (!entry.queueEntryId) throw new Error('afterglow_requires_mappable_current_track')
        return { id: entry.id, queueEntryId: entry.queueEntryId, index: mapping[index] }
      })
    : undefined
  const latest = await manager.getPlaybackInfo()
  if (
    generation !== presentationGeneration ||
    manager !== runtime.audioEngineManager ||
    queueToken !== (manager.getQueueToken?.() ?? '') ||
    latest.queueIndex !== info.queueIndex ||
    (session.libraryQueue &&
      (session.libraryQueue.index !== logicalIndex ||
        session.libraryQueue.entryId !== nativeQueueEntries?.[info.queueIndex]?.queueEntryId))
  )
    throw new Error('afterglow_library_queue_changed')
  return {
    queueToken,
    queueIndex: logicalIndex,
    queueLength,
    nativeQueueIndices: [...mapping],
    state: latest.state,
    position: Number.isFinite(latest.position) ? Math.max(0, latest.position) : 0,
    duration:
      session.libraryQueue &&
      latest.state === 'stopped' &&
      latest.source !== engineQueue[latest.queueIndex]?.source
        ? (engineQueue[latest.queueIndex]?.duration ??
          number((session.track as Record<string, unknown>)?.duration) ??
          0)
        : Number.isFinite(latest.duration)
          ? Math.max(0, latest.duration)
          : 0,
    volume: Number.isFinite(latest.volume) ? latest.volume : 1,
    playbackRate: latest.playbackRate ?? 1,
    playMode: (session.libraryQueue ? session.playMode : latest.playMode) ?? 'sequential',
    ...(session.libraryQueue
      ? {
          libraryQueue: { ...session.libraryQueue },
          nativeQueueEntries,
          track: {
            ...(session.track as Record<string, unknown>),
            streamUrl:
              latest.state === 'stopped' ? engineQueue[latest.queueIndex]?.source : latest.source
          }
        }
      : {}),
    queue
  }
}
