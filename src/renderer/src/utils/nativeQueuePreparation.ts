import type { Track, TrackSource } from '../types/music'
import type { PlayMode } from '../types/settings'
import { MAX_NATIVE_QUEUE_ITEMS } from '../../../shared/nativeQueue.ts'
import { playModeWrapsAtQueueEnd, toNativePlayMode } from '../../../shared/playbackModes.ts'
import { isTwilightMediaGrantTarget, shouldUseNativePlaybackTarget } from './playbackRouting.ts'

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/

export interface NativeQueueLoadItem {
  id: string
  queueEntryId?: string
  logicalQueueEnd?: boolean
  source: string
  duration?: number
  format?: string
  sampleRate?: number
  bitrate?: number
  bitDepth?: number
  measuredIntegratedLufs?: number
  measuredTruePeakDb?: number
  replayGainTrackGainDb?: number
  replayGainAlbumGainDb?: number
  replayGainTrackPeak?: number
  replayGainAlbumPeak?: number
  r128TrackGainDb?: number
  r128AlbumGainDb?: number
  cueRange?: Track['cueRange']
}

export interface LibraryNativeQueueEntry {
  id: string
  queueEntryId: string
  /** Absolute position in the frozen database queue. */
  index: number
}
export interface LibraryNativeQueueReference {
  id: string
  revision: number
}
export interface LibraryNativeQueueMapping extends LibraryNativeQueueReference {
  entries: LibraryNativeQueueEntry[]
}

export interface PreparedNativeQueue {
  items: NativeQueueLoadItem[]
  startIndex: number
  delegated: boolean
  /** Logical indices for a partial queue. Such a window must never loop itself. */
  queueIndices?: number[]
  /** Explicit database mapping: never index a global Track[] with these positions. */
  libraryQueue?: LibraryNativeQueueMapping
}

export interface PrepareNativeQueueOptions {
  queue: Track[]
  currentTrack: Track
  currentTarget: string
  currentIndex: number
  playMode?: PlayMode
  /** `queue` contains only a bounded detail window, not the global queue. */
  libraryQueue?: LibraryNativeQueueReference & {
    positions: readonly number[]
    /** Complete frozen queue length, not the resident detail-window length. */
    total?: number
    lastPlayablePosition?: number
  }
  /** Only the main-issued queue token may commit this speculative reuse. */
  canReuseQueue?: (items: NativeQueueLoadItem[]) => boolean
  isCurrent?: () => boolean
  isAudioFileAuthorized: (filePath: string) => Promise<boolean>
  /**
   * Authorizes a whole queue in one IPC round-trip. Optional so the per-file
   * boundary above remains the contract; this falls back to it when absent or
   * when the batch answer does not line up with the request.
   */
  areAudioFilesAuthorized?: (filePaths: string[]) => Promise<boolean[]>
}

export type PreparePlayerNativeQueueOptions = Omit<
  PrepareNativeQueueOptions,
  'isAudioFileAuthorized'
>

export interface PlayerNativeQueueBoundary {
  isAudioFileAuthorized: PrepareNativeQueueOptions['isAudioFileAuthorized']
  areAudioFilesAuthorized?: PrepareNativeQueueOptions['areAudioFilesAuthorized']
}

/** Actual PlayerStore boundary: renderer identities cross preload once, while
 * filesystem authority remains owned by the main process. */
export async function preparePlayerNativeQueue(
  options: PreparePlayerNativeQueueOptions,
  boundary: PlayerNativeQueueBoundary
): Promise<PreparedNativeQueue | null> {
  if (options.isCurrent?.() === false) return null
  return prepareNativeQueue({ ...options, ...boundary })
}

