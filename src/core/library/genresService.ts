import type {
  GenreDatabaseApi,
  GenreEdit,
  GenreEvidenceQuery,
  GenreMap,
  GenreOverride,
  GenreQuery,
  GenreUnmappedQuery
} from '../../shared/musicGenres.ts'
import type { GenreBrowseDatabaseApi, GenreBrowseQuery, GenreMembersQuery, GenreFacetsQuery } from '../../shared/musicGenreBrowse.ts'

interface Options {
  database: GenreDatabaseApi & Partial<GenreBrowseDatabaseApi>
  platformContexts?(): Record<string, string>
  separators(): string
  changed(): void
  failed(error: unknown): void
  yield?(): Promise<void>
}

/** Core schedules bounded work; SQLite remains the sole classification owner. */
export class CoreGenresService {
  private readonly options: Options
  private active = false
  private stopped = false
  private dirty = false
  private work: Promise<void> | null = null
  private revision: number | null = null
  private metadataRevision: number | null = null
  constructor(options: Options) {
    this.options = options
  }
  getRevision() {
    return this.revision
  }
  getMetadataRevision() { return this.metadataRevision }
  observeMetadata(revision: number) {
    if (revision === this.metadataRevision) return
    this.metadataRevision = revision
    this.options.changed()
  }
  observe(revision: number) {
    if (revision === this.revision) return
    this.revision = revision
    this.options.changed()
  }
  activate() {
    if (this.active || this.stopped) return
    this.active = true
    this.invalidate()
  }
  invalidate() {
    if (this.stopped) return
    this.dirty = true
    this.kick()
  }
  private kick() {
    if (!this.active || this.stopped || this.work || !this.dirty) return
    let failed = false
    this.work = this.run()
      .catch((error) => {
        failed = true
        this.dirty = true
        this.options.failed(error)
      })
      .finally(() => {
        this.work = null
        // Retry a failed batch only on a new invalidation, never a hot error loop.
        if (!failed) this.kick()
      })
  }
  private async run() {
    while (!this.stopped && this.dirty) {
      this.dirty = false
      const result = await this.options.database.genresAdvance(200, this.options.separators())
      this.observe(result.revision)
      this.dirty ||= result.pending
      if (this.dirty && !this.stopped)
        await (this.options.yield?.() ?? new Promise<void>((done) => setImmediate(done)))
    }
  }
  tree(query: GenreQuery) {
    return this.options.database.genresTree(query)
  }
  browse(query: GenreBrowseQuery) {
    if (!this.options.database.genresBrowse) throw new Error('Music classification browse is unavailable')
    return this.options.database.genresBrowse(query, { platformContexts: this.options.platformContexts?.() }).then(page => {
      this.observeMetadata(page.token.metadataRevision)
      return page
    })
  }
  members(query: GenreMembersQuery) {
    if (!this.options.database.genresMembers) throw new Error('Music classification browse is unavailable')
    return this.options.database.genresMembers(query, { platformContexts: this.options.platformContexts?.() }).then(page => {
      this.observeMetadata(page.token.metadataRevision)
      return page
    })
  }
  facets(query: GenreFacetsQuery) {
    if (!this.options.database.genresFacets) throw new Error('Music classification facets are unavailable')
    return this.options.database.genresFacets(query, { platformContexts: this.options.platformContexts?.() }).then(page => {
      this.observeMetadata(page.token.metadataRevision)
      return page
    })
  }
  unmapped(query: GenreUnmappedQuery) {
    return this.options.database.genresUnmapped(query)
  }
  evidence(query: GenreEvidenceQuery) {
    return this.options.database.genresEvidence(query)
  }
  async edit(input: GenreEdit) {
    const result = await this.options.database.genresEdit(input)
    this.observe(result.revision)
    return result
  }
  async map(input: GenreMap) {
    const result = await this.options.database.genresMap(input)
    this.observe(result.revision)
    return result
  }
  async override(input: GenreOverride) {
    const result = await this.options.database.genresOverride(input)
    this.observe(result.revision)
    return result
  }
  async shutdown() {
    this.stopped = true
    await this.work
  }
}
