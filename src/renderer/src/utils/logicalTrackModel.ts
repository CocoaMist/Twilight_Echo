import { createLogicalTrackModel } from '../../../shared/logicalTrackModel.ts'
import { sourceVersion } from '../stores/musicVersions.ts'
export type {
  SourceVariantInput,
  SourceVariant,
  LogicalTrack
} from '../../../shared/logicalTrackModel.ts'
export { getTrackSource } from '../../../shared/trackSourceIdentity.ts'
export { canShareLogicalTrack } from '../../../shared/recordingIdentity.ts'
export const logicalTrackModel = createLogicalTrackModel((key) => sourceVersion('tracks', key))
export const {
  buildLogicalTracks,
  toSourceVariant,
  compareSourceVariants,
  compareSourceVariantPriority,
  compareSourceVariantsByTitle,
  canShareTrackIdentity,
  getRecordingTrackKey,
  preferredSourceKey,
  isLosslessTrack,
  clampReliability
} = logicalTrackModel