export async function prepareNativeQueue(
  options: PrepareNativeQueueOptions
): Promise<PreparedNativeQueue | null> {
  if (options.libraryQueue) validateLibraryWindow(options)
  const prepared = await prepareNativeQueueContents(options)
  if (!prepared) return null
  if (!options.libraryQueue) {
    // Partial array windows also carry logical EOF policy. Missing metadata on
    // full native queues retains native shuffle-order and legacy behavior.
    if (prepared.delegated) return prepared
    const indices = prepared.queueIndices ?? [findCurrentQueueIndex(options)]
    return {
      ...prepared,
      queueIndices: indices,
      items: prepared.items.map((item, index) => ({
        ...item,
        logicalQueueEnd:
          options.playMode !== 'repeat' &&
          options.playMode !== 'heart' &&
          indices[index] === options.queue.length - 1
      }))
    }
  }
  const indices =
    prepared.queueIndices ??
    (prepared.delegated
      ? prepared.items.map((_, index) => index)
      : [findCurrentQueueIndex(options)])
  const entries = indices.map(
    (index): LibraryNativeQueueEntry => ({
      id: options.queue[index].id,
      queueEntryId: options.queue[index].queueEntryId!,
      index: options.libraryQueue!.positions[index]
    })
  )
  return {
    ...prepared,
    ...(options.libraryQueue.total !== undefined
      ? {
          items: prepared.items.map((item, index) => ({
            ...item,
            logicalQueueEnd:
              options.playMode !== 'repeat' &&
              entries[index].index ===
                (options.libraryQueue!.lastPlayablePosition ?? options.libraryQueue!.total! - 1)
          }))
        }
      : {}),
    delegated: false,
    queueIndices: entries.map((entry) => entry.index),
    libraryQueue: { id: options.libraryQueue.id, revision: options.libraryQueue.revision, entries }
  }
}

function validateLibraryWindow(options: PrepareNativeQueueOptions): void {
  const window = options.libraryQueue!
  if (
    typeof window.id !== 'string' ||
    !window.id ||
    window.id.length > 128 ||
    !Number.isSafeInteger(window.revision) ||
    window.revision < 0 ||
    !options.queue.length ||
    options.queue.length > MAX_NATIVE_QUEUE_ITEMS ||
    !Array.isArray(window.positions) ||
    window.positions.length !== options.queue.length ||
    window.positions.some((position) => !Number.isSafeInteger(position) || position < 0) ||
    (window.total !== undefined &&
      (!Number.isSafeInteger(window.total) ||
        window.total <= 0 ||
        window.positions.some((position) => position >= window.total!))) ||
    (window.lastPlayablePosition !== undefined &&
      (!Number.isSafeInteger(window.lastPlayablePosition) ||
        window.lastPlayablePosition < 0 ||
        window.total === undefined ||
        window.lastPlayablePosition >= window.total)) ||
    new Set(window.positions).size !== window.positions.length ||
    typeof options.currentTrack.queueEntryId !== 'string' ||
    !options.currentTrack.queueEntryId ||
    options.queue.some(
      (track) =>
        typeof track.queueEntryId !== 'string' ||
        !track.queueEntryId ||
        track.queueEntryId.length > 128
    ) ||
    new Set(options.queue.map((track) => track.queueEntryId)).size !== options.queue.length ||
    findCurrentQueueIndex(options) < 0
  )
    throw new Error('Invalid database playback window')
}

