import { join } from 'node:path'
import type {
  BpmAnalysisResult,
  PlaybackInfo,
  LoudnormStatus
} from '../../shared/audioEngineTypes.ts'
import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import type { TrackData } from '../../shared/track.ts'
import { libraryTrack } from '../playback/libraryTrack.ts'
import { BpmAnalysisCache } from './bpmCache.ts'
import { BpmAnalysisManager, type BpmAnalysisRequestResult } from './bpmAnalysisManager.ts'
import { LoudnessAnalysisCache } from './loudnessCache.ts'
import {
  LoudnessAnalysisManager,
  type LoudnessAnalysisManagerOptions,
  type LoudnessAnalysisRequestResult
} from './loudnessAnalysisManager.ts'
import type { BpmAnalysisManagerOptions } from './bpmAnalysisManager.ts'

interface Options {
  root: string
  database: Pick<
    LibraryDatabaseApi,
    'getTracksByIds' | 'lookupTracksByPaths' | 'patchTracks' | 'queryTracks'
  >
  enabled(): boolean
  authorize(path: string): Promise<string>
  bpm: Pick<BpmAnalysisManagerOptions, 'analyzeFile' | 'cancelFile'>
  loudness: Pick<LoudnessAnalysisManagerOptions, 'analyzeFile' | 'cancelFile'>
  engine: {
    setLoudnessAnalysisManager(manager: LoudnessAnalysisManager | null): void
    notifyLoudnessCacheCleared(): Promise<void>
    getLoudnormStatus(): { status: LoudnormStatus; source: string | null }
  }
  applyBpm(track: TrackData, analysis: BpmAnalysisResult): void
  clearBpm(): void
  changed(): void
  failed(error: unknown): void
}

/** Playback observation, analysis caches and library commits have one Core lifetime. */
export class CoreAnalysisService {
  private readonly options: Options
  private readonly bpm: BpmAnalysisManager
  private readonly loudness: LoudnessAnalysisManager
  private readonly bpmCache: BpmAnalysisCache
  private readonly loudnessCache: LoudnessAnalysisCache
  private active = false
  private stopped = false
  private suspended = 0
  private generation = 0
  private observed = ''
  private readonly work = new Set<Promise<unknown>>()
  private readonly bpmWork = new Map<string, Promise<BpmAnalysisRequestResult>>()
  private maintenance: Promise<unknown> = Promise.resolve()

  constructor(options: Options) {
    this.options = options
    this.bpmCache = new BpmAnalysisCache(join(options.root, 'bpm-analysis-cache.json'))
    this.loudnessCache = new LoudnessAnalysisCache(
      join(options.root, 'loudness-analysis-cache.json')
    )
    this.bpm = new BpmAnalysisManager({ ...options.bpm, cache: this.bpmCache })
    this.loudness = new LoudnessAnalysisManager({ ...options.loudness, cache: this.loudnessCache })
  }

  activate(): void {
    if (this.stopped || this.active) return
    this.active = true
    this.options.engine.setLoudnessAnalysisManager(this.loudness)
  }

