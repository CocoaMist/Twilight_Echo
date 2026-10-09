import { shallowRef, triggerRef, watch, type Ref } from 'vue'
import type { Track } from '../types/music'
import { ListeningStatsDatabase } from './listeningStatsDatabase.ts'
import { getLogicalTrackKey, normalizeLogicalTrackText } from '../utils/logicalTrackIdentity.ts'
import {
  ListeningStatsPersistence,
  type ListeningStatsPersistenceStatus,
  type ListeningStatsStorage
} from './listeningStatsPersistence.ts'
import {
  clearListeningStatsHistory,
  compactListeningTrackDays,
  isListeningStatsClearRange,
  normalizeListeningTrackDays,
  recordListeningTrackDay,
  type ListeningStatsClearRange,
  type ListeningTrackDayStat
} from '@renderer/stores/listeningStatsHistory.ts'

export interface ListeningTrackStat {
  seconds: number
  plays: number
  lastPlayed: number
  skips: number
  completions: number
  daily?: Record<string, ListeningTrackDayStat>
  undatedLastPlayed?: number
  title: string
  artist: string
  cover: string | null
  /** Durable remote cover origin for re-granting expired twilight-media handles. */
  coverSource?: string | null
  sourceIds?: ListeningTrackSourceId[]
  track?: Track
}

export interface ListeningTrackSourceId {
  source: string
  trackId: string
}

export interface ListeningArtistStat {
  id: string
  name: string
  seconds: number
  plays: number
  skips: number
  completions: number
  trackCount: number
  lastPlayed: number
  cover: string | null
  coverSource?: string | null
  sourceIds: string[]
}

export interface ListeningStats {
  days: Record<string, number>
  tracks: Record<string, ListeningTrackStat>
}

type ListeningTrackStatWithId = ListeningTrackStat & { id: string }

interface ListeningPlayerState {
  currentTrack: Ref<Track | null>
  isPlaying: Ref<boolean>
  currentTime: Ref<number>
  duration: Ref<number>
}

type ListeningTimerState = Pick<ListeningPlayerState, 'currentTrack' | 'isPlaying'>

const DASHBOARD_STATS_KEY = 'twilight-echo:listening-stats:v1'
const LISTENING_TICK_SECONDS = 5
const COMPLETION_RATIO = 0.9
const SKIP_RATIO = 0.5
export const LISTENING_STATS_RETENTION_DAYS = 730
export const LISTENING_STATS_MAX_TRACKS = 10_000
export const LISTENING_STATS_FLUSH_DELAY_MS = 30_000
export const LISTENING_STATS_RETRY_DELAY_MS = 60_000

const listeningStats = shallowRef<ListeningStats>(loadListeningStats())
const listeningDatabase =
  typeof indexedDB === 'undefined' ? null : new ListeningStatsDatabase(indexedDB)
let hydratingListeningStats = listeningDatabase !== null
const pendingListeningMutations: Array<(stats: ListeningStats) => void> = []
let lastCompactedDay = ''
let listeningStatsHydrationError: unknown = null
async function hydrateListeningStats(): Promise<void> {
  if (!listeningDatabase) return
  const saved = await listeningDatabase.load()
  if (saved) {
    const hydrated = {
      days: normalizeNumberRecord(saved.days),
      tracks: normalizeTrackStats(saved.tracks)
    }
    for (const mutate of pendingListeningMutations) mutate(hydrated)
    listeningStats.value = hydrated
    if (pendingListeningMutations.length) listeningDatabase.invalidate()
  }
  listeningStatsHydrationError = null
  hydratingListeningStats = false
  pendingListeningMutations.length = 0
  lastCompactedDay = ''
  if (
    (!saved &&
      (Object.keys(listeningStats.value.tracks).length > 0 ||
        Object.keys(listeningStats.value.days).length > 0)) ||
    listeningStatsPersistenceStatus.value.dirty
  )
    listeningStatsPersistence.markDirty()
}
const listeningStatsReady = listeningDatabase
  ? hydrateListeningStats().catch((error) => {
      // Never overwrite an unread database with the legacy/empty snapshot.
      // Keep startup mutations queued and retry hydration before a later save.
      listeningStatsHydrationError = error
      listeningStatsPersistence.markDirty()
    })
  : Promise.resolve()