async function prepareNativeQueueContents(
  options: PrepareNativeQueueOptions
): Promise<PreparedNativeQueue | null> {
  const currentItem = toQueueItem(
    options.currentTrack,
    getCurrentFallbackTarget(options.currentTrack, options.currentTarget),
    options.libraryQueue ? options.currentTrack.queueEntryId : undefined
  )
  if (!(await isNativeTargetAvailable(options.currentTrack, currentItem.source, options)))
    return null
  if (options.isCurrent?.() === false) return null

  const currentIndex = findCurrentQueueIndex(options)
  if (currentIndex < 0) return asCurrentOnly(currentItem)

  // A whole-library queue can exceed what one loadQueue IPC accepts. Delegating
  // it would be rejected by main before playback ever starts. Bound it before
  // authorization; NetEase can keep a playable upcoming entry in that window.
  if (options.queue.length > MAX_NATIVE_QUEUE_ITEMS) {
    return prepareNcmWindow(options, currentItem, currentIndex)
  }

  let items = options.queue.map((track, index) =>
    index === currentIndex
      ? currentItem
      : toQueueItem(
          track,
          getTrackTarget(track),
          options.libraryQueue ? track.queueEntryId : undefined
        )
  )
  if (options.libraryQueue?.total !== undefined)
    items = items.map((item, index) => ({
      ...item,
      logicalQueueEnd:
        options.playMode !== 'repeat' &&
        options.libraryQueue!.positions[index] ===
          (options.libraryQueue!.lastPlayablePosition ?? options.libraryQueue!.total! - 1)
    }))
  if (options.canReuseQueue?.(items)) return { items, startIndex: currentIndex, delegated: true }
  // Routing is decided locally; only the local-file entries need the authorization
  // boundary, and they are resolved together. Doing it per track cost one IPC
  // round-trip per queue entry before playback could start.
  const kinds = options.queue.map((track, index) =>
    classifyNativeTarget(track, items[index].source)
  )
  const authorized = await authorizeLocalTargets(
    kinds.flatMap((kind, index) => (kind === 'local' ? [items[index].source] : [])),
    options
  )
  if (options.isCurrent?.() === false) return null
  const available = kinds.every((kind, index) =>
    kind === 'local' ? authorized.get(items[index].source) === true : kind === 'remote'
  )
  if (available) {
    return { items, startIndex: currentIndex, delegated: true }
  }
  return prepareNcmWindow(options, currentItem, currentIndex)
}

/** Resolve only the immediate boundary; an unresolved later song must not
 * disarm an already playable next song. Keep manual next/previous in the
 * renderer until the entire logical queue is delegated. */
async function prepareNcmWindow(
  options: PrepareNativeQueueOptions,
  currentItem: NativeQueueLoadItem,
  currentIndex: number
): Promise<PreparedNativeQueue | null> {
  const mode = options.playMode ?? 'sequential'
  let nextIndex = currentIndex + 1
  if (nextIndex >= options.queue.length && playModeWrapsAtQueueEnd(mode)) nextIndex = 0
  const next = mode !== 'repeat' && mode !== 'heart' ? options.queue[nextIndex] : undefined
  if (getTrackSource(options.currentTrack) !== 'ncm' && (!next || getTrackSource(next) !== 'ncm')) {
    return asCurrentOnly(currentItem)
  }
  const prepared: PreparedNativeQueue = {
    items: [currentItem],
    startIndex: 0,
    delegated: false,
    queueIndices: [currentIndex]
  }
  if (next && nextIndex !== currentIndex) {
    const item = toQueueItem(
      next,
      getTrackTarget(next),
      options.libraryQueue ? next.queueEntryId : undefined
    )
    if (await isNativeTargetAvailable(next, item.source, options)) {
      prepared.items.push(item)
      prepared.queueIndices!.push(nextIndex)
    }
  }
  return options.isCurrent?.() === false ? null : prepared
}

export function preparedNativePlayMode(prepared: PreparedNativeQueue, mode: PlayMode) {
  return prepared.queueIndices && mode !== 'repeat' ? 'sequential' : toNativePlayMode(mode)
}

function asCurrentOnly(item: NativeQueueLoadItem): PreparedNativeQueue {
  return { items: [item], startIndex: 0, delegated: false }
}

function findCurrentQueueIndex(options: PrepareNativeQueueOptions): number {
  const candidate = options.queue[options.currentIndex]
  const matches = (track: Track) =>
    track.id === options.currentTrack.id &&
    (!options.currentTrack.queueEntryId || track.queueEntryId === options.currentTrack.queueEntryId)
  if (candidate && matches(candidate)) return options.currentIndex
  return options.queue.findIndex(matches)
}

