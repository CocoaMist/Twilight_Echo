import type { RadioMediaService } from './radioMediaService.ts'
import { searchRadioBrowserStations, type RadioBrowserSearchOptions } from './radioBrowserClient.ts'
import { radioStationToTrack, podcastEpisodeToTrack } from './tracks.ts'
import {
  MAX_RADIO_STATIONS,
  cloneRadioStationsDocument,
  type RadioStationsDocument
} from '../../shared/radioStations.ts'
import {
  MAX_PODCAST_SUBSCRIPTIONS,
  clonePodcastSubscriptionsDocument,
  parsePodcastTrackId,
  type PodcastSubscription,
  type PodcastSubscriptionsDocument
} from '../../shared/podcastSubscriptions.ts'
import type { CoreStateApi } from '../../shared/coreState.ts'
import type { PlaybackInfo } from '../../shared/audioEngineTypes.ts'
import type { TrackData } from '../../shared/track.ts'
import type {
  CoreStreamsState,
  CoreRadioEdit,
  CorePodcastEdit,
  CoreStreamMutationResult,
  CoreStreamPageQuery,
  CoreStreamPage,
  CoreRadioStation,
  CorePodcast,
  CorePodcastEpisode,
  CoreStreamPlayback
} from '../../shared/coreStreams.ts'
import { projectCoreError } from '../projections.ts'

type Repository = Pick<
  RadioMediaService,
  | 'loadRadioStations'
  | 'saveRadioStations'
  | 'loadPodcastSubscriptions'
  | 'savePodcastSubscriptions'
  | 'createStationInput'
  | 'importPlaylistEntries'
  | 'buildSubscriptionFromFeed'
>
type Sample = {
  track: TrackData | null
  info: Pick<PlaybackInfo, 'state' | 'position' | 'naturalBoundaries'>
}
export interface CoreStreamsOptions {
  repository: Repository
  preferences: Pick<CoreStateApi, 'coreStateRead' | 'coreStateWrite'>
  now(): number
  newId(): string
  timers: {
    setInterval(callback: () => void, delay: number): unknown
    clearInterval(handle: unknown): void
  }
  searchDirectory?: typeof searchRadioBrowserStations
  changed(): void
  failed(error: unknown): void
}

/** One durable writer. Feed IO never holds the short repository mutation lane. */
export class CoreStreamsService {
  private radio: RadioStationsDocument = { schemaVersion: 1, stations: [] }
  private podcasts: PodcastSubscriptionsDocument = { schemaVersion: 1, subscriptions: [] }
  private radioRevision = 0
  private podcastRevision = 0
  private preferencesRevision = 0
  private defaultRate = 1
  private tail: Promise<unknown> = Promise.resolve()
  private readonly lifetime = new AbortController()
  private readonly network = new Set<Promise<unknown>>()
  private readonly refreshing = new Map<string, Promise<void>>()
  private readonly removed = new Map<string, PodcastSubscription>()
  private readonly feedLanes: Promise<unknown>[] = [
    Promise.resolve(),
    Promise.resolve(),
    Promise.resolve()
  ]
  private nextLane = 0
  private timer: unknown = null
  private active = false
  private stopped = false
  private error: string | null = null
  private progressError: unknown = null
  private previous: Sample | null = null
  private lastProgress = { trackId: '', seconds: -1, at: 0 }
  private readonly options: CoreStreamsOptions
  constructor(options: CoreStreamsOptions) {
    this.options = options
  }