function prepareListeningStats(): void {
  const today = dayKey(Date.now())
  if (
    today === lastCompactedDay &&
    Object.keys(listeningStats.value.tracks).length <= LISTENING_STATS_MAX_TRACKS
  )
    return
  if (compactListeningStatsForPersistence(listeningStats.value)) {
    listeningDatabase?.invalidate()
    triggerRef(listeningStats)
  }
  lastCompactedDay = today
}
const listeningStatsPersistenceStatus = shallowRef<ListeningStatsPersistenceStatus>({
  state: 'idle',
  dirty: false,
  failureCount: 0,
  lastError: null
})
const listeningStatsPersistence = new ListeningStatsPersistence<ListeningStats>({
  key: DASHBOARD_STATS_KEY,
  storage: getListeningStatsStorage(),
  ...(listeningDatabase
    ? {
        persistSnapshot: async (snapshot: ListeningStats) => {
          await listeningStatsReady
          if (listeningStatsHydrationError) await hydrateListeningStats()
          prepareListeningStats()
          // Hydration may have replaced the original object while awaiting load.
          await listeningDatabase.save(
            snapshot === listeningStats.value ? snapshot : listeningStats.value
          )
          globalThis.localStorage?.removeItem(DASHBOARD_STATS_KEY)
        }
      }
    : {}),
  getSnapshot: () => listeningStats.value,
  beforePersist: prepareListeningStats,
  onStatus: (status) => {
    listeningStatsPersistenceStatus.value = status
    if (status.state === 'error') {
      console.warn('[listening-stats] deferred local persistence failed', {
        failureCount: status.failureCount,
        reason: status.lastError
      })
    }
  },
  flushDelayMs: LISTENING_STATS_FLUSH_DELAY_MS,
  retryDelayMs: LISTENING_STATS_RETRY_DELAY_MS,
  document: typeof document === 'undefined' ? undefined : document,
  window: typeof window === 'undefined' ? undefined : window
})

let listeningTimer: number | null = null
let lastCountedTrackId = ''
let lastCountedTimestamp = 0
let trackerStarted = false
let lastOutcomeTrack: Track | null = null
let lastOutcomePosition = 0
let lastOutcomeDuration = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeNumberRecord(value: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    const numberValue = Number(raw)
    if (Number.isFinite(numberValue) && numberValue > 0) result[key] = numberValue
  }
  return result
}

function normalizeTrackStats(value: Record<string, unknown>): Record<string, ListeningTrackStat> {
  const result: Record<string, ListeningTrackStat> = {}
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue
    const seconds = Number(raw.seconds)
    const plays = Number(raw.plays)
    const lastPlayed = Number(raw.lastPlayed)
    const skips = Number(raw.skips)
    const completions = Number(raw.completions)
    result[id] = {
      seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
      plays: Number.isFinite(plays) && plays > 0 ? plays : 0,
      lastPlayed: Number.isFinite(lastPlayed) && lastPlayed > 0 ? lastPlayed : 0,
      skips: Number.isFinite(skips) && skips > 0 ? skips : 0,
      completions: Number.isFinite(completions) && completions > 0 ? completions : 0,
      daily: normalizeListeningTrackDays(raw.daily),
      undatedLastPlayed:
        Number.isFinite(Number(raw.undatedLastPlayed)) && Number(raw.undatedLastPlayed) > 0
          ? Number(raw.undatedLastPlayed)
          : 0,
      title: typeof raw.title === 'string' ? raw.title : 'Unknown Track',
      artist: typeof raw.artist === 'string' ? raw.artist : 'Unknown Artist',
      cover: typeof raw.cover === 'string' && raw.cover ? raw.cover : null,
      coverSource:
        typeof raw.coverSource === 'string' && raw.coverSource
          ? raw.coverSource
          : typeof raw.cover === 'string' && /^https?:\/\//i.test(raw.cover)
            ? raw.cover
            : null,
      sourceIds: Array.isArray(raw.sourceIds) ? normalizeSourceIds(raw.sourceIds) : undefined,
      track: isTrackSnapshot(raw.track) ? raw.track : undefined
    }
  }
  return result
}

function normalizeSourceIds(value: unknown[]): ListeningTrackSourceId[] {
  return value
    .filter(isRecord)
    .map((raw) => ({
      source: typeof raw.source === 'string' && raw.source ? raw.source : 'local',
      trackId: typeof raw.trackId === 'string' ? raw.trackId : ''
    }))
    .filter((item) => item.trackId.length > 0)
}