function getTrackTarget(track: Track): string {
  return track.cueRange ? track.filePath : track.subTrack || track.streamUrl || track.filePath
}

/**
 * Prefer the already-resolved play target for the current track. That may be a
 * remote URL, a twilight-media grant, or an authorized managed-cache path
 * (ncm-cache) returned by the provider. Renderer-restored local fields on
 * provider tracks are not trusted unless they already are the resolved target
 * or an ordinary remote URL on the track.
 */
function getCurrentFallbackTarget(track: Track, currentTarget: string): string {
  if (getTrackSource(track) === 'local') return currentTarget
  const trimmed = currentTarget.trim()
  if (trimmed && (isAuthorizedRemoteUrl(trimmed) || isLocalFilesystemTarget(trimmed))) {
    return currentTarget
  }
  const onlineTarget = [track.subTrack, track.streamUrl, track.filePath].find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && isAuthorizedRemoteUrl(candidate)
  )
  return onlineTarget ?? ''
}

function getTrackSource(track: Pick<Track, 'id' | 'source'>): TrackSource {
  if (track.source) return track.source
  if (/^[a-zA-Z]:[\\/]/.test(track.id) || /^[\\/]/.test(track.id)) return 'local'
  const separatorIndex = track.id.indexOf(':')
  return (separatorIndex > 0 ? track.id.slice(0, separatorIndex) : 'local') as TrackSource
}

function toQueueItem(track: Track, source: string, queueEntryId?: string): NativeQueueLoadItem {
  const item: NativeQueueLoadItem = {
    id: track.id,
    ...(queueEntryId !== undefined ? { queueEntryId } : {}),
    duration: track.duration,
    source,
    format: track.format,
    sampleRate: track.sampleRate,
    bitrate: track.bitrate,
    bitDepth: track.bitDepth
  }
  if (track.cueRange) item.cueRange = { ...track.cueRange }
  if (
    typeof track.replayGainTrackGainDb === 'number' &&
    Number.isFinite(track.replayGainTrackGainDb)
  ) {
    item.replayGainTrackGainDb = track.replayGainTrackGainDb
  }
  if (
    typeof track.replayGainAlbumGainDb === 'number' &&
    Number.isFinite(track.replayGainAlbumGainDb)
  ) {
    item.replayGainAlbumGainDb = track.replayGainAlbumGainDb
  }
  if (typeof track.replayGainTrackPeak === 'number' && Number.isFinite(track.replayGainTrackPeak)) {
    item.replayGainTrackPeak = track.replayGainTrackPeak
  }
  if (typeof track.replayGainAlbumPeak === 'number' && Number.isFinite(track.replayGainAlbumPeak)) {
    item.replayGainAlbumPeak = track.replayGainAlbumPeak
  }
  if (typeof track.r128TrackGainDb === 'number' && Number.isFinite(track.r128TrackGainDb)) {
    item.r128TrackGainDb = track.r128TrackGainDb
  }
  if (typeof track.r128AlbumGainDb === 'number' && Number.isFinite(track.r128AlbumGainDb)) {
    item.r128AlbumGainDb = track.r128AlbumGainDb
  }
  return item
}

/**
 * Where a native target has to be checked: nowhere (unroutable), the authorized
 * remote-URL rules, or the main process's filesystem authorization boundary.
 * Mirrors the order isNativeTargetAvailable applies to a single target.
 */
type NativeTargetKind = 'unavailable' | 'remote' | 'local'

function classifyNativeTarget(track: Track, target: string): NativeTargetKind {
  if (!shouldUseNativePlaybackTarget(getTrackSource(track), target)) return 'unavailable'
  const trimmed = target.trim()
  if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmed)) return 'local'
  if (isAuthorizedRemoteUrl(target)) return 'remote'
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return 'unavailable'
  return 'local'
}