  async initialize(): Promise<void> {
    const [radio, podcasts] = await Promise.all([
      this.options.repository.loadRadioStations(),
      this.options.repository.loadPodcastSubscriptions()
    ])
    this.radio = cloneRadioStationsDocument(radio.data)
    this.podcasts = clonePodcastSubscriptionsDocument(podcasts.data)
    this.radioRevision = radio.revision
    this.podcastRevision = podcasts.revision
  }
  async activate(): Promise<void> {
    const preferences = await this.options.preferences.coreStateRead('podcast-preferences')
    this.preferencesRevision = preferences.revision
    const rate = preferences.rows.find((row) => row.key === 'defaultPlaybackRate')?.value
    if (typeof rate === 'number') this.defaultRate = rate
    if (this.lifetime.signal.aborted) return
    this.active = true
    this.timer = this.options.timers.setInterval(
      () => {
        void this.refreshAll().catch((error) => this.failed(error))
      },
      6 * 60 * 60 * 1000
    )
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Streams are shutting down'))
    const work = this.tail.then(action)
    this.tail = work.catch(() => {})
    return work
  }
  private runNetwork<T>(
    signal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const combined = signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal
    const work = Promise.resolve().then(() => {
      combined.throwIfAborted()
      return action(combined)
    })
    this.network.add(work)
    void work.then(
      () => this.network.delete(work),
      () => this.network.delete(work)
    )
    return work
  }
  private fetchFeed<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const lane = this.nextLane++ % this.feedLanes.length
    const work = this.feedLanes[lane].then(() => {
      signal.throwIfAborted()
      return action()
    })
    this.feedLanes[lane] = work.catch(() => {})
    return work
  }
  private fence(revision: number, current: number): void {
    if (revision !== current) throw stale('Streams changed; read a fresh page')
  }
  private failed(error: unknown): void {
    if (this.lifetime.signal.aborted) return
    this.error = projectCoreError(error)
    this.options.failed(error)
    this.options.changed()
  }
  state(): CoreStreamsState {
    return {
      radioRevision: this.radioRevision,
      podcastRevision: this.podcastRevision,
      preferencesRevision: this.preferencesRevision,
      defaultPlaybackRate: this.defaultRate,
      stations: this.radio.stations.length,
      subscriptions: this.podcasts.subscriptions.length,
      refreshing: [...this.refreshing.keys()],
      error: this.error
    }
  }
  defaultPlaybackRate(): number {
    return this.defaultRate
  }
  stations(query: CoreStreamPageQuery): CoreStreamPage<CoreRadioStation> {
    this.fence(query.revision, this.radioRevision)
    return page(this.radio.stations, query, (station) => ({
      id: station.id,
      name: station.name,
      homepage: station.homepage,
      favicon: station.favicon,
      tags: station.tags ? [...station.tags] : undefined,
      allowInsecureHttp: station.allowInsecureHttp,
      createdAt: station.createdAt,
      updatedAt: station.updatedAt
    }))
  }
  subscriptions(query: CoreStreamPageQuery): CoreStreamPage<CorePodcast> {
    this.fence(query.revision, this.podcastRevision)
    return page(this.podcasts.subscriptions, query, (subscription) => ({
      id: subscription.id,
      title: subscription.title,
      description: subscription.description,
      author: subscription.author,
      coverUrl: subscription.coverUrl,
      homepage: subscription.homepage,
      lastRefreshedAt: subscription.lastRefreshedAt,
      lastError: subscription.lastError
        ? projectCoreError(subscription.lastError)
        : subscription.lastError,
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt,
      episodeCount: subscription.episodes.length
    }))
  }
  episodes(id: string, query: CoreStreamPageQuery): CoreStreamPage<CorePodcastEpisode> {
    this.fence(query.revision, this.podcastRevision)
    const subscription = this.podcasts.subscriptions.find((sub) => sub.id === id)
    if (!subscription) throw new Error('Podcast subscription was not found')
    return page(subscription.episodes, query, (episode) => ({
      guid: episode.guid,
      title: episode.title,
      description: episode.description,
      durationSeconds: episode.durationSeconds,
      publishedAt: episode.publishedAt,
      progressSeconds: episode.progressSeconds,
      coverUrl: episode.coverUrl
    }))
  }
  searchDirectory(
    options: Omit<RadioBrowserSearchOptions, 'fetchJson' | 'baseUrl' | 'signal'>,
    signal?: AbortSignal
  ) {
    return this.runNetwork(signal, (signal) =>
      (this.options.searchDirectory ?? searchRadioBrowserStations)({ ...options, signal })
    )
  }
  radioEdit(command: CoreRadioEdit, signal?: AbortSignal): Promise<CoreStreamMutationResult> {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      this.fence(command.revision, this.radioRevision)
      const next = cloneRadioStationsDocument(this.radio)
      const edit = command.edit
      let id: string | undefined,
        added = 0
      if (edit.kind === 'remove')
        next.stations = next.stations.filter((station) => station.id !== edit.id)
      else {
        const inputs =
          edit.kind === 'add'
            ? [this.options.repository.createStationInput(edit)]
            : this.options.repository.importPlaylistEntries(edit.text, edit)
        const urls = new Set(next.stations.map((station) => station.streamUrl))
        for (const station of inputs) {
          if (urls.has(station.streamUrl)) {
            if (edit.kind === 'add') throw new Error('该电台已收藏')
            continue
          }
          next.stations.unshift(station)
          urls.add(station.streamUrl)
          id = station.id
          added++
        }
        if (next.stations.length > MAX_RADIO_STATIONS) throw new Error('电台数量已达上限')
      }
      if (added || next.stations.length !== this.radio.stations.length) {
        const saved = await this.options.repository.saveRadioStations(next, this.radioRevision)
        this.radio = saved.data
        this.radioRevision = saved.revision
        this.error = null
        this.options.changed()
      }
      return { state: this.state(), id, added }
    })
  }
  subscribe(
    feedUrl: string,
    revision: number,
    signal?: AbortSignal
  ): Promise<CoreStreamMutationResult> {
    this.fence(revision, this.podcastRevision)
    const normalized = feedUrl.trim()
    if (!/^https?:\/\//i.test(normalized))
      return Promise.reject(new Error('Podcast feed URL is invalid'))
    return this.runNetwork(signal, async (signal) => {
      const subscription = await this.fetchFeed(signal, () =>
        this.options.repository.buildSubscriptionFromFeed(normalized, undefined, signal)
      )
      return this.enqueue(async () => {
        signal.throwIfAborted()
        if (this.podcasts.subscriptions.some((sub) => sub.feedUrl === normalized))
          throw new Error('Podcast feed is already subscribed')
        if (this.podcasts.subscriptions.length >= MAX_PODCAST_SUBSCRIPTIONS)
          throw new Error('Podcast subscription limit reached')
        const next = clonePodcastSubscriptionsDocument(this.podcasts)
        next.subscriptions.unshift(subscription)
        await this.savePodcasts(next)
        return { state: this.state(), id: subscription.id }
      })
    })
  }
  podcastEdit(command: CorePodcastEdit, signal?: AbortSignal): Promise<CoreStreamMutationResult> {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      this.fence(command.revision, this.podcastRevision)
      const next = clonePodcastSubscriptionsDocument(this.podcasts)
      const edit = command.edit
      let undoToken: string | undefined
      if (edit.kind === 'unsubscribe') {
        const removed = next.subscriptions.find((sub) => sub.id === edit.id)
        if (!removed) throw new Error('Podcast subscription was not found')
        next.subscriptions = next.subscriptions.filter((sub) => sub.id !== edit.id)
        await this.savePodcasts(next)
        undoToken = this.options.newId()
        this.removed.set(undoToken, removed)
        if (this.removed.size > 50) this.removed.delete(this.removed.keys().next().value!)
      } else {
        const removed = this.removed.get(edit.token)
        if (!removed) throw new Error('撤销已失效，请重新订阅')
        if (
          next.subscriptions.some((sub) => sub.id === removed.id || sub.feedUrl === removed.feedUrl)
        )
          throw new Error('该播客已重新订阅，已保留当前订阅和进度')
        if (next.subscriptions.length >= MAX_PODCAST_SUBSCRIPTIONS)
          throw new Error('Podcast subscription limit reached')
        next.subscriptions.push(removed)
        await this.savePodcasts(next)
        this.removed.delete(edit.token)
      }
      return { state: this.state(), undoToken }
    })
  }
  async setDefaultRate(
    rate: number,
    revision: number,
    signal?: AbortSignal
  ): Promise<CoreStreamsState> {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      this.fence(revision, this.preferencesRevision)
      rate = Math.round(rate * 100) / 100
      this.preferencesRevision = await this.options.preferences.coreStateWrite(
        'podcast-preferences',
        [{ key: 'defaultPlaybackRate', value: rate }],
        revision
      )
      this.defaultRate = rate
      this.options.changed()
      return this.state()
    })
  }
  private async savePodcasts(next: PodcastSubscriptionsDocument): Promise<void> {
    const saved = await this.options.repository.savePodcastSubscriptions(next, this.podcastRevision)
    this.podcasts = saved.data
    this.podcastRevision = saved.revision
    this.progressError = null
    this.error = null
    this.options.changed()
  }
  refresh(id: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const existing = this.refreshing.get(id)
    if (existing) return existing.then(() => signal?.throwIfAborted())
    const previous = this.podcasts.subscriptions.find((sub) => sub.id === id)
    if (!previous) return Promise.reject(new Error('Podcast subscription was not found'))
    return this.refreshBatch([previous], signal)
  }
  private refreshBatch(previous: PodcastSubscription[], signal?: AbortSignal): Promise<void> {
    const work = this.runNetwork(signal, async (signal) => {
      const results = await Promise.all(
        previous.map(async (subscription) => {
          try {
            const refreshed = await this.fetchFeed(signal, () =>
              this.options.repository.buildSubscriptionFromFeed(
                subscription.feedUrl,
                subscription,
                signal
              )
            )
            return { previous: subscription, refreshed, error: null }
          } catch (error) {
            return { previous: subscription, refreshed: null, error }
          }
        })
      )
      signal.throwIfAborted()
      await this.enqueue(async () => {
        signal.throwIfAborted()
        const next = clonePodcastSubscriptionsDocument(this.podcasts)
        let changed = false
        for (const { previous, refreshed, error } of results) {
          const index = next.subscriptions.findIndex(
            (sub) => sub.id === previous.id && sub.feedUrl === previous.feedUrl
          )
          if (index < 0) continue // Removed while the feed was in flight.
          const current = next.subscriptions[index]
          if (refreshed) {
            const progress = new Map(
              current.episodes.map((episode) => [episode.guid, episode.progressSeconds])
            )
            next.subscriptions[index] = {
              ...refreshed,
              episodes: refreshed.episodes.map((episode) => ({
                ...episode,
                progressSeconds: progress.get(episode.guid)
              }))
            }
          } else
            next.subscriptions[index] = {
              ...current,
              lastError: projectCoreError(error).slice(0, 500),
              updatedAt: new Date(this.options.now()).toISOString()
            }
          changed = true
        }
        // Persistence failures propagate; never turn an unknown Save into a second error Save.
        if (changed) await this.savePodcasts(next)
      })
      const failure = results.find((result) => result.error)
      if (failure) throw failure.error
    })
    for (const subscription of previous) this.refreshing.set(subscription.id, work)
    this.options.changed()
    const complete = () => {
      for (const subscription of previous) this.refreshing.delete(subscription.id)
      this.options.changed()
    }
    void work.then(complete, complete)
    return work
  }
  async refreshAll(signal?: AbortSignal): Promise<void> {
    const previous = this.podcasts.subscriptions.filter((sub) => !this.refreshing.has(sub.id))
    const pending = [...new Set(this.refreshing.values())]
    if (previous.length) pending.push(this.refreshBatch(previous, signal))
    const results = await Promise.allSettled(pending)
    signal?.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    const failure = results.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
  assertPodcastRevision(revision: number): void {
    this.fence(revision, this.podcastRevision)
  }
  startRefresh(id?: string): CoreStreamsState {
    void (id ? this.refresh(id) : this.refreshAll()).catch((error) => this.failed(error))
    return this.state()
  }
  playback(request: CoreStreamPlayback): { track: TrackData; position: number } {
    if (request.kind === 'radio') {
      this.fence(request.revision, this.radioRevision)
      const station = this.radio.stations.find((item) => item.id === request.id)
      if (!station) throw new Error('Radio station was not found')
      return { track: radioStationToTrack(station), position: 0 }
    }
    this.fence(request.revision, this.podcastRevision)
    const sub = this.podcasts.subscriptions.find((item) => item.id === request.id)
    const episode = sub?.episodes.find((item) => item.guid === request.guid)
    if (!sub || !episode) throw new Error('Podcast episode was not found')
    return {
      track: podcastEpisodeToTrack(sub, episode),
      position: request.resume === false ? 0 : (episode.progressSeconds ?? 0)
    }
  }
  savedStreams(): ReadonlyMap<string, TrackData> {
    const tracks = new Map<string, TrackData>()
    for (const station of this.radio.stations)
      tracks.set(`radio:${station.id}`, radioStationToTrack(station))
    for (const sub of this.podcasts.subscriptions)
      for (const episode of sub.episodes) {
        const track = podcastEpisodeToTrack(sub, episode)
        tracks.set(`podcast:${track.id}`, track)
      }
    return tracks
  }
  observe(track: TrackData | null, info: Sample['info']): void {
    if (this.stopped) return
    const previous = this.previous
    const changed =
      previous &&
      (previous.track?.id !== track?.id || previous.track?.queueEntryId !== track?.queueEntryId)
    const natural =
      previous?.info.naturalBoundaries &&
      info.naturalBoundaries &&
      info.naturalBoundaries.trackSerial > previous.info.naturalBoundaries.trackSerial
    if (this.active) {
      if (changed && previous) this.recordProgress(previous, true)
      // Paused/Stop observations retain the last position, not native Stop's zero.
      if (previous?.info.state === 'playing' && info.state !== 'playing' && !changed)
        this.recordProgress(
          {
            track,
            info: {
              ...info,
              position: info.state === 'stopped' ? previous.info.position : info.position
            }
          },
          true
        )
      else if (info.state === 'playing') this.recordProgress({ track, info }, false)
      if (natural && previous?.track?.source === 'podcast' && previous.track.duration > 0)
        this.recordProgress(
          { ...previous, info: { ...previous.info, position: previous.track.duration } },
          true
        )
    }
    this.previous = {
      track,
      info: {
        state: info.state,
        position:
          info.state === 'stopped' && !changed && previous ? previous.info.position : info.position,
        naturalBoundaries: info.naturalBoundaries ? { ...info.naturalBoundaries } : undefined
      }
    }
  }
  private recordProgress(sample: Sample, force: boolean): void {
    const track = sample.track
    if (track?.source !== 'podcast') return
    const identity = parsePodcastTrackId(track.id)
    if (!identity) return
    const seconds = Math.max(0, Math.floor(sample.info.position)),
      now = this.options.now()
    if (!force && seconds < 1) return
    const last = this.lastProgress,
      same = last.trackId === track.id
    if (
      !force &&
      same &&
      ((Math.abs(seconds - last.seconds) < 2 && now - last.at < 8000) || now - last.at < 4000)
    )
      return
    this.lastProgress = { trackId: track.id, seconds, at: now }
    void this.enqueue(async () => {
      const next = clonePodcastSubscriptionsDocument(this.podcasts)
      const sub = next.subscriptions.find((item) => item.id === identity.subscriptionId)
      const episode = sub?.episodes.find((item) => item.guid === identity.episodeGuid)
      if (!sub || !episode || episode.progressSeconds === seconds) return
      episode.progressSeconds = seconds
      sub.updatedAt = new Date(now).toISOString()
      await this.savePodcasts(next)
    }).catch((error) => {
      this.progressError = error
      this.failed(error)
    })
  }
  async stopRefresh(): Promise<void> {
    this.active = false
    if (this.timer !== null) this.options.timers.clearInterval(this.timer)
    this.timer = null
    this.lifetime.abort(new Error('Streams are shutting down'))
    await Promise.allSettled([...this.network])
  }
  async flush(): Promise<void> {
    await this.tail
    if (this.progressError) throw this.progressError
  }
  async shutdown(): Promise<void> {
    if (this.stopped) return
    await this.stopRefresh()
    if (this.previous) this.recordProgress(this.previous, true)
    await this.flush()
    this.stopped = true
    this.removed.clear()
  }
}
function stale(message: string): Error {
  return Object.assign(new Error(message), { code: 'STALE_REVISION' })
}
function page<T, R>(
  items: T[],
  query: CoreStreamPageQuery,
  project: (item: T) => R
): CoreStreamPage<R> {
  const offset = query.offset ?? 0
  return {
    revision: query.revision,
    offset,
    total: items.length,
    items: items.slice(offset, offset + (query.limit ?? 50)).map(project)
  }
}
