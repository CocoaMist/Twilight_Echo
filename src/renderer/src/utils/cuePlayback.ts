import type { CueRange } from '../../../shared/cue.ts'

export interface CuePlaybackTrack {
  duration: number
  cueRange?: CueRange
}

export function cueDuration(track: CuePlaybackTrack): number {
  const range = validCueRange(track.cueRange)
  return range
    ? virtualPregapSeconds(range) + range.endSeconds - range.startSeconds
    : Math.max(0, Number.isFinite(track.duration) ? track.duration : 0)
}

export function clampCuePlaybackPosition(track: CuePlaybackTrack, value: number): number {
  const position = Math.max(0, Number.isFinite(value) ? value : 0)
  return validCueRange(track.cueRange) ? Math.min(position, cueDuration(track)) : position
}

export function cueVirtualPregapDuration(track: CuePlaybackTrack): number {
  const range = validCueRange(track.cueRange)
  return range ? virtualPregapSeconds(range) : 0
}

function validCueRange(range: CueRange | undefined): CueRange | null {
  if (
    !range ||
    !Number.isFinite(range.startSeconds) ||
    !Number.isFinite(range.endSeconds) ||
    range.startSeconds < 0 ||
    range.endSeconds <= range.startSeconds
  ) {
    return null
  }
  return range
}

function virtualPregapSeconds(range: CueRange): number {
  const value = range.virtualPregapSeconds
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
