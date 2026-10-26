import {
  importSongKey,
  type ImportedPlaylistData,
  type ImportResolution
} from '../../shared/externalPlaylist.ts'
import type { CoreImportProgress } from '../../shared/corePlaylists.ts'
import { createExternalEntryResolver, importFailure } from './importResolver.ts'

type Update = { entryId: string; revision: number; resolution: ImportResolution }
export interface CorePlaylistImportJobsOptions extends Omit<
  Parameters<typeof createExternalEntryResolver>[0],
  'schedule'
> {
  read(id: string): ImportedPlaylistData | undefined
  ids(): string[]
  apply(id: string, generation: string, updates: Update[]): Promise<void>
  changed(): void
  failed(error: unknown): void
  delay(ms: number, signal?: AbortSignal): Promise<void>
}

/** Matching is a Core lifetime job. Client detachment never cancels its work. */
export class CorePlaylistImportJobs {
  private readonly options: CorePlaylistImportJobsOptions
  private readonly resolver: ReturnType<typeof createExternalEntryResolver>
  private readonly jobs = new Map<
    string,
    { generation: string; controller: AbortController; work: Promise<void> }
  >()
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly progress = new Map<string, CoreImportProgress>()
  private readonly paused = new Set<string>()
  private active = false
  private rematchController: AbortController | undefined
  private rematchWork: Promise<void> | undefined
  constructor(options: CorePlaylistImportJobsOptions) {
    this.options = options
    this.resolver = createExternalEntryResolver({
      ...options,
      schedule: (source, action, signal) => this.schedule(source, action, signal)
    })
  }
  private async schedule<T>(
    source: string,
    action: () => Promise<T>,
    signal: AbortSignal
  ): Promise<T> {
    const work = (this.tails.get(source) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        signal.throwIfAborted()
        try {
          return await action()
        } finally {
          await this.options.delay(300, signal)
        }
      })
    this.tails.set(source, work)
    try {
      return await work
    } finally {
      if (this.tails.get(source) === work) this.tails.delete(source)
    }
  }
  status(id: string): CoreImportProgress | null {
    return structuredClone(this.progress.get(id) ?? null)
  }
  activate(): void {
    this.active = true
    this.reconcile()
  }
  rematch(): void {
    if (!this.active) return
    this.rematchController?.abort()
    const controller = new AbortController()
    this.rematchController = controller
    this.rematchWork = this.options
      .delay(800, controller.signal)
      .then(() => {
        if (this.active) for (const id of this.options.ids()) this.start(id, true)
      })
      .catch((error) => {
        if (!controller.signal.aborted) this.options.failed(error)
      })
  }
  reconcile(): void {
    if (!this.active) return
    const ids = new Set(this.options.ids())
    for (const [id, job] of this.jobs)
      if (!ids.has(id) || this.options.read(id)?.generation !== job.generation)
        job.controller.abort()
    for (const id of this.progress.keys()) if (!ids.has(id)) this.progress.delete(id)
    for (const id of ids)
      if (
        !this.paused.has(id) &&
        !this.jobs.has(id) &&
        this.options.read(id)?.entries.some((e) => e.resolution.state === 'pending')
      )
        this.start(id)
  }
  start(id: string, force = false, selected?: string[]): CoreImportProgress {
    if (!this.active) throw new Error('Playlist matching is not active')
    this.paused.delete(id)
    this.jobs.get(id)?.controller.abort()
    const data = this.options.read(id)
    if (!data) throw new Error('外部歌单已不存在')
    const controller = new AbortController(),
      previous = this.jobs.get(id)?.work
    const chosen = selected ? new Set(selected) : null
    const entries = structuredClone(
      data.entries.filter((e) =>
        chosen ? chosen.has(e.entryId) : force || e.resolution.state === 'pending'
      )
    )
    const status: CoreImportProgress = {
      id,
      generation: data.generation,
      done: 0,
      total: entries.length,
      running: true,
      error: null
    }
    this.progress.set(id, status)
    const job = { generation: data.generation, controller, work: Promise.resolve() }
    this.jobs.set(id, job)
    const current = () =>
      this.jobs.get(id) === job && this.options.read(id)?.generation === data.generation
    job.work = (async () => {
      await previous
      const signal = controller.signal,
        cache = new Map<string, Promise<ImportResolution>>()
      let updates: Update[] = [],
        failed = false
      const flush = async () => {
        if (!current() || !updates.length) return
        const batch = updates
        updates = []
        await this.options.apply(id, data.generation, batch)
      }
      try {
        for (const entry of entries) {
          signal.throwIfAborted()
          if (!current()) break
          const key = entry.manualBinding ? entry.entryId : importSongKey(entry.original)
          let task = cache.get(key)
          if (!task) {
            task = this.resolver.resolve(entry, signal).catch((error) => {
              signal.throwIfAborted()
              return importFailure(error)
            })
            cache.set(key, task)
          }
          const resolution = await task
          signal.throwIfAborted()
          updates.push({ entryId: entry.entryId, revision: entry.revision, resolution })
          status.done++
          if (updates.length >= 50 || status.done === entries.length) {
            await flush()
            this.options.changed()
            await this.options.delay(0, signal)
          }
        }
      } catch (error) {
        if (!signal.aborted) {
          failed = true
          throw error
        }
      } finally {
        if (this.jobs.get(id) === job) {
          try {
            if (current()) await flush()
          } finally {
            this.jobs.delete(id)
            status.running = false
            this.options.changed()
          }
          if (!failed) this.reconcile()
        }
      }
    })().catch((error) => {
      this.paused.add(id)
      if (this.jobs.get(id) === job) this.jobs.delete(id)
      status.running = false
      status.error = error instanceof Error ? error.message : String(error)
      this.options.failed(error)
      this.options.changed()
    })
    this.options.changed()
    return structuredClone(status)
  }
  async stop(id: string): Promise<void> {
    this.paused.add(id)
    const job = this.jobs.get(id)
    job?.controller.abort()
    await job?.work
    const data = this.options.read(id)
    if (data)
      await this.options.apply(
        id,
        data.generation,
        data.entries
          .filter((e) => e.resolution.state === 'pending')
          .map((e) => ({
            entryId: e.entryId,
            revision: e.revision,
            resolution: { state: 'cancelled', message: '补全已取消，可重新匹配' }
          }))
      )
    const progress = this.progress.get(id)
    if (progress) {
      progress.running = false
      this.options.changed()
    }
  }
  async shutdown(): Promise<void> {
    this.active = false
    this.rematchController?.abort()
    await this.rematchWork
    for (const job of this.jobs.values()) job.controller.abort()
    await Promise.all([...this.jobs.values()].map((job) => job.work))
    await Promise.allSettled(this.tails.values())
  }
}
