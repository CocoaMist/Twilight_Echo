import type { createCoreConnectionStore } from '../coreConnection.ts'
import type { CoreTrackView } from '../../../../shared/coreViews.ts'
import type { TrackData } from '../../../../shared/track.ts'

export type CorePlayerClient = Pick<
  ReturnType<typeof createCoreConnectionStore>,
  'state' | 'status' | 'failure' | 'attach' | 'refresh' | 'command' | 'query' | 'subscribe'
>

/** Display data cannot authorize a local file or a remote playback URL. */
export type CorePlayerTrack = CoreTrackView &
  Pick<
    TrackData,
    | 'cover'
    | 'coverSmall'
    | 'coverSource'
    | 'coverSmallSource'
    | 'lyrics'
    | 'translatedLyrics'
    | 'romanizedLyrics'
    | 'lyricsSource'
    | 'translatedLyricsSource'
    | 'romanizedLyricsSource'
  >
