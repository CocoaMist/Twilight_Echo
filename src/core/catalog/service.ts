import type {
  CatalogDatabaseApi,
  CatalogQuery,
  CatalogSourceQuery,
  CatalogStatus,
  CatalogServiceStatus,
  CatalogSyncResult
} from '../../shared/musicCatalog.ts'
import { CATALOG_MAX_BATCH_BYTES } from '../../shared/musicCatalog.ts'
import type { CoreRecordingVersions } from '../playlists/recordingVersions.ts'
import type { CorePlaylistService } from '../playlists/service.ts'
import type { TrackData } from '../../shared/track.ts'
import { getTrackSource } from '../../shared/trackSourceIdentity.ts'
import { projectCoreError, projectCoreTrack } from '../projections.ts'

interface Options {
  database: CatalogDatabaseApi
  versions: Pick<CoreRecordingVersions, 'getRevision' | 'snapshot'>
  playlists: Pick<CorePlaylistService, 'getRevision' | 'sourceTracks'>
  changed(): void
  failed(error: unknown): void
  /** Yield the Core event loop between bounded database transactions. */
  yield?(): Promise<void>
}

/** A single derived-index owner. Existing versions, playlists and Track rows
 * remain authoritative; cancellation joins the current batch, never rolls them back. */
export class CoreCatalogService {
  private readonly options: Options
  private active = false
  private stopped = false
  private paused = false
  private pending = false
  private generation = 0
  private work: Promise<void> | null = null
  private latest: CatalogStatus | null = null
  private error: string | null = null

  constructor(options: Options) {
    this.options = options
  }
  getRevision(): number | null {
    return this.latest?.revision ?? null
  }
  activate(): void {
    if (this.active || this.stopped) return
    this.active = true
    this.invalidate()
  }
  /** Changes do not silently resume a user-cancelled backfill. */
  invalidate(): void {
    this.pending = true
    this.kick()
  }
  refresh(): void {
    if (this.stopped) return
    this.paused = false
    this.error = null
    this.invalidate()
  }
  async cancel(): Promise<void> {
    this.paused = true
    this.generation++
    await this.work
    this.options.changed()
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    this.generation++
    await this.work
  }
  async status(): Promise<CatalogServiceStatus> {
    const status = await this.options.database.catalogStatus()
    return {
      ...status,
      state: this.error ? 'failed' : this.paused ? 'paused' : this.work ? 'running' : 'idle',
      error: this.error
    }
  }
  query(query: CatalogQuery) {
    return this.options.database.catalogQuery(query)
  }
  detail(id: string, revision?: number) {
    return this.options.database.catalogDetail(id, revision)
  }
  sources(query: CatalogSourceQuery) {
    return this.options.database.catalogSources(query)
  }
  resolve(sourceId: string, revision: number) {
    return this.options.database.catalogResolve(sourceId, revision)
  }

  private live(generation: number): boolean {
    return !this.stopped && !this.paused && generation === this.generation
  }
  private publish(status: CatalogStatus): void {
    this.latest = status
    this.options.changed()
  }
  private kick(): void {
    if (!this.active || this.stopped || this.paused || this.work || !this.pending) return
    const generation = this.generation
    this.work = this.run(generation)
      .catch((error) => {
        if (!this.live(generation)) return
        this.error = projectCoreError(error)
        this.paused = true
        this.pending = true
        this.options.failed(error)
      })
      .finally(() => {
        this.work = null
        this.options.changed()
        this.kick()
      })
    this.options.changed()
  }
  private yield(): Promise<void> {
    return this.options.yield?.() ?? new Promise((resolve) => setTimeout(resolve, 0))
  }
  private async run(generation: number): Promise<void> {
    while (this.live(generation) && this.pending) {
      this.pending = false
      let status = await this.options.database.catalogStatus()
      if (!this.live(generation)) break
      const version = this.options.versions.getRevision()
      if (status.versionsRevision !== version) {
        await this.options.database.catalogProjectVersions(
          this.options.versions.snapshot(),
          version
        )
        if (!this.live(generation)) break
        if (this.options.versions.getRevision() !== version) this.pending = true
      }
      if (status.playlistsRevision !== this.options.playlists.getRevision())
        await this.syncPlaylists(generation)
      if (!this.live(generation)) break
      status = await this.options.database.catalogStatus()
      this.publish(status)
      while (status.localPending && this.live(generation)) {
        status = await this.options.database.catalogAdvance(200)
        this.publish(status)
        await this.yield()
      }
    }
  }
  private async syncPlaylists(generation: number): Promise<void> {
    const revision = this.options.playlists.getRevision()
    let job: CatalogSyncResult | null = null
    const current = () => this.live(generation) && revision === this.options.playlists.getRevision()
    try {
      job = await this.options.database.catalogSync({ kind: 'begin', revision })
      let batch: TrackData[] = []
      let bytes = 2
      let visited = 0
      for (const track of this.options.playlists.sourceTracks()) {
        if (++visited % 200 === 0) await this.yield()
        if (!current()) break
        if (['local', 'network', 'radio', 'podcast'].includes(getTrackSource(track))) continue
        // Bound the private transport too: no lyrics, artwork, streamUrl or
        // provider extensions. Paths/dir are private hints solely for legacy
        // album-version keys; the database never publishes or caches them.
        const source: TrackData = {
          ...projectCoreTrack(track),
          filePath: track.filePath,
          dir: track.dir,
          fileName: '',
          cover: null,
          lyrics: null
        }
        const size = Buffer.byteLength(JSON.stringify(source), 'utf8') + 1
        if (size + 2 > CATALOG_MAX_BATCH_BYTES) throw new Error('单条音乐资料超过目录批次上限')
        if (batch.length && (batch.length === 200 || bytes + size > CATALOG_MAX_BATCH_BYTES)) {
          job = await this.options.database.catalogSync({ kind: 'append', ...job, tracks: batch })
          batch = []
          bytes = 2
          await this.yield()
          if (!current()) break
        }
        batch.push(source)
        bytes += size
      }
      if (current() && batch.length)
        job = await this.options.database.catalogSync({ kind: 'append', ...job, tracks: batch })
      if (!current()) {
        this.pending = true
        return
      }
      await this.options.database.catalogSync({ kind: 'commit', ...job })
      job = null
      if (revision !== this.options.playlists.getRevision()) this.pending = true
    } finally {
      if (job) await this.options.database.catalogSync({ kind: 'abort', id: job.id })
    }
  }
}
