import type { PlaybackInfo } from '../../shared/audioEngineTypes.ts'
import type { TrackData } from '../../shared/track.ts'
import type { ListeningStats, ListeningTrackStatWithId } from '../../shared/listeningStats.ts'
import type { ListeningStatsClearRange } from '../../shared/listeningStatsHistory.ts'
import {
  clearListeningStatsHistory,
  isListeningStatsClearRange,
  previewListeningStatsClear
} from '../../shared/listeningStatsHistory.ts'
import type {
  CoreStatisticsQuery,
  CoreStatisticsPage,
  CoreStatisticsSummary
} from '../../shared/coreStatistics.ts'
import type { CoreStatisticsOverview } from '../../shared/coreStatistics.ts'
import { summarizeRecordedTracks } from '../../shared/listeningRecordedSummary.ts'
import { projectCoreError, projectCoreTrack } from '../projections.ts'
import { CoreStatisticsRepository, type StatisticsCheckpoint } from './repository.ts'
import { createLibraryListeningProjection } from './libraryProjection.ts'
import {
  LISTENING_TICK_SECONDS,
  LISTENING_STATS_FLUSH_DELAY_MS,
  LISTENING_STATS_RETRY_DELAY_MS,
  LISTENING_STATS_MAX_TRACKS,
  buildLastPlayedByTrackId,
  buildLastPlayedBySource,
  cloneTrack,
  compactListeningStatsForPersistence,
  compareMostListenedTracks,
  compareRecentTracks,
  compareTopTracks,
  dayKey,
  recordListeningOutcome,
  recordListeningSeconds
} from './model.ts'
import { selectTopArtists } from './model.ts'

interface Capture {
  generation: number
  replacement: number
  checkpoint: StatisticsCheckpoint
}
export interface CoreStatisticsOptions {
  repository: CoreStatisticsRepository
  now(): number
  timers: {
    setTimeout(callback: () => void, delay: number): unknown
    clearTimeout(handle: unknown): void
  }
  history?: ReturnType<typeof createLibraryListeningProjection>
  changed(): void
}

/** Only the authoritative playback session can record listening. Client
 * attachment, queries and window lifecycle never start trackers or add counts. */
