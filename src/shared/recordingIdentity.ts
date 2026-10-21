import { getLogicalTrackKey } from './logicalTrackIdentity.ts'
import {
  getTrackSource,
  versionSourceKey,
  type TrackSourceIdentity
} from './trackSourceIdentity.ts'

export interface RecordingIdentity extends TrackSourceIdentity {
  title: string
  artist: string
  album?: string
  duration?: number
  format?: string
  bitDepth?: number
}
export interface RecordingVersion {
  id: string
  sources: string[]
  preferredSource: string | null
}

export function recordingVersionHint(track: RecordingIdentity): string {
  return (
    (track.title + ' ' + track.album)
      .match(
        /\blive\b|现场|\bremaster(?:ed)?\b|重制|\bacoustic\b|\bunplugged\b|不插电|\binstrumental\b|伴奏/gi
      )
      ?.map((hint) => hint.toLowerCase())
      .sort()
      .join(':') ?? ''
  )
}

export function canShareLogicalTrack(left: RecordingIdentity, right: RecordingIdentity): boolean {
  if (!left.duration || !right.duration) return true
  return Math.abs(left.duration - right.duration) <= 8
}

/** The renderer supplies its live version index; the worker supplies the
 * request's frozen index. Both use exactly the same recording rules. */
export function createRecordingIdentityRules(
  sourceVersion: (key: string) => RecordingVersion | undefined
) {
  function canShareTrackIdentity(left: RecordingIdentity, right: RecordingIdentity): boolean {
    if (versionSourceKey(left) === versionSourceKey(right)) return true
    const leftVersion = sourceVersion(versionSourceKey(left)),
      rightVersion = sourceVersion(versionSourceKey(right))
    if (leftVersion || rightVersion) return !!leftVersion && leftVersion.id === rightVersion?.id
    if (getLogicalTrackKey(left) !== getLogicalTrackKey(right)) return false
    if (recordingVersionHint(left) !== recordingVersionHint(right)) return false
    const leftRemote = recordingRemoteRef(left),
      rightRemote = recordingRemoteRef(right)
    if (
      leftRemote &&
      rightRemote &&
      leftRemote.provider === rightRemote.provider &&
      leftRemote.id !== rightRemote.id
    )
      return false
    return canShareLogicalTrack(left, right)
  }
  return {
    canShareTrackIdentity,
    getRecordingTrackKey(track: RecordingIdentity): string {
      const version = sourceVersion(versionSourceKey(track))
      return version ? `version:${version.id}` : getLogicalTrackKey(track)
    },
    preferredSourceKey: (track: RecordingIdentity) =>
      sourceVersion(versionSourceKey(track))?.preferredSource ?? null
  }
}

export function recordingRemoteRef(
  track: RecordingIdentity
): { provider: string; id: string } | null {
  const source = getTrackSource(track)
  if (source === 'local') return null
  if (track.ncmSongId != null) return { provider: 'ncm', id: String(track.ncmSongId) }
  const separatorIndex = track.id.indexOf(':')
  const id = separatorIndex > 0 ? track.id.slice(separatorIndex + 1).trim() : ''
  return id ? { provider: source, id } : null
}
