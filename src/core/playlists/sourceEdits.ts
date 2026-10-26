import type { CoreQueueTrackInput } from '../../shared/coreQueueSubmission.ts'
import type { TrackData } from '../../shared/track.ts'
import type { UnifiedSearchResult } from '../../shared/unifiedMusicSearch.ts'
import { buildMetadataMatchCandidates } from '../../shared/musicMetadataMatching.ts'
import { projectCoreTrack } from '../projections.ts'

export class CorePlaylistSourceEdits {
  private readonly options: {
    resolve(inputs: readonly CoreQueueTrackInput[], signal: AbortSignal): Promise<TrackData[]>
    search(query: string, signal: AbortSignal): Promise<UnifiedSearchResult>
    replace(oldId: string, track: TrackData, revision: number, signal: AbortSignal): Promise<{ revision: number; count: number }>
  }
  constructor(options: CorePlaylistSourceEdits['options']) { this.options = options }
  async replace(revision: number, oldId: string, input: CoreQueueTrackInput, signal: AbortSignal) {
    const [track] = await this.options.resolve([input], signal)
    return { ...await this.options.replace(oldId, track, revision, signal), track: projectCoreTrack(track) }
  }
  async rematch(revision: number, input: CoreQueueTrackInput, signal: AbortSignal) {
    const [source] = await this.options.resolve([input], signal)
    const result = await this.options.search([source.title, source.artist].filter(Boolean).join(' '), signal)
    const track = buildMetadataMatchCandidates(source, result.items.map((item) => item.track))[0]?.track
    if (!track) return { revision, count: 0, track: null }
    signal.throwIfAborted()
    return { ...await this.options.replace(source.id, track, revision, signal), track: projectCoreTrack(track) }
  }
}