  observe(track: TrackData | null, info: Pick<PlaybackInfo, 'state'>): void {
    if (!this.active || this.stopped || this.suspended) return
    const key =
      track && info.state === 'playing' && this.options.enabled()
        ? `${track.id}\0${track.filePath}`
        : ''
    if (key === this.observed) return
    this.observed = key
    if (!key || !track || (track.bpmAnalysis?.bpm ?? 0) > 0) return
    if (!track.filePath || /^[a-z][a-z\d+.-]*:\/\//i.test(track.filePath)) return
    void this.run((current) => this.analyzeBpm(track, current)).catch(this.options.failed)
  }

  request(input: { kind: 'bpm' | 'loudness'; id: string; version: number }) {
    return this.run(
      async (current): Promise<BpmAnalysisRequestResult | LoudnessAnalysisRequestResult> => {
        const page = await this.options.database.getTracksByIds([input.id])
        const record = page.tracks.find((track) => track.id === input.id)
        if (!record || page.versions[input.id] !== input.version)
          throw new Error('曲目已变化，请刷新后重试')
        if (!current()) return { status: 'skipped', reason: 'cancelled' }
        const track = libraryTrack(record)
        if (input.kind === 'bpm') return this.analyzeBpm(track, current)
        const filePath = await this.options.authorize(track.filePath)
        if (!current()) return { status: 'skipped', reason: 'cancelled' }
        return this.loudness.requestAnalysis({ trackId: track.id, filePath })
      }
    )
  }

  private analyzeBpm(track: TrackData, current: () => boolean): Promise<BpmAnalysisRequestResult> {
    const key = `${track.id}\0${track.filePath}`
    const pending = this.bpmWork.get(key)
    if (pending) return pending
    const task = this.performBpm(track, current).finally(() => this.bpmWork.delete(key))
    this.bpmWork.set(key, task)
    return task
  }

  private async performBpm(
    track: TrackData,
    current: () => boolean
  ): Promise<BpmAnalysisRequestResult> {
    const filePath = await this.options.authorize(track.filePath)
    if (!current()) return { status: 'skipped', reason: 'cancelled' }
    const result = await this.bpm.requestAnalysis({
      trackId: track.id,
      filePath,
      referenceBpm: track.bpm,
      priority: 10
    })
    if (!current()) return { status: 'skipped', reason: 'cancelled' }
    if (result.status === 'cached' || result.status === 'completed') {
      // A queue may reference a file before it has been indexed. Update the
      // current session either way; persist only the exact existing library row.
      let page = await this.options.database.getTracksByIds([track.id])
      let record = page.tracks.find((item) => item.id === track.id)
      if (!record) {
        const lookup = await this.options.database.lookupTracksByPaths([track.filePath])
        if (lookup.ids[0]) {
          page = await this.options.database.getTracksByIds([lookup.ids[0]], lookup.revision)
          record = page.tracks[0]
        }
      }
      if (!current()) return { status: 'skipped', reason: 'cancelled' }
      if (
        record?.filePath === track.filePath &&
        JSON.stringify(record.bpmAnalysis) !== JSON.stringify(result.analysis)
      ) {
        await this.options.database.patchTracks([
          {
            id: record.id,
            expectedVersion: page.versions[record.id],
            patch: { bpmAnalysis: result.analysis }
          }
        ])
      }
      if (current()) {
        this.options.applyBpm(track, result.analysis)
        this.options.changed()
      }
    }
    return result
  }

  async cacheSize(kind: 'bpm' | 'loudness'): Promise<number> {
    return (kind === 'bpm' ? this.bpmCache : this.loudnessCache).getSize()
  }

  status(): { status: LoudnormStatus } {
    return { status: this.options.engine.getLoudnormStatus().status }
  }

  async clearCache(kind: 'bpm' | 'loudness'): Promise<number> {
    await this.maintain(async () => {
      if (kind === 'loudness') {
        await this.loudnessCache.clear()
        this.loudness.clearFailures()
      } else {
        await this.bpmCache.clear()
        for (let offset = 0; ; offset += 200) {
          const page = await this.options.database.queryTracks({
            sort: 'insertion',
            offset,
            limit: 200
          })
          const patches = page.tracks
            .filter((track) => track.bpmAnalysis != null)
            .map((track) => ({
              id: track.id,
              expectedVersion: page.versions[track.id],
              patch: { bpmAnalysis: null }
            }))
          if (patches.length) await this.options.database.patchTracks(patches)
          if (offset + page.tracks.length >= page.total) break
        }
        this.options.clearBpm()
      }
      this.options.changed()
    })
    if (kind === 'loudness' && !this.stopped && !this.suspended)
      await this.options.engine.notifyLoudnessCacheCleared()
    return 0
  }

  /** Stop both decoder work and result publication before changing source bytes. */
  maintain<T>(action: () => Promise<T>): Promise<T> {
    this.suspended++
    this.generation++
    this.options.engine.setLoudnessAnalysisManager(null)
    this.bpm.suspend()
    this.loudness.suspend()
    const result = this.maintenance
      .then(async () => {
        await Promise.allSettled([...this.work, this.bpm.join(), this.loudness.join()])
        return action()
      })
      .finally(() => {
        this.suspended--
        if (this.active && !this.stopped && !this.suspended) {
          this.bpm.resume()
          this.loudness.resume()
          this.options.engine.setLoudnessAnalysisManager(this.loudness)
        }
      })
    this.maintenance = result.catch(() => {})
    return result
  }

  private run<T>(action: (current: () => boolean) => Promise<T>): Promise<T> {
    if (!this.active || this.stopped || this.suspended)
      return Promise.reject(new Error('音频分析尚未就绪或正在维护'))
    const generation = this.generation
    const result = action(() => !this.stopped && this.generation === generation)
    this.work.add(result)
    void result.then(
      () => this.work.delete(result),
      () => this.work.delete(result)
    )
    return result
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    await this.maintain(async () => {})
  }
}
