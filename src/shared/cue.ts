import { containsGb18030FourByteSequence } from './legacyTextEncoding.ts'
/** CUE parsing is deliberately kept data-only so both local scan workers use identical rules. */
export interface CueRange {
  /** INDEX 01 offset in the referenced audio file, in seconds. */
  startSeconds: number
  /** Exclusive source offset (the next INDEX 01 or EOF), in seconds. */
  endSeconds: number
  /** Legacy presentation value: declared PREGAP, otherwise INDEX 00-to-INDEX 01. */
  pregapSeconds: number
  /** Synthetic silence before INDEX 01, created only by an explicit PREGAP directive. */
  virtualPregapSeconds?: number
  /** Source-backed INDEX 00-to-INDEX 01 interval, retained on the preceding source range. */
  sourcePregapSeconds?: number
}

export interface CueTrackDefinition {
  number: number
  title?: string
  performer?: string
  range: CueRange
}

export interface ParsedCueSheet {
  encoding: 'utf-8-bom' | 'utf-8' | 'gbk' | 'gb18030'
  fileName: string
  title?: string
  performer?: string
  tracks: CueTrackDefinition[]
}

export class CueParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CueParseError'
  }
}

export const MAX_CUE_BYTES = 2 * 1024 * 1024
const FRAME_RATE = 75

/**
 * Normalize a CUE range received through IPC or persistence.  Keeping this validation beside the
 * parser prevents renderer, main-process, and native-queue boundaries from quietly disagreeing
 * about which persisted segments are safe to restore.
 */
export function normalizeCueRange(value: unknown): CueRange | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const range = value as Record<string, unknown>
  const startSeconds = range.startSeconds
  const endSeconds = range.endSeconds
  const pregapSeconds = range.pregapSeconds === undefined ? 0 : range.pregapSeconds
  const virtualPregapSeconds =
    range.virtualPregapSeconds === undefined ? 0 : range.virtualPregapSeconds
  const sourcePregapSeconds =
    range.sourcePregapSeconds === undefined ? 0 : range.sourcePregapSeconds
  if (
    typeof startSeconds !== 'number' ||
    typeof endSeconds !== 'number' ||
    typeof pregapSeconds !== 'number' ||
    typeof virtualPregapSeconds !== 'number' ||
    typeof sourcePregapSeconds !== 'number' ||
    !Number.isFinite(startSeconds) ||
    !Number.isFinite(endSeconds) ||
    !Number.isFinite(pregapSeconds) ||
    !Number.isFinite(virtualPregapSeconds) ||
    !Number.isFinite(sourcePregapSeconds) ||
    startSeconds < 0 ||
    endSeconds <= startSeconds ||
    pregapSeconds < 0 ||
    virtualPregapSeconds < 0 ||
    sourcePregapSeconds < 0 ||
    sourcePregapSeconds > startSeconds ||
    endSeconds > Number.MAX_SAFE_INTEGER
  ) {
    return null
  }
  return {
    startSeconds,
    endSeconds,
    pregapSeconds,
    virtualPregapSeconds,
    sourcePregapSeconds
  }
}

/** Reject a persisted session if either its active Track or any queued Track has a bad range. */
export function playbackSessionCueRangesAreValid(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const session = value as Record<string, unknown>
  if (!trackCueRangePropertyIsValid(session.track)) return false
  if (session.queue === undefined) return true
  return Array.isArray(session.queue) && session.queue.every(trackCueRangePropertyIsValid)
}

export function trackCueRangePropertyIsValid(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const track = value as Record<string, unknown>
  return track.cueRange === undefined || normalizeCueRange(track.cueRange) !== null
}

