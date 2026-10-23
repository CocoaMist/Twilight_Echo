import { createPlaybackFallback } from '../../../shared/playbackFallback.ts'
import { logicalTrackModel } from './logicalTrackModel.ts'
export type { PlaybackFallbackOptions } from '../../../shared/playbackFallback.ts'
export { clampProviderReliability } from '../../../shared/playbackFallback.ts'
export const { findPlaybackFallbackTrack } = createPlaybackFallback(logicalTrackModel)
