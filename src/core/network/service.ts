import { createNetworkSourcesManager, type NetworkSourcesManager } from './sourcesManager.ts'
import type { NetworkProfileStore } from './profileStore.ts'
import type { NetworkLibraryIndex } from './networkLibrary.ts'
import type { NetworkSourceAdapter } from './adapters/types.ts'
import type {
  NetworkEntry,
  NetworkSourceProfile,
  NetworkSourceProfileSummary
} from '../../shared/networkSources.ts'
import type {
  CoreNetworkState,
  CoreNetworkPage,
  CoreNetworkPageQuery,
  CoreNetworkEntry,
  CoreNetworkProfileEdit,
  CoreNetworkJobCommand,
  CoreNetworkPlayback
} from '../../shared/coreNetwork.ts'
import { projectCoreError } from '../projections.ts'
import { networkEntryToTrack } from './tracks.ts'
import type { TrackData } from '../../shared/track.ts'
import type { ResolvedSource } from '../playback/sourceResolver.ts'
import { readCoverDataUrl } from './networkCover.ts'
import { clearUnpinnedCache, getDirectorySize } from './networkCache.ts'
import { buildNetworkEntryId, normalizeRemotePath } from './networkPath.ts'

interface Options {
  store: NetworkProfileStore
  library: NetworkLibraryIndex
  getAdapter(protocol: NetworkSourceProfile['protocol']): Promise<NetworkSourceAdapter | null>
  cacheRoot: string
  coverCacheRoot: string
  newId(): string
  now(): number
  changed(): void
}
type Directory = { profileId: string; path: string; entries: NetworkEntry[] }
type Job = CoreNetworkState['jobs'][number]

