import type {
  CorePersonalizedContext,
  CorePersonalizedState,
  PersonalizedStreamKey
} from '../../shared/corePersonalized.ts'
import type { CoreQueueReference } from '../../shared/coreProtocol.ts'
import type { TrackData } from '../../shared/track.ts'
import { libraryTrack } from './libraryTrack.ts'
import { toPlaybackQueueSnapshot } from './queueSnapshots.ts'
import { projectCoreError } from '../projections.ts'
import { automaticPlaybackTracks, type AutomaticPlaybackAllowed } from './automaticPlayback.ts'

export interface PersonalizedProviders {
  supportedMethods(providerId: string): readonly string[]
  call(
    providerId: string,
    method: 'fetchPersonalFm' | 'fetchPrivateContent',
    signal: AbortSignal
  ): Promise<unknown>
}
interface Options extends PersonalizedProviders {
  automaticPlaybackAllowed?: AutomaticPlaybackAllowed
  queue(): CoreQueueReference | null
  append(queueId: string, tracks: TrackData[], current: () => boolean): Promise<number>
  now(): number
  changed(): void
}
const RETRY_MS = 15_000
const REFILL_THRESHOLD = 3

/** Provider IO is outside playback's commit lane. SQL deduplicates membership;
 * this owner retains only the session context and one in-flight recommendation batch. */
export class PersonalizedQueue {
  private context: CorePersonalizedContext | null = null
  private controller = new AbortController()
  private pending: Promise<number> | null = null
  private retryAfter = 0
  private failedWrite = false
  private error: string | null = null
  private closed = false
  private readonly options: Options
  constructor(options: Options) {
    this.options = options
  }
  attach(context: CorePersonalizedContext): void {
    this.stop()
    this.context = { ...context }
  }
  stop(): void {
    this.controller.abort(new Error('Personalized queue changed'))
    this.controller = new AbortController()
    this.context = null
    this.retryAfter = 0
    this.failedWrite = false
    this.error = null
  }
  persisted(): CorePersonalizedContext | undefined {
    return this.context ? { ...this.context } : undefined
  }
  recover(): void {
    this.failedWrite = false
    this.error = null
    this.retryAfter = 0
  }
  state(): CorePersonalizedState | null {
    const queue = this.options.queue()
    return this.context && queue?.id === this.context.queueId
      ? {
          ...this.context,
          loading: this.pending !== null,
          remaining: Math.max(0, queue.total - queue.index - 1),
          error: this.error
        }
      : null
  }
  observe(playing: boolean): void {
    if (this.closed) return
    if (this.context && this.options.queue()?.id !== this.context.queueId) this.stop()
    const state = this.state()
    if (playing && state && state.remaining < REFILL_THRESHOLD) void this.refill().catch(() => {}) // The state carries failures; never replay an unknown append.
  }
  async fetch(
    providerId: string,
    key: PersonalizedStreamKey,
    signal: AbortSignal,
    fmFallback = false,
    explicitId?: string
  ): Promise<TrackData[]> {
    const method = key === 'fm' || fmFallback ? 'fetchPersonalFm' : 'fetchPrivateContent'
    if (!this.options.supportedMethods(providerId).includes(method))
      throw new Error(`Provider does not support ${method}`)
    const response = await this.options.call(providerId, method, signal)
    signal.throwIfAborted()
    if (!Array.isArray(response))
      throw new Error('Provider returned an invalid recommendation batch')
    const seen = new Set<string>()
    const tracks = response.flatMap((value) => {
      if (
        !value ||
        typeof value !== 'object' ||
        typeof value.id !== 'string' ||
        !value.id ||
        seen.has(value.id)
      )
        return []
      seen.add(value.id)
      const track = toPlaybackQueueSnapshot(
        libraryTrack({ ...value, source: providerId, filePath: '' })
      )
      // Queue snapshots keep provider identity, never a cached URL/grant from a home-page response.
      track.streamUrl = null
      return [track]
    })
    return automaticPlaybackTracks(tracks, this.options.automaticPlaybackAllowed, signal, explicitId)
  }
  async initial(
    providerId: string,
    key: PersonalizedStreamKey,
    signal: AbortSignal,
    explicitId?: string
  ): Promise<TrackData[]> {
    const tracks = await this.fetch(providerId, key, signal, false, explicitId)
    return tracks.length ||
      key !== 'radar' ||
      !this.options.supportedMethods(providerId).includes('fetchPersonalFm')
      ? tracks
      : this.fetch(providerId, key, signal, true, explicitId)
  }
  refill(explicit = false): Promise<number> {
    if (this.pending) return this.pending
    if (explicit && this.failedWrite)
      throw new Error('Refresh stopped playback before requesting another personalized refill')
    if (
      this.closed ||
      !this.context ||
      this.failedWrite ||
      (!explicit && this.options.now() < this.retryAfter)
    )
      return Promise.resolve(0)
    const context = this.context,
      signal = this.controller.signal
    const current = () =>
      !signal.aborted && this.context === context && this.options.queue()?.id === context.queueId
    const work = Promise.resolve()
      .then(async () => {
        const append = async (tracks: TrackData[]) => {
          if (!current()) return 0
          try {
            return await this.options.append(context.queueId, tracks, current)
          } catch (error) {
            if (current()) this.failedWrite = true
            throw error
          }
        }
        let added = await append(await this.fetch(context.providerId, context.key, signal))
        if (
          current() &&
          added === 0 &&
          context.key === 'radar' &&
          this.options.supportedMethods(context.providerId).includes('fetchPersonalFm')
        )
          added = await append(await this.fetch(context.providerId, context.key, signal, true))
        if (current()) {
          this.error = null
          this.retryAfter = added ? 0 : this.options.now() + RETRY_MS
        }
        return added
      })
      .catch((error) => {
        if (current()) {
          this.error = projectCoreError(error)
          this.retryAfter = this.options.now() + RETRY_MS
        }
        throw error
      })
      .finally(() => {
        if (this.pending === work) this.pending = null
        this.options.changed()
      })
    this.pending = work
    this.options.changed()
    return work
  }
  async shutdown(): Promise<void> {
    this.closed = true
    this.controller.abort(new Error('Personalized queue is shutting down'))
    await this.pending?.catch(() => {})
  }
}
