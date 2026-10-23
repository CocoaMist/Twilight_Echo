import { createUnifiedSearchSources } from '../../../shared/musicSearchSources.ts'
import { logicalTrackModel } from './logicalTrackModel.ts'
import { getMusicVersions, musicVersionRevision } from '../stores/musicVersions.ts'

export const unifiedSearchSources = createUnifiedSearchSources(logicalTrackModel, () => {
  getMusicVersions()
  return musicVersionRevision.value
})
export const {
  toSearchItem,
  compareSearchItems,
  searchUnifiedLocalPage,
  searchUnifiedNetworkPage
} = unifiedSearchSources
