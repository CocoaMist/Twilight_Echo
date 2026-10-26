import { createAggregatePlaylistModel } from '../../../shared/aggregatePlaylistView.ts'
import * as identity from './logicalTrackModel.ts'

export type * from '../../../shared/aggregatePlaylistView.ts'
export const {
  isAggregatePlaylist,
  sortAggregatePlaylists,
  buildAggregateRows,
  collectAggregateSources,
  resolveAggregateQueue,
  toggleHiddenSource
} = createAggregatePlaylistModel(identity)