function isTrackSnapshot(value: unknown): value is Track {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.artist === 'string' &&
    typeof value.album === 'string' &&
    typeof value.filePath === 'string' &&
    typeof value.fileName === 'string' &&
    typeof value.duration === 'number' &&
    typeof value.size === 'number'
  )
}

function loadListeningStats(): ListeningStats {
  try {
    const parsed = JSON.parse(localStorage.getItem(DASHBOARD_STATS_KEY) || '')
    if (parsed && typeof parsed === 'object') {
      const stats = {
        days: isRecord(parsed.days) ? normalizeNumberRecord(parsed.days) : {},
        tracks: isRecord(parsed.tracks) ? normalizeTrackStats(parsed.tracks) : {}
      }
      compactListeningStatsForPersistence(stats)
      return stats
    }
  } catch {
    // Ignore corrupt local dashboard stats and start fresh.
  }
  return { days: {}, tracks: {} }
}

function getListeningStatsStorage(): ListeningStatsStorage {
  return {
    getItem: (key) => globalThis.localStorage?.getItem(key) ?? null,
    setItem: (key, value) => {
      if (!globalThis.localStorage) throw new Error('localStorage is unavailable')
      globalThis.localStorage.setItem(key, value)
    }
  }
}

export function compactListeningStatsForPersistence(
  stats: ListeningStats,
  now = Date.now()
): boolean {
  let changed = false
  const oldestDay = dayKey(now - LISTENING_STATS_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  for (const key of Object.keys(stats.days)) {
    if (key < oldestDay) {
      delete stats.days[key]
      changed = true
    }
  }

  const trackIds = Object.keys(stats.tracks)
  for (const id of trackIds) {
    if (compactListeningTrackDays(stats.tracks[id], oldestDay)) changed = true
  }
  if (trackIds.length <= LISTENING_STATS_MAX_TRACKS) return changed
  trackIds
    .sort((left, right) => {
      const byLastPlayed = stats.tracks[left].lastPlayed - stats.tracks[right].lastPlayed
      return byLastPlayed || left.localeCompare(right)
    })
    .slice(0, trackIds.length - LISTENING_STATS_MAX_TRACKS)
    .forEach((id) => {
      delete stats.tracks[id]
      changed = true
    })
  return changed
}

function commitListeningStats(mutator: (stats: ListeningStats) => void): void {
  if (hydratingListeningStats) pendingListeningMutations.push(mutator)
  mutator(listeningStats.value)
  triggerRef(listeningStats)
  listeningStatsPersistence.markDirty()
}

function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function addListeningSeconds(track: Track, seconds: number): void {
  recordListening(track, seconds, Date.now())
}

function recordListening(track: Track, seconds: number, timestamp: number): void {
  const today = dayKey(timestamp)
  const statKey = getListeningStatKey(track)
  const plays = lastCountedTrackId === track.id ? 0 : 1
  commitListeningStats((stats) => {
    stats.days[today] = (stats.days[today] ?? 0) + seconds
    const previous = stats.tracks[statKey] ?? createEmptyTrackStat(track)
    recordListeningTrackDay(previous, timestamp, { seconds, plays })
    stats.tracks[statKey] = {
      ...previous,
      seconds: previous.seconds + seconds,
      plays: previous.plays + plays,
      lastPlayed: timestamp,
      skips: previous.skips,
      completions: previous.completions,
      title: track.title || previous.title,
      artist: track.artist || previous.artist,
      ...pickCoverFields(track, previous),
      sourceIds: upsertSourceId(previous.sourceIds, track),
      track: cloneTrack(track)
    }
  })
  listeningDatabase?.markTrack(statKey)
  lastCountedTrackId = track.id
  lastCountedTimestamp = timestamp
}

function recordPlaybackOutcome(
  track: Track,
  {
    position,
    duration,
    timestamp
  }: {
    position: number
    duration: number
    timestamp: number
  }
): void {
  const normalizedDuration = Number.isFinite(duration) && duration > 0 ? duration : track.duration
  if (
    !Number.isFinite(position) ||
    !Number.isFinite(normalizedDuration) ||
    normalizedDuration <= 0
  ) {
    return
  }

  const ratio = Math.max(0, position) / normalizedDuration
  const outcome = ratio >= COMPLETION_RATIO ? 'completion' : ratio < SKIP_RATIO ? 'skip' : null
  if (!outcome) return

  const statKey = getListeningStatKey(track)
  commitListeningStats((stats) => {
    const previous = stats.tracks[statKey] ?? createEmptyTrackStat(track)
    recordListeningTrackDay(previous, timestamp, {
      skips: outcome === 'skip' ? 1 : 0,
      completions: outcome === 'completion' ? 1 : 0
    })
    stats.tracks[statKey] = {
      ...previous,
      lastPlayed: Math.max(previous.lastPlayed, timestamp),
      skips: previous.skips + (outcome === 'skip' ? 1 : 0),
      completions: previous.completions + (outcome === 'completion' ? 1 : 0),
      title: track.title || previous.title,
      artist: track.artist || previous.artist,
      ...pickCoverFields(track, previous),
      sourceIds: upsertSourceId(previous.sourceIds, track),
      track: cloneTrack(track)
    }
  })
  listeningDatabase?.markTrack(statKey)
}

function recordPlaybackTransition({
  previousTrack,
  nextTrack,
  position,
  duration,
  timestamp
}: {
  previousTrack: Track | null
  nextTrack: Track | null
  position: number
  duration: number
  timestamp: number
}): void {
  if (!previousTrack || previousTrack.id === nextTrack?.id) return
  recordPlaybackOutcome(previousTrack, { position, duration, timestamp })
}

function createEmptyTrackStat(track: Track): ListeningTrackStat {
  const coverFields = pickCoverFields(track)
  return {
    seconds: 0,
    plays: 0,
    lastPlayed: 0,
    skips: 0,
    completions: 0,
    daily: {},
    undatedLastPlayed: 0,
    title: track.title,
    artist: track.artist,
    cover: coverFields.cover,
    coverSource: coverFields.coverSource,
    sourceIds: []
  }
}

/** Prefer a durable remote origin so dashboard covers survive grant expiry. */
function pickCoverFields(
  track: Track,
  previous?: ListeningTrackStat
): { cover: string | null; coverSource: string | null } {
  const nextSource =
    (typeof track.coverSource === 'string' && track.coverSource.trim()) ||
    (typeof track.cover === 'string' && /^https?:\/\//i.test(track.cover.trim())
      ? track.cover.trim()
      : '') ||
    (typeof previous?.coverSource === 'string' && previous.coverSource.trim()) ||
    (typeof previous?.cover === 'string' && /^https?:\/\//i.test(previous.cover.trim())
      ? previous.cover.trim()
      : '') ||
    ''
  const nextCover =
    (typeof track.cover === 'string' && track.cover.trim()) ||
    (typeof previous?.cover === 'string' && previous.cover.trim()) ||
    ''
  return {
    cover: nextCover || null,
    coverSource: nextSource || null
  }
}

function upsertSourceId(
  sourceIds: ListeningTrackSourceId[] | undefined,
  track: Track
): ListeningTrackSourceId[] {
  const source = getTrackSource(track)
  const next = (sourceIds ?? []).filter((item) => item.trackId !== track.id)
  next.push({ source, trackId: track.id })
  return next
}

function getListeningStatKey(track: Track): string {
  return getLogicalTrackKey(track)
}

/** Build the lookup used by the library's optional last-played sort. */
export function buildLastPlayedByTrackId(
  stats: Pick<ListeningStats, 'tracks'>
): ReadonlyMap<string, number> {
  const result = new Map<string, number>()
  for (const stat of Object.values(stats.tracks)) {
    if (stat.track?.id) result.set(stat.track.id, stat.lastPlayed)
    for (const sourceId of stat.sourceIds ?? []) result.set(sourceId.trackId, stat.lastPlayed)
  }
  return result
}

function getTrackSource(track: Pick<Track, 'id' | 'source'>): string {
  if (track.source) return track.source
  const separatorIndex = track.id.indexOf(':')
  return separatorIndex > 0 ? track.id.slice(0, separatorIndex) : 'local'
}

function normalizeStatText(value: string | undefined): string {
  return normalizeLogicalTrackText(value)
}

function cloneTrack(track: Track): Track {
  // Shallow copy — cover is now a lightweight handle, lyrics excluded to save memory
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    filePath: track.filePath,
    fileName: track.fileName,
    dir: track.dir,
    duration: track.duration,
    size: track.size,
    cover: track.cover,
    coverSource: track.coverSource ?? null,
    lyrics: null,
    source: track.source,
    ncmSongId: track.ncmSongId,
    streamUrl: track.streamUrl,
    format: track.format,
    sampleRate: track.sampleRate,
    bitrate: track.bitrate,
    bitDepth: track.bitDepth
  }
}