export function decodeCue(bytes: Uint8Array): {
  text: string
  encoding: ParsedCueSheet['encoding']
} {
  if (bytes.byteLength === 0) throw new CueParseError('CUE file is empty')
  if (bytes.byteLength > MAX_CUE_BYTES) throw new CueParseError('CUE file exceeds the 2 MiB limit')
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: decode(bytes.subarray(3), 'utf-8'), encoding: 'utf-8-bom' }
  }
  try {
    return { text: decode(bytes, 'utf-8'), encoding: 'utf-8' }
  } catch {
    // Node's WHATWG decoder supports both labels. Keep the result explicit: CUE files often
    // contain Chinese metadata and silently decoding an unknown charset corrupts library data.
    // Some ICU builds accept GB18030 four-byte sequences through the `gbk` decoder as an
    // extension. Detect the unambiguous four-byte form first so the persisted encoding remains
    // truthful rather than labelling every legacy Chinese CUE as GBK.
    const legacyDecoders = containsGb18030FourByteSequence(bytes)
      ? ([['gb18030', 'gb18030']] as const)
      : ([
          ['gbk', 'gbk'],
          ['gb18030', 'gb18030']
        ] as const)
    for (const [label, encoding] of legacyDecoders) {
      try {
        const text = decode(bytes, label)
        if (/^\s*(FILE|TRACK|TITLE|PERFORMER)\b/im.test(text)) return { text, encoding }
      } catch {
        // Continue to the next explicitly supported legacy encoding.
      }
    }
    throw new CueParseError(
      'Unsupported or malformed CUE encoding (expected UTF-8, GBK, or GB18030)'
    )
  }
}

export function parseCueSheet(bytes: Uint8Array, sourceDurationSeconds: number): ParsedCueSheet {
  const decoded = decodeCue(bytes)
  const lines = decoded.text.replace(/\r\n?/g, '\n').split('\n')
  let fileName = ''
  let globalTitle: string | undefined
  let globalPerformer: string | undefined
  let current: Partial<RawCueTrack> | null = null
  const tracks: RawCueTrack[] = []

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || /^REM(?:\s|$)/i.test(line)) continue
    const file = line.match(/^FILE\s+(?:"([^"]+)"|(\S+))\s+\S+\s*$/i)
    if (file) {
      const nextFile = (file[1] ?? file[2] ?? '').trim()
      if (!nextFile) throw new CueParseError('CUE FILE directive has an empty path')
      if (fileName && !sameCueFileName(fileName, nextFile)) {
        throw new CueParseError('Only single-audio-file CUE sheets are supported')
      }
      fileName = nextFile
      continue
    }
    const track = line.match(/^TRACK\s+(\d{1,3})\s+(\S+)\s*$/i)
    if (track) {
      if (!fileName) throw new CueParseError('CUE TRACK appears before FILE')
      if (current) tracks.push(finalizeRawTrack(current))
      if (track[2].toUpperCase() !== 'AUDIO')
        throw new CueParseError('Only AUDIO CUE tracks are supported')
      current = {
        number: Number(track[1]),
        title: undefined,
        performer: undefined,
        index00: undefined,
        index01: undefined,
        pregap: 0
      }
      continue
    }
    const title = readCueText(line, 'TITLE')
    if (title !== null) {
      if (current) current.title = title
      else globalTitle = title
      continue
    }
    const performer = readCueText(line, 'PERFORMER')
    if (performer !== null) {
      if (current) current.performer = performer
      else globalPerformer = performer
      continue
    }
    const index = line.match(/^INDEX\s+(00|01)\s+(\d{1,3}:\d{1,2}:\d{1,2})\s*$/i)
    if (index) {
      if (!current) throw new CueParseError('CUE INDEX appears outside TRACK')
      const seconds = parseCueTime(index[2])
      if (index[1] === '00') current.index00 = seconds
      else current.index01 = seconds
      continue
    }
    const pregap = line.match(/^PREGAP\s+(\d{1,3}:\d{1,2}:\d{1,2})\s*$/i)
    if (pregap) {
      if (!current) throw new CueParseError('CUE PREGAP appears outside TRACK')
      current.pregap = parseCueTime(pregap[1])
    }
  }
  if (current) tracks.push(finalizeRawTrack(current))
  if (!fileName) throw new CueParseError('CUE sheet has no FILE directive')
  if (!tracks.length) throw new CueParseError('CUE sheet has no AUDIO tracks')
  if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) {
    throw new CueParseError('Referenced audio duration is unavailable')
  }
  const trackNumbers = new Set<number>()
  for (const track of tracks) {
    if (track.number < 1 || track.number > 99 || trackNumbers.has(track.number)) {
      throw new CueParseError(`Invalid or duplicate CUE track number: ${track.number}`)
    }
    trackNumbers.add(track.number)
  }

  const definitions = tracks.map((track, index) => {
    const startSeconds = track.index01!
    const next = tracks[index + 1]
    // INDEX 00 denotes real audio leading into the following track. The logical next track still
    // starts at INDEX 01; ending the previous range at INDEX 00 would drop that source interval
    // completely and create an artificial hole during album playback. Keep the interval on the
    // preceding track so adjacent source ranges remain continuous. An explicit PREGAP has no
    // source bytes: it is a virtual-silence prefix of the following logical track.
    const endSeconds = next ? next.index01! : sourceDurationSeconds
    if (endSeconds <= startSeconds) {
      throw new CueParseError(`CUE track ${track.number} has a non-positive or overlapping range`)
    }
    if (startSeconds < 0 || endSeconds > sourceDurationSeconds + 0.05) {
      throw new CueParseError(`CUE track ${track.number} falls outside the referenced audio file`)
    }
    const virtualPregapSeconds = track.pregap
    const sourcePregapSeconds =
      track.index00 !== undefined ? Math.max(0, track.index01! - track.index00) : 0
    return {
      number: track.number,
      title: track.title,
      performer: track.performer,
      range: {
        startSeconds,
        endSeconds: Math.min(endSeconds, sourceDurationSeconds),
        pregapSeconds: virtualPregapSeconds || sourcePregapSeconds,
        virtualPregapSeconds,
        sourcePregapSeconds
      }
    }
  })
  return {
    encoding: decoded.encoding,
    fileName,
    title: globalTitle,
    performer: globalPerformer,
    tracks: definitions
  }
}

