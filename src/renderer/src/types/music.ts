export type { BpmTempoSegment, BpmAnalysisResult } from '../../../shared/audioEngineTypes.ts'
export type {
  BuiltInTrackSource,
  TrackSource,
  MetadataMatchConfidence,
  TrackMetadataMatch
} from '../../../shared/track.ts'
export type { LyricSource } from '../../../shared/lyricsManagement.ts'
import type { PlaybackSessionData } from '../../../shared/playbackSession.ts'

export type { TrackArtistRef } from '../../../shared/track.ts'
/** UI data is a display projection, not authority to open media or write a row.
 * Legacy provider/page hints may be present; source paths and heavy data are
 * optional and Core owns every operation that requires them. */
export type Track = import('../../../shared/coreViews.ts').CoreTrackView &
  Partial<
    Omit<
      import('../../../shared/track.ts').TrackData,
      keyof import('../../../shared/coreViews.ts').CoreTrackView
    >
  >

export type PlaybackSession = PlaybackSessionData<Track>

export { SUPPORTED_EXTENSIONS } from '../../../shared/audioFormats.ts'