function normalizeResultLimit(limit: number): number {
  if (!Number.isFinite(limit)) return Number.POSITIVE_INFINITY
  return Math.max(0, Math.floor(limit))
}

function collectTopItems<T>(
  items: Iterable<T>,
  limit: number,
  include: (item: T) => boolean,
  compare: (left: T, right: T) => number
): T[] {
  const max = normalizeResultLimit(limit)
  if (max <= 0) return []

  const selected: T[] = []
  for (const item of items) {
    if (!include(item)) continue
    let insertAt = -1
    for (let index = 0; index < selected.length; index++) {
      if (compare(item, selected[index]) < 0) {
        insertAt = index
        break
      }
    }
    if (insertAt === -1) {
      if (selected.length < max) selected.push(item)
      continue
    }
    selected.splice(insertAt, 0, item)
    if (selected.length > max) selected.pop()
  }
  return selected
}

function* listeningTrackEntries(): Iterable<ListeningTrackStatWithId> {
  for (const [id, stat] of Object.entries(listeningStats.value.tracks)) {
    yield { id, ...stat }
  }
}

function compareRecentTracks(
  left: ListeningTrackStatWithId,
  right: ListeningTrackStatWithId
): number {
  return right.lastPlayed - left.lastPlayed
}

function compareTopTracks(left: ListeningTrackStatWithId, right: ListeningTrackStatWithId): number {
  if (right.plays !== left.plays) return right.plays - left.plays
  if (right.seconds !== left.seconds) return right.seconds - left.seconds
  return right.lastPlayed - left.lastPlayed
}