/** One source owner; long IO never runs in the short profile/index commit lane. */
export class CoreNetworkService {
  private readonly options: Options
  private readonly manager: NetworkSourcesManager
  private revision = 0
  private profiles: NetworkSourceProfileSummary[] = []
  private tail: Promise<unknown> = Promise.resolve()
  private readonly lifetime = new AbortController()
  private readonly generations = new Map<string, AbortController>()
  private readonly work = new Set<Promise<unknown>>()
  private readonly directories = new Map<string, Directory>()
  private readonly jobs = new Map<string, Job>()
  private readonly jobControllers = new Map<string, AbortController>()
  private cacheReads = new AbortController()
  private cacheBarrier: Promise<void> | null = null
  private clearingCache: Promise<unknown> | null = null
  private readonly cacheWork = new Set<Promise<unknown>>()
  private readonly lanes: Promise<unknown>[] = [
    Promise.resolve(),
    Promise.resolve(),
    Promise.resolve()
  ]
  private nextLane = 0
  constructor(options: Options) {
    this.options = options
    this.manager = createNetworkSourcesManager({
      ...options,
      commit: (id, action, signal) =>
        this.write(
          undefined,
          async () => {
            if (!this.profiles.some((profile) => profile.id === id))
              throw new Error('Network profile no longer exists')
            return action()
          },
          signal
        )
    })
  }
  async initialize(): Promise<void> {
    this.profiles = await this.manager.listProfiles()
    // Validate the original index before publishing ready, without a new format.
    await this.manager.searchLibrary()
  }
  state(): CoreNetworkState {
    return structuredClone({
      revision: this.revision,
      profiles: this.profiles.length,
      jobs: [...this.jobs.values()]
    })
  }
  /** Private search identities; remote paths never cross the public search projection. */
  async searchTracks(query: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const entries = await this.manager.searchLibrary(query)
    signal.throwIfAborted()
    return entries
  }
  assertRevision(revision: number): void {
    if (revision !== this.revision)
      throw Object.assign(new Error('Network sources changed; refresh the view'), {
        code: 'STALE_REVISION'
      })
  }
  private write<T>(
    revision: number | undefined,
    action: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const result = this.tail.then(async () => {
      this.lifetime.signal.throwIfAborted()
      signal?.throwIfAborted()
      if (revision !== undefined) this.assertRevision(revision)
      try {
        return await action()
      } finally {
        // An IO failure may have committed one of the original repositories.
        // Invalidate the old view; never automatically repeat the mutation.
        this.revision++
        this.options.changed()
      }
    })
    this.tail = result.catch(() => {})
    return result
  }
  private generation(id: string): AbortController {
    let controller = this.generations.get(id)
    if (!controller) {
      controller = new AbortController()
      this.generations.set(id, controller)
    }
    return controller
  }
  private invalidate(id: string): void {
    this.generation(id).abort(new Error('Network profile changed'))
    this.generations.delete(id)
    for (const [token, directory] of this.directories)
      if (directory.profileId === id) this.directories.delete(token)
  }
  private run<T>(
    id: string,
    signal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const combined = AbortSignal.any([
      this.lifetime.signal,
      this.generation(id).signal,
      ...(signal ? [signal] : [])
    ])
    const result = Promise.resolve().then(async () => {
      combined.throwIfAborted()
      const value = await action(combined)
      combined.throwIfAborted()
      return value
    })
    this.work.add(result)
    void result.then(
      () => this.work.delete(result),
      () => this.work.delete(result)
    )
    return result
  }
  private async useCache<T>(
    signal: AbortSignal,
    action: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (this.cacheBarrier) await this.cacheBarrier
    const current = AbortSignal.any([signal, this.cacheReads.signal])
    current.throwIfAborted()
    const work = Promise.resolve().then(() => {
      current.throwIfAborted()
      return action(current)
    })
    this.cacheWork.add(work)
    try {
      return await work
    } finally {
      this.cacheWork.delete(work)
    }
  }
  private page<T>(query: CoreNetworkPageQuery, items: T[]): CoreNetworkPage<T> {
    this.assertRevision(query.revision)
    const offset = query.offset ?? 0
    return {
      revision: this.revision,
      offset,
      total: items.length,
      items: items.slice(offset, offset + (query.limit ?? 100))
    }
  }
  listProfiles(query: CoreNetworkPageQuery): CoreNetworkPage<NetworkSourceProfileSummary> {
    return structuredClone(this.page(query, this.profiles))
  }
  profileIds(): ReadonlySet<string> {
    return new Set(this.profiles.map((profile) => profile.id))
  }
  edit(
    command: CoreNetworkProfileEdit,
    signal?: AbortSignal
  ): Promise<{ state: CoreNetworkState; profile?: NetworkSourceProfileSummary }> {
    return this.write(
      command.revision,
      async () => {
        if (command.kind !== 'create') {
          this.invalidate(command.id)
        }
        try {
          return command.kind === 'create'
            ? await this.manager.createProfile(command.input)
            : command.kind === 'update'
              ? await this.manager.updateProfile(command.id, command.patch)
              : await this.manager.deleteProfile(command.id)
        } finally {
          this.profiles = await this.manager.listProfiles()
        }
      },
      signal
    ).then((profile) => ({ state: this.state(), ...(profile ? { profile } : {}) }))
  }
  async directory(
    query: CoreNetworkPageQuery & { profileId: string; path: string; token?: string },
    signal?: AbortSignal
  ): Promise<CoreNetworkPage<CoreNetworkEntry> & { token: string }> {
    this.assertRevision(query.revision)
    let token = query.token
    let directory = token ? this.directories.get(token) : undefined
    if (
      token &&
      (!directory || directory.profileId !== query.profileId || directory.path !== query.path)
    )
      throw new Error('Directory page expired; read the directory again')
    if (!directory) {
      const entries = await this.run(query.profileId, signal, (current) =>
        this.manager.listDirectory(query.profileId, query.path, current)
      )
      this.assertRevision(query.revision)
      token = this.options.newId()
      directory = { profileId: query.profileId, path: query.path, entries }
      this.directories.set(token, directory)
      while (this.directories.size > 8)
        this.directories.delete(this.directories.keys().next().value!)
    }
    return { ...this.page(query, directory.entries.map(projectEntry)), token: token! }
  }
  async library(
    query: CoreNetworkPageQuery & { profileId?: string; query?: string }
  ): Promise<CoreNetworkPage<CoreNetworkEntry & { profileName: string }>> {
    this.assertRevision(query.revision)
    const found = await this.manager.searchLibrary(query.query)
    return this.page(
      query,
      found
        .filter((item) => !query.profileId || item.profileId === query.profileId)
        .map((item) => ({ ...projectEntry(item.entry), profileName: item.profileName }))
    )
  }
  test(id: string, signal?: AbortSignal) {
    return this.run(id, signal, (current) => this.manager.testConnection(id, current))
  }
  removeEntry(
    command: { revision: number; profileId: string; entryId: string },
    signal?: AbortSignal
  ): Promise<CoreNetworkState> {
    return this.write(
      command.revision,
      () => {
        this.invalidate(command.profileId)
        return this.manager.removeLibraryEntry(command.profileId, command.entryId)
      },
      signal
    ).then(() => this.state())
  }
  job(command: CoreNetworkJobCommand): CoreNetworkState {
    this.lifetime.signal.throwIfAborted()
    this.assertRevision(command.revision)
    if (command.kind === 'cancel') {
      this.jobControllers.get(command.id)?.abort(new Error('Network job cancelled'))
      return this.state()
    }
    if (!this.profiles.some((profile) => profile.id === command.profileId))
      throw new Error('Network profile not found')
    if (
      [...this.jobs.values()].some(
        (job) => job.profileId === command.profileId && job.state === 'running'
      )
    )
      throw new Error('A network source job is already running for this profile')
    const job: Job = {
      id: this.options.newId(),
      profileId: command.profileId,
      kind: command.kind,
      state: 'running'
    }
    this.jobs.set(job.id, job)
    this.trimJobs()
    const controller = new AbortController()
    this.jobControllers.set(job.id, controller)
    const lane = this.nextLane++ % this.lanes.length
    const previous = this.lanes[lane]
    const generation = this.generation(command.profileId).signal
    const work = this.run(command.profileId, controller.signal, async (signal) => {
      await previous
      signal.throwIfAborted()
      return command.kind === 'scan'
        ? this.manager.scanDirectory(command.profileId, command.path, signal)
        : this.useCache(signal, (current) => this.manager.enrichLibrary(command.profileId, current))
    })
    this.lanes[lane] = work.catch(() => {})
    void work
      .then(
        (result) => {
          job.state = 'completed'
          job.result = result
        },
        (error) => {
          job.state =
            controller.signal.aborted || this.lifetime.signal.aborted || generation.aborted
              ? 'cancelled'
              : 'failed'
          if (job.state === 'failed') job.error = projectCoreError(error)
        }
      )
      .finally(() => {
        this.jobControllers.delete(job.id)
        this.trimJobs()
        this.options.changed()
      })
    this.options.changed()
    return this.state()
  }
  private trimJobs(): void {
    const terminal = [...this.jobs.values()].filter((job) => job.state !== 'running')
    while (terminal.length > 50) this.jobs.delete(terminal.shift()!.id)
  }
  private async entry(
    profileId: string,
    entryId: string
  ): Promise<{ entry: NetworkEntry; name: string }> {
    const profile = this.profiles.find((profile) => profile.id === profileId)
    if (!profile) throw new Error('Network profile not found')
    let entry = (await this.manager.listLibrary(profileId)).find((entry) => entry.id === entryId)
    if (!entry)
      for (const directory of this.directories.values())
        if (directory.profileId === profileId) {
          entry = directory.entries.find((entry) => entry.id === entryId)
          if (entry) break
        }
    if (!entry || entry.kind !== 'audio') throw new Error('Network entry is unavailable')
    return { entry, name: profile.name }
  }
  async playback(command: CoreNetworkPlayback, signal?: AbortSignal): Promise<TrackData> {
    this.assertRevision(command.revision)
    return this.run(command.profileId, signal, async () => {
      const { entry, name } = await this.entry(command.profileId, command.entryId)
      this.assertRevision(command.revision)
      return networkEntryToTrack(entry, name)
    })
  }
  /** A persisted queue supplies identity, not a stale URL or a caller-owned entry. */
  async resolve(track: TrackData, signal?: AbortSignal): Promise<ResolvedSource | null> {
    const identity = track.networkSource
    if (!identity) return null
    return this.run(identity.profileId, signal, (current) =>
      this.useCache(current, async (current) => {
        const profile = this.profiles.find((profile) => profile.id === identity.profileId)
        if (!profile) return null
        const indexed = (await this.manager.listLibrary(profile.id)).find(
          (entry) => entry.id === identity.entry.id
        )
        const entry = indexed ?? identity.entry
        // Browse-only queue items survive restart through their original stable identity.
        // Neither a saved direct URL nor an arbitrary cached path is reused.
        if (
          entry.profileId !== profile.id ||
          entry.kind !== 'audio' ||
          buildNetworkEntryId(profile.protocol, profile.id, normalizeRemotePath(entry.path)) !==
            entry.id
        )
          return null
        const plan = await this.manager.resolvePlayback(identity.profileId, entry, current)
        const source = plan.kind === 'direct-url' ? plan.url : plan.cacheFilePath
        return source
          ? {
              source,
              expiresAt: plan.kind === 'direct-url' ? this.options.now() + 8 * 60_000 : null
            }
          : null
      })
    )
  }
  async cover(profileId: string, entryId: string): Promise<string | null> {
    await this.entry(profileId, entryId)
    return readCoverDataUrl(entryId, this.options.coverCacheRoot)
  }
  async cacheInfo(): Promise<{ sizeBytes: number }> {
    return { sizeBytes: await getDirectorySize(this.options.cacheRoot) }
  }
  clearCache(
    maintainSources: <T>(action: (sources: readonly string[]) => Promise<T>) => Promise<T>,
    signal?: AbortSignal
  ): Promise<{ sizeBytes: number }> {
    return this.cacheMaintenance(
      (drain) =>
        maintainSources(async (sources) => {
          await drain()
          signal?.throwIfAborted()
          await clearUnpinnedCache(this.options.cacheRoot, sources, signal)
          return this.cacheInfo()
        }),
      signal
    )
  }
  /** Aggregate cache ownership reuses the same real reader/writer drain without
   * recursively acquiring playback's source-maintenance lease. */
  maintainCache<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.cacheMaintenance(async (drain) => {
      await drain()
      return action()
    }, signal)
  }
  private cacheMaintenance<T>(
    action: (drain: () => Promise<void>) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.clearingCache) throw new Error('Network cache is already being cleared')
    const current = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])])
    current.throwIfAborted()
    let release!: () => void
    this.cacheBarrier = new Promise<void>((resolve) => {
      release = resolve
    })
    this.cacheReads.abort(new Error('Network cache is being cleared'))
    for (const job of this.jobs.values())
      if (job.kind === 'enrich' && job.state === 'running')
        this.jobControllers.get(job.id)?.abort(new Error('Network cache is being cleared'))
    const work = action(async () => {
      await Promise.allSettled([...this.cacheWork])
      current.throwIfAborted()
    }).finally(() => {
      this.cacheReads = new AbortController()
      this.cacheBarrier = null
      this.clearingCache = null
      release()
    })
    this.clearingCache = work
    return work
  }
  async flush(): Promise<void> {
    await this.tail
    await this.clearingCache
  }
  async shutdown(): Promise<void> {
    this.lifetime.abort(new Error('Network sources are shutting down'))
    await Promise.allSettled([...this.work])
    await this.clearingCache?.catch(() => {})
    await this.tail
  }
}

function projectEntry(entry: NetworkEntry): CoreNetworkEntry {
  const metadata: NetworkEntry['metadata'] = {}
  for (const key of ['title', 'artist', 'album', 'format'] as const)
    if (typeof entry.metadata?.[key] === 'string') metadata[key] = entry.metadata[key]
  for (const key of ['duration', 'sampleRate', 'bitrate', 'bitDepth'] as const)
    if (typeof entry.metadata?.[key] === 'number') metadata[key] = entry.metadata[key]
  return {
    id: entry.id,
    profileId: entry.profileId,
    name: entry.name,
    kind: entry.kind,
    path: entry.path,
    ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {}),
    ...(entry.mtimeMs !== undefined ? { mtimeMs: entry.mtimeMs } : {}),
    ...(entry.metadata ? { metadata } : {})
  }
}
