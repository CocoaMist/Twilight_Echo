import type {
  AlbumBrowseDatabaseApi,
  AlbumBrowseQuery,
  AlbumSourcesQuery
} from '../../shared/musicAlbumBrowse.ts'

/** Reads existing library relationships only; browsing never starts discovery or membership writes. */
interface Options {
  database: AlbumBrowseDatabaseApi
  platformContexts(): Record<string, string>
  observeMetadata(revision: number): void
}
export class CoreAlbumBrowseService {
  private readonly options: Options
  constructor(options: Options) {
    this.options = options
  }
  async browse(query: AlbumBrowseQuery) {
    const page = await this.options.database.albumsBrowse(query, {
      platformContexts: this.options.platformContexts()
    })
    this.options.observeMetadata(page.token.metadataRevision)
    return page
  }
  async sources(query: AlbumSourcesQuery) {
    const page = await this.options.database.albumsSources(query, {
      platformContexts: this.options.platformContexts()
    })
    this.options.observeMetadata(page.token.metadataRevision)
    return page
  }
}
