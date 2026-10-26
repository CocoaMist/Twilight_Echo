import type { CueRange } from './cue.ts'
import type { TrackData } from './track.ts'

/** Display hints are not source authority. Core looks up local/network/stream
 * identities and resolves provider URLs itself. Each array position is a new occurrence. */
export type CoreQueueTrackInput =
  | { kind: 'occurrence'; queueId: string; revision: number; occurrenceId: string }
  | {
      kind: 'local'
      id: string
      fallback?: Pick<TrackData, 'filePath' | 'title' | 'artist' | 'album' | 'duration'> & {
        subTrack?: string
        cueRange?: CueRange
      }
    }
  | {
      kind: 'provider'
      track: Pick<TrackData, 'id' | 'title' | 'artist' | 'album' | 'duration' | 'ncmSongId'> & {
        source: string
      }
    }
  | { kind: 'network'; revision: number; profileId: string; entryId: string }
  | { kind: 'stream'; source: 'radio' | 'podcast'; id: string }

export type CoreQueueSubmitCommand =
  | { kind: 'begin'; selectedIndex: number; position?: number; play?: boolean }
  | { kind: 'append'; id: string; sequence: number; items: CoreQueueTrackInput[] }
  | { kind: 'commit'; id: string; sequence: number }
  | { kind: 'abort'; id: string }

export interface CoreQueueSubmitReply {
  id: string
  state: 'building' | 'committed' | 'aborted'
  sequence: number
  total: number
}
export interface CoreQueueInsert {
  id: string
  revision: number
  items: CoreQueueTrackInput[]
  afterEntryId?: string
  beforeEntryId?: string
}