export function parseCueTime(value: string): number {
  const match = value.match(/^(\d{1,3}):(\d{1,2}):(\d{1,2})$/)
  if (!match) throw new CueParseError(`Invalid CUE time: ${value}`)
  const minutes = Number(match[1])
  const seconds = Number(match[2])
  const frames = Number(match[3])
  if (seconds >= 60 || frames >= FRAME_RATE) throw new CueParseError(`Invalid CUE time: ${value}`)
  return minutes * 60 + seconds + frames / FRAME_RATE
}

function decode(bytes: Uint8Array, encoding: string): string {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    throw new CueParseError(`Invalid ${encoding} CUE data`)
  }
}

function readCueText(line: string, directive: string): string | null {
  const match = line.match(new RegExp(`^${directive}\\s+(?:"([^"]*)"|(.*?))\\s*$`, 'i'))
  return match ? (match[1] ?? match[2] ?? '').trim() : null
}

function sameCueFileName(left: string, right: string): boolean {
  return left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase()
}

interface RawCueTrack {
  number: number
  title?: string
  performer?: string
  index00?: number
  index01?: number
  pregap: number
}

function finalizeRawTrack(track: Partial<RawCueTrack>): RawCueTrack {
  if (!Number.isInteger(track.number) || track.index01 === undefined || track.index01 < 0) {
    throw new CueParseError(`CUE track ${track.number ?? '?'} is missing INDEX 01`)
  }
  if (track.index00 !== undefined && track.index00 > track.index01) {
    throw new CueParseError(`CUE track ${track.number} INDEX 00 is after INDEX 01`)
  }
  return track as RawCueTrack
}