function compareMostListenedTracks(
  left: ListeningTrackStatWithId,
  right: ListeningTrackStatWithId
): number {
  if (right.seconds !== left.seconds) return right.seconds - left.seconds
  if (right.plays !== left.plays) return right.plays - left.plays
  return right.lastPlayed - left.lastPlayed
}

function compareTopArtists(left: ListeningArtistStat, right: ListeningArtistStat): number {
  if (right.plays !== left.plays) return right.plays - left.plays
  if (right.seconds !== left.seconds) return right.seconds - left.seconds
  return right.lastPlayed - left.lastPlayed
}

function startListeningTimer(player: ListeningTimerState): void {
  stopListeningTimer()
  listeningTimer = window.setInterval(() => {
    const track = player.currentTrack.value
    if (!track || !player.isPlaying.value) return
    addListeningSeconds(track, LISTENING_TICK_SECONDS)
  }, LISTENING_TICK_SECONDS * 1000)
}

function stopListeningTimer(): void {
  if (listeningTimer !== null) {
    window.clearInterval(listeningTimer)
    listeningTimer = null
  }
}

export function setupListeningStatsTracking(player: ListeningPlayerState): void {
  if (trackerStarted) return
  trackerStarted = true
  const { currentTrack, isPlaying, currentTime, duration } = player
  lastOutcomeTrack = currentTrack.value
  lastOutcomePosition = currentTime.value
  lastOutcomeDuration = duration.value
  watch(
    [isPlaying, () => currentTrack.value?.id],
    ([playing, trackId]) => {
      if (!playing || !trackId) {
        stopListeningTimer()
        if (!playing) listeningStatsPersistence.flush()
        return
      }
      startListeningTimer({ currentTrack, isPlaying })
    },
    { immediate: true }
  )
  watch(
    [currentTrack, currentTime, duration],
    ([track, position, trackDuration], [previousTrack]) => {
      const previousSnapshot = lastOutcomeTrack
      if (previousSnapshot && previousSnapshot.id !== track?.id) {
        recordPlaybackTransition({
          previousTrack: previousSnapshot,
          nextTrack: track,
          position: lastOutcomePosition,
          duration: lastOutcomeDuration,
          timestamp: Date.now()
        })
      }
      lastOutcomeTrack = track
      lastOutcomePosition = position
      lastOutcomeDuration = trackDuration
      if (!previousTrack && track) {
        lastOutcomePosition = position
        lastOutcomeDuration = trackDuration
      }
    },
    { immediate: true }
  )
}

export function useListeningStatsStore(): {
  listeningStats: Ref<ListeningStats>
  persistenceStatus: Ref<ListeningStatsPersistenceStatus>
  clearListeningStats(range: ListeningStatsClearRange): boolean | Promise<boolean>
} {
  return {
    listeningStats,
    persistenceStatus: listeningStatsPersistenceStatus,
    clearListeningStats
  }
}

