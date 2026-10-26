export type * from '../../../shared/unifiedMusicSearch.ts'
import { createUnifiedMusicSearch } from '../../../shared/unifiedMusicSearch.ts'
import { logicalTrackModel } from './logicalTrackModel.ts'
import { unifiedSearchSources } from './unifiedSearchSources.ts'

export const { unifiedSearchSongs, buildLogicalMusicItems } = createUnifiedMusicSearch(
  logicalTrackModel,
  unifiedSearchSources
)
