import type {
  MusicRatingsDatabaseApi,
  MusicRatingsDetail,
  MusicRatingsHistoryQuery,
  MusicRatingsTargetsQuery,
  MusicRatingsSet
} from '../../shared/musicRatings.ts'

interface Options {
  database: MusicRatingsDatabaseApi
  now(): number
  changed(): void
}

/** Personal values are local and never depend on enabling a metadata provider. */
export class CoreMusicRatingsService {
  private readonly options: Options
  private revision: number | null = null
  constructor(options: Options) {
    this.options = options
  }
  getRevision() { return this.revision }
  observe(revision: number) {
    if (this.revision === revision) return
    this.revision = revision
    this.options.changed()
  }
  private present(detail: MusicRatingsDetail): MusicRatingsDetail {
    this.observe(detail.token.ratingsRevision)
    // No external rating provider currently has deployment approval. In
    // particular, identification confidence and popularity are not ratings.
    return { ...detail, external: { status: 'unavailable', reason: 'no_approved_source', items: [] } }
  }
  async detail(entityId: string) {
    return this.present(await this.options.database.ratingsDetail(entityId))
  }
  async set(request: MusicRatingsSet) {
    return this.present(await this.options.database.ratingsSet(request, this.options.now()))
  }
  history(query: MusicRatingsHistoryQuery) {
    return this.options.database.ratingsHistory(query)
  }
  targets(query: MusicRatingsTargetsQuery) {
    return this.options.database.ratingsTargets(query)
  }
}