async function authorizeLocalTargets(
  targets: readonly string[],
  options: PrepareNativeQueueOptions
): Promise<Map<string, boolean>> {
  const verdicts = new Map<string, boolean>()
  const unique = [...new Set(targets)]
  if (unique.length === 0) return verdicts

  const batch = options.areAudioFilesAuthorized
  if (batch) {
    try {
      const results = await batch(unique)
      if (Array.isArray(results) && results.length === unique.length) {
        unique.forEach((target, index) => verdicts.set(target, results[index] === true))
        return verdicts
      }
    } catch {
      // Fall through to the per-file boundary rather than failing the queue.
    }
  }

  let nextIndex = 0
  await Promise.all(
    Array.from({ length: Math.min(16, unique.length) }, async () => {
      while (nextIndex < unique.length) {
        if (options.isCurrent?.() === false) return
        const target = unique[nextIndex++]
        verdicts.set(target, await isAuthorizedLocalFile(target, options))
      }
    })
  )
  return verdicts
}

async function isNativeTargetAvailable(
  track: Track,
  target: string,
  options: PrepareNativeQueueOptions
): Promise<boolean> {
  const kind = classifyNativeTarget(track, target)
  if (kind === 'unavailable') return false
  if (kind === 'remote') return true
  return await isAuthorizedLocalFile(target, options)
}

async function isAuthorizedLocalFile(
  target: string,
  options: PrepareNativeQueueOptions
): Promise<boolean> {
  try {
    return await options.isAudioFileAuthorized(target)
  } catch {
    return false
  }
}

function isLocalFilesystemTarget(target: string): boolean {
  const trimmed = target.trim()
  if (!trimmed) return false
  if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmed)) return true
  if (trimmed.startsWith('/') || trimmed.startsWith('\\\\')) return true
  return false
}

/** 8.4：预取/提交的 NCM 远程播放地址只在这个窗口内可信（CDN 签发链接会过期）。 */
export const NCM_STREAM_URL_MAX_AGE_MS = 10 * 60_000

export interface NcmStreamUrlFreshness {
  /** trackId → 最近一次播放解析提交该轨 streamUrl 的时间戳。 */
  committedAtByTrackId: ReadonlyMap<string, number>
  nowMs?: number
  maxAgeMs?: number
  quality?: Track['streamQuality']
}

/**
 * 剥离队列里过期或来路不明的 NCM 远程播放地址：只有提交时间在窗口内的
 * http(s) 或 twilight-media 地址才允许携带进原生队列；其余一律留空，由渲染层切曲时重解析
 * （provider 侧的磁盘缓存/TTL 内存缓存会让重解析近乎零成本）。本地缓存路径
 * 等非 http 目标是 provider 托管成品，不参与过期剥离。
 */
export function stripStaleNcmStreamUrls(
  queue: readonly Track[],
  freshness: NcmStreamUrlFreshness
): Track[] {
  const now = freshness.nowMs ?? Date.now()
  const maxAge = freshness.maxAgeMs ?? NCM_STREAM_URL_MAX_AGE_MS
  let changed = false
  const items = queue.map((track) => {
    if (getTrackSource(track) !== 'ncm') return track
    const streamUrl = track.streamUrl
    if (streamUrl && freshness.quality && track.streamQuality !== freshness.quality) {
      changed = true
      return { ...track, streamUrl: '' }
    }
    if (
      typeof streamUrl !== 'string' ||
      (!/^https?:\/\//i.test(streamUrl) && !isTwilightMediaGrantTarget(streamUrl))
    )
      return track
    const committedAt = freshness.committedAtByTrackId.get(track.id)
    if (committedAt != null && now - committedAt <= maxAge) return track
    changed = true
    return { ...track, streamUrl: '' }
  })
  return changed ? items : ([...queue] as Track[])
}

export function isAuthorizedRemoteUrl(target: string): boolean {
  // Opaque grants are already vetted when issued by main (protectProviderMedia).
  if (isTwilightMediaGrantTarget(target)) return true
  try {
    const parsed = new URL(target.trim())
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username &&
      !parsed.password
    )
  } catch {
    return false
  }
}