export function clearListeningStats(range: ListeningStatsClearRange): boolean | Promise<boolean> {
  if (!isListeningStatsClearRange(range)) throw new Error('请选择有效的开始和结束日期')
  commitListeningStats((stats) => clearListeningStatsHistory(stats, range))
  listeningDatabase?.invalidate()
  const countedDay = dayKey(lastCountedTimestamp)
  if (range === null || (countedDay >= range.startDay && countedDay <= range.endDay)) {
    lastCountedTrackId = ''
    lastCountedTimestamp = 0
  }
  return listeningStatsPersistence.flush()
}

export function getRecentTracks(limit = 100): ListeningTrackStatWithId[] {
  return collectTopItems(
    listeningTrackEntries(),
    limit,
    (stat) => stat.lastPlayed > 0,
    compareRecentTracks
  )
}

export function getTopTracks(limit = 100): ListeningTrackStatWithId[] {
  return collectTopItems(
    listeningTrackEntries(),
    limit,
    (stat) => stat.plays > 0 || stat.seconds > 0,
    compareTopTracks
  )
}

export function getMostListenedTracks(limit = 100): ListeningTrackStatWithId[] {
  return collectTopItems(
    listeningTrackEntries(),
    limit,
    (stat) => stat.seconds > 0,
    compareMostListenedTracks
  )
}

export function getTopArtists(limit = 50): ListeningArtistStat[] {
  const artists = new Map<string, ListeningArtistStat>()
  for (const stat of Object.values(listeningStats.value.tracks)) {
    const artistId = normalizeStatText(stat.artist)
    if (!artistId) continue
    const previous = artists.get(artistId)
    const sourceIds = stat.sourceIds?.map((source) => source.trackId) ?? []
    if (!previous) {
      artists.set(artistId, {
        id: artistId,
        name: stat.artist,
        seconds: stat.seconds,
        plays: stat.plays,
        skips: stat.skips,
        completions: stat.completions,
        trackCount: 1,
        lastPlayed: stat.lastPlayed,
        cover: stat.cover,
        coverSource: stat.coverSource ?? null,
        sourceIds: [...sourceIds]
      })
      continue
    }
    previous.seconds += stat.seconds
    previous.plays += stat.plays
    previous.skips += stat.skips
    previous.completions += stat.completions
    previous.trackCount += 1
    if (stat.lastPlayed >= previous.lastPlayed) {
      previous.name = stat.artist
      previous.lastPlayed = stat.lastPlayed
      previous.cover = stat.cover || previous.cover
      previous.coverSource = stat.coverSource || previous.coverSource
    }
    for (const sourceId of sourceIds) {
      if (!previous.sourceIds.includes(sourceId)) previous.sourceIds.push(sourceId)
    }
  }

  return collectTopItems(artists.values(), limit, () => true, compareTopArtists)
}

export function resetListeningStatsForTest(): void {
  listeningStatsPersistence.resetForTest()
  listeningStats.value = { days: {}, tracks: {} }
  lastCompactedDay = ''
  listeningDatabase?.invalidate()
  lastCountedTrackId = ''
  lastCountedTimestamp = 0
  lastOutcomeTrack = null
  lastOutcomePosition = 0
  lastOutcomeDuration = 0
}

export function flushListeningStatsForTest(): boolean | Promise<boolean> {
  return listeningStatsPersistence.flush()
}

export async function flushListeningStatsForExit(): Promise<void> {
  await listeningStatsReady
  if (!(await listeningStatsPersistence.flush()))
    throw new Error('Listening history could not be saved')
}

export async function waitForListeningStatsReady(): Promise<void> {
  await listeningStatsReady
  if (listeningStatsHydrationError) await hydrateListeningStats()
}

export function getListeningStatsPersistenceStatusForTest(): ListeningStatsPersistenceStatus {
  return listeningStatsPersistenceStatus.value
}

export function recordListeningForTest(track: Track, seconds: number, timestamp: number): void {
  recordListening(track, seconds, timestamp)
}

export function recordPlaybackOutcomeForTest(
  track: Track,
  options: { position: number; duration: number; timestamp: number }
): void {
  recordPlaybackOutcome(track, options)
}

export function recordPlaybackTransitionForTest(options: {
  previousTrack: Track | null
  nextTrack: Track | null
  position: number
  duration: number
  timestamp: number
}): void {
  recordPlaybackTransition(options)
}