export class CoreStatisticsService {
  private stats: ListeningStats = { days: {}, tracks: {} }
  private initialized = false
  private stopped = false
  private generation = 0
  private revision = 0
  private replace = 0
  private savedReplacement = 0
  private readonly dirtyTracks = new Map<string, number>()
  private readonly dirtyDays = new Map<string, number>()
  private pending: Capture | null = null
  private work: Promise<void> | null = null
  private flushTimer: unknown = null
  private tickTimer: unknown = null
  private lastCompactedDay = ''
  private lastCountedId = ''
  private lastCountedAt = 0
  private current: {
    track: TrackData | null
    info: Pick<PlaybackInfo, 'state' | 'position' | 'duration'>
  } | null = null
  private failureCount = 0
  private error: string | null = null
  private readonly options: CoreStatisticsOptions
  constructor(options: CoreStatisticsOptions) {
    this.options = options
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.stats = await this.options.repository.load()
    this.initialized = true
    this.compact()
    await this.options.history?.ensure()
    this.updateTimer()
  }
  getRevision(): number {
    return this.revision
  }
  historySnapshot(): ReadonlyMap<string, number> {
    return new Map([...buildLastPlayedByTrackId(this.stats), ...buildLastPlayedBySource(this.stats)])
  }
  exportData(): ListeningStats {
    return structuredClone(this.stats)
  }
  summary(): CoreStatisticsSummary {
    return {
      revision: this.revision,
      trackCount: Object.keys(this.stats.tracks).length,
      days: { ...this.stats.days },
      persistence: {
        dirty: this.isDirty(),
        failureCount: this.failureCount,
        error: this.error ? projectCoreError(this.error) : null
      }
    }
  }
  async overview(): Promise<CoreStatisticsOverview> {
    await this.options.history?.ensure()
    const providerByArtist = new Map<string, string>()
    for (const stat of Object.values(this.stats.tracks)) {
      const provider = stat.sourceIds?.find((source) => source.source !== 'local')?.source
      if (provider && !providerByArtist.has(stat.artist)) providerByArtist.set(stat.artist, provider)
    }
    return {
      ...this.summary(),
      recorded: summarizeRecordedTracks(this.stats.tracks),
      artists: selectTopArtists(this.stats, 50).map((artist) => ({
        ...artist, cover: cachedCover(artist.cover), coverSource: null,
        sourceIds: artist.sourceIds.slice(0, 200),
        providerId: providerByArtist.get(artist.name) ?? null
      })),
      history: { ...(this.options.history?.state.value ?? {
        mode: null, ready: false, pending: false, revision: null, error: ''
      }) }
    }
  }
  previewClear(range: ListeningStatsClearRange, revision: number) {
    if (revision !== this.revision) throw Object.assign(new Error('Listening history changed'), { code: 'STALE_REVISION' })
    return { ...previewListeningStatsClear(this.stats, range), revision }
  }
  page(query: CoreStatisticsQuery): CoreStatisticsPage {
    if (query.revision !== undefined && query.revision !== this.revision)
      throw Object.assign(new Error('Listening history changed; restart the paged query'), {
        code: 'STALE_REVISION'
      })
    const offset = query.offset ?? 0,
      limit = query.limit ?? 100
    const sort = query.sort ?? 'recent'
    const entries: ListeningTrackStatWithId[] = Object.entries(this.stats.tracks)
      .filter(([, stat]) =>
        sort === 'recent'
          ? stat.lastPlayed > 0
          : sort === 'seconds'
            ? stat.seconds > 0
            : stat.seconds > 0 || stat.plays > 0
      )
      .map(([id, stat]) => ({ id, ...stat }))
    entries.sort(
      sort === 'recent'
        ? compareRecentTracks
        : sort === 'seconds'
          ? compareMostListenedTracks
          : compareTopTracks
    )
    return {
      revision: this.revision,
      total: entries.length,
      offset,
      items: entries.slice(offset, offset + limit).map((stat) => ({
        cover: cachedCover(stat.cover),
        sourceIds: (stat.sourceIds ?? []).slice(0, 200),
        id: stat.id,
        seconds: stat.seconds,
        plays: stat.plays,
        skips: stat.skips,
        completions: stat.completions,
        lastPlayed: stat.lastPlayed,
        title: stat.title,
        artist: stat.artist,
        track: stat.track ? projectCoreTrack(stat.track) : null
      }))
    }
  }
  observe(
    track: TrackData | null,
    info: Pick<PlaybackInfo, 'state' | 'position' | 'duration'>
  ): void {
    if (this.stopped) return
    const previous = this.current
    if (this.initialized && previous?.track && previous.track.id !== track?.id) {
      const key = recordListeningOutcome(
        this.stats,
        previous.track,
        previous.info.position,
        previous.info.duration,
        this.options.now()
      )
      if (key) this.mark(key)
    }
    // Keep the full CUE/SACD identity inside Core; public pages have allowlisted DTOs.
    this.current = { track: track ? cloneTrack(track) : null, info: { ...info } }
    const changedTrack = previous?.track?.id !== track?.id
    if (changedTrack) this.clearTick()
    this.updateTimer()
    if (this.initialized && info.state !== 'playing' && previous?.info.state === 'playing')
      void this.flush().catch(() => {})
  }
  private updateTimer(): void {
    if (
      !this.initialized ||
      this.stopped ||
      !this.current?.track ||
      this.current.info.state !== 'playing'
    ) {
      this.clearTick()
      return
    }
    if (this.tickTimer !== null) return
    this.tickTimer = this.options.timers.setTimeout(() => {
      this.tickTimer = null
      const current = this.current
      if (current?.track && current.info.state === 'playing' && !this.stopped) {
        const now = this.options.now()
        const key = recordListeningSeconds(
          this.stats,
          current.track,
          LISTENING_TICK_SECONDS,
          now,
          this.lastCountedId === current.track.id ? 0 : 1
        )
        this.lastCountedId = current.track.id
        this.lastCountedAt = now
        this.mark(key, dayKey(now))
      }
      this.updateTimer()
    }, LISTENING_TICK_SECONDS * 1000)
  }
  private mark(track: string, day?: string): void {
    const version = ++this.generation
    this.dirtyTracks.set(track, version)
    if (day) this.dirtyDays.set(day, version)
    this.revision++
    this.options.history?.refresh()
    this.schedule(LISTENING_STATS_FLUSH_DELAY_MS)
    this.options.changed()
  }
  private compact(): void {
    const today = dayKey(this.options.now())
    if (
      today === this.lastCompactedDay &&
      Object.keys(this.stats.tracks).length <= LISTENING_STATS_MAX_TRACKS
    )
      return
    if (compactListeningStatsForPersistence(this.stats, this.options.now())) {
      this.replace = ++this.generation
      this.revision++
      this.options.history?.refresh()
      this.schedule(LISTENING_STATS_FLUSH_DELAY_MS)
    }
    this.lastCompactedDay = today
  }
  async clear(range: ListeningStatsClearRange, expectedRevision: number): Promise<void> {
    if (!isListeningStatsClearRange(range)) throw new Error('请选择有效的开始和结束日期')
    if (expectedRevision !== this.revision)
      throw Object.assign(new Error('Listening history changed; refresh before clearing'), {
        code: 'STALE_REVISION'
      })
    clearListeningStatsHistory(this.stats, range)
    this.replace = ++this.generation
    this.revision++
    const countedDay = dayKey(this.lastCountedAt)
    if (range === null || (countedDay >= range.startDay && countedDay <= range.endDay)) {
      this.lastCountedId = ''
      this.lastCountedAt = 0
    }
    this.options.history?.refresh()
    this.options.changed()
    await this.flush()
  }
  private isDirty(): boolean {
    return (
      this.replace !== this.savedReplacement ||
      this.dirtyTracks.size > 0 ||
      this.dirtyDays.size > 0 ||
      this.pending !== null
    )
  }
  private capture(): Capture {
    const replacement = this.replace,
      replace = replacement !== this.savedReplacement
    const tracks = replace
      ? Object.entries(this.stats.tracks)
      : [...this.dirtyTracks.keys()]
          .filter((key) => Object.hasOwn(this.stats.tracks, key))
          .map((key) => [key, this.stats.tracks[key]] as const)
    const days = replace
      ? Object.entries(this.stats.days)
      : [...this.dirtyDays.keys()]
          .filter((key) => Object.hasOwn(this.stats.days, key))
          .map((key) => [key, this.stats.days[key]] as const)
    return {
      generation: this.generation,
      replacement,
      checkpoint: structuredClone({
        replace,
        tracks: tracks.map(([key, value]) => ({ key, value })),
        days: days.map(([key, value]) => ({ key, value }))
      })
    }
  }
  private acknowledge(capture: Capture): void {
    for (const [key, version] of this.dirtyTracks)
      if (version <= capture.generation) this.dirtyTracks.delete(key)
    for (const [key, version] of this.dirtyDays)
      if (version <= capture.generation) this.dirtyDays.delete(key)
    this.savedReplacement = capture.replacement
  }
  flush(): Promise<void> {
    this.clearFlush()
    if (this.work) return this.work.then(() => (this.isDirty() ? this.flush() : undefined))
    if (!this.initialized) return Promise.resolve()
    this.work = (async () => {
      try {
        if (this.pending) {
          const committed = await this.options.repository.recover()
          if (committed) this.acknowledge(this.pending)
          this.pending = null
        }
        this.compact()
        if (this.isDirty()) {
          this.pending = this.capture()
          await this.options.repository.publish(this.pending.checkpoint)
          this.acknowledge(this.pending)
          this.pending = null
        }
        this.failureCount = 0
        this.error = null
        if (this.isDirty()) this.schedule(LISTENING_STATS_FLUSH_DELAY_MS)
      } catch (error) {
        this.failureCount++
        this.error = projectCoreError(error)
        this.clearFlush()
        this.schedule(LISTENING_STATS_RETRY_DELAY_MS)
        throw error
      } finally {
        this.options.changed()
      }
    })().finally(() => {
      this.work = null
    })
    return this.work
  }
  private schedule(delay: number): void {
    if (this.flushTimer !== null || this.stopped) return
    this.flushTimer = this.options.timers.setTimeout(() => {
      this.flushTimer = null
      void this.flush().catch(() => {})
    }, delay)
  }
  private clearFlush(): void {
    if (this.flushTimer !== null) this.options.timers.clearTimeout(this.flushTimer)
    this.flushTimer = null
  }
  private clearTick(): void {
    if (this.tickTimer !== null) this.options.timers.clearTimeout(this.tickTimer)
    this.tickTimer = null
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    this.clearTick()
    this.clearFlush()
    await this.flush()
    await this.options.history?.drain()
    this.options.history?.dispose()
  }
}
function cachedCover(cover: string | null): string | null {
  return cover?.startsWith('cover://') ? cover : null
}
