import type { AlbumBrowseDatabaseApi } from '../../shared/musicAlbumBrowse.ts'
import type { GenreBrowseDatabaseApi } from '../../shared/musicGenreBrowse.ts'
import type { UnifiedPlaybackRequest } from '../../shared/musicUnifiedPlayback.ts'

/** A public query token is re-evaluated by SQL; client-supplied IDs are never authority. */
interface Options {
  database: Pick<GenreBrowseDatabaseApi, 'genresContainsSources'> &
    Pick<AlbumBrowseDatabaseApi, 'albumsContainsSource'>
  platformContexts(): Record<string, string>
}
export class CoreCatalogPlaybackScope {
  private readonly options: Options
  constructor(options: Options) {
    this.options = options
  }
  async allowed(
    request: UnifiedPlaybackRequest,
    sourceIds: string[],
    signal: AbortSignal
  ): Promise<string[]> {
    signal.throwIfAborted()
    if (sourceIds.length > 200) throw new Error('Playback scope page exceeds 200')
    const context = { platformContexts: this.options.platformContexts() }
    if (request.scope) {
      const allowed = await this.options.database.genresContainsSources(
        request.scope,
        sourceIds,
        context
      )
      signal.throwIfAborted()
      return allowed
    }
    if (request.albumScope) {
      const result: string[] = []
      for (const id of sourceIds) {
        signal.throwIfAborted()
        if (await this.options.database.albumsContainsSource(request.albumScope, id, context))
          result.push(id)
      }
      signal.throwIfAborted()
      return result
    }
    return sourceIds
  }
}
