import type { DatabaseSync } from 'node:sqlite'
import type { LibraryPlaylistLookupRequest } from '../../shared/libraryDatabase.ts'
import { getLogicalTrackKey } from '../../shared/logicalTrackIdentity.ts'
import {
  createRecordingIdentityRules,
  recordingVersionHint,
  type RecordingIdentity
} from '../../shared/recordingIdentity.ts'
import { getTrackSource, versionSourceKey } from '../../shared/trackSourceIdentity.ts'
import { normalizePortableLibraryPath } from '../../shared/playlistPaths.ts'

export const LIBRARY_RECORDING_INDEX_EXPRESSION =
  "library_recording_key(id,json_extract(payload,'$.title'),json_extract(payload,'$.artist'))"
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Expression-index functions must also be installed on read-only recovery
 * connections before SQLite can validate the index's stored values. */
export function registerLibraryRecordingFunctions(sql: DatabaseSync): void {
  sql.function('library_recording_key', { deterministic: true }, (id, title, artist) =>
    getLogicalTrackKey({ id: text(id), title: text(title), artist: text(artist) })
  )
}
const losslessFormats = new Set([
  'flac',
  'alac',
  'wav',
  'wave',
  'aiff',
  'aif',
  'ape',
  'wv',
  'dsf',
  'dff',
  'mqa'
])

type SourceSummary = {
  count: number
  hints: Map<string, number>
  truthy: number
  invalid: number
  min: number
  max: number
}
type Extreme = { source: string; value: number }
/** Pairwise duration/hint compatibility, summarized by source. Ignoring the
 * current source is essential: identical source keys always share identity.
 * Two extrema suffice to exclude any one source without quadratic scans. */
class RecordingGroup {
  readonly items: RecordingIdentity[] = []
  private readonly sources = new Map<string, SourceSummary>()
  private readonly hints = new Map<string, number>()
  private minimum: Extreme[] = []
  private maximum: Extreme[] = []
  private truthy = 0
  private invalid = 0

  accepts(track: RecordingIdentity): boolean {
    const source = versionSourceKey(track),
      own = this.sources.get(source),
      others = this.items.length - (own?.count ?? 0)
    if (!others) return true
    const hint = recordingVersionHint(track)
    if ((this.hints.get(hint) ?? 0) - (own?.hints.get(hint) ?? 0) !== others) return false
    if (!track.duration) return true
    const duration = Number(track.duration)
    if (!Number.isFinite(duration)) return this.truthy - (own?.truthy ?? 0) === 0
    if (this.invalid - (own?.invalid ?? 0)) return false
    const min = this.minimum.find((item) => item.source !== source),
      max = this.maximum.find((item) => item.source !== source)
    return (
      (!min || Math.abs(duration - min.value) <= 8) && (!max || Math.abs(duration - max.value) <= 8)
    )
  }
  add(track: RecordingIdentity): void {
    this.items.push(track)
    const source = versionSourceKey(track),
      hint = recordingVersionHint(track),
      own = this.sources.get(source) ?? {
        count: 0,
        hints: new Map<string, number>(),
        truthy: 0,
        invalid: 0,
        min: Infinity,
        max: -Infinity
      }
    this.sources.set(source, own)
    own.count++
    own.hints.set(hint, (own.hints.get(hint) ?? 0) + 1)
    this.hints.set(hint, (this.hints.get(hint) ?? 0) + 1)
    if (!track.duration) return
    own.truthy++
    this.truthy++
    const duration = Number(track.duration)
    if (!Number.isFinite(duration)) {
      own.invalid++
      this.invalid++
      return
    }
    own.min = Math.min(own.min, duration)
    own.max = Math.max(own.max, duration)
    this.minimum = [
      ...this.minimum.filter((item) => item.source !== source),
      { source, value: own.min }
    ]
      .sort((a, b) => a.value - b.value)
      .slice(0, 2)
    this.maximum = [
      ...this.maximum.filter((item) => item.source !== source),
      { source, value: own.max }
    ]
      .sort((a, b) => b.value - a.value)
      .slice(0, 2)
  }
}

/** Resolve only requested recording buckets. Heavy Track payloads never enter
 * the comparison cache or this response; the renderer hydrates a single page. */
export function lookupPlaylistTrackIds(
  sql: DatabaseSync,
  request: LibraryPlaylistLookupRequest
): Array<string | null> {
  return createPlaylistTrackLookup(sql, request)(request.entries, request.resolution)
}

/** A view resolves bounded batches with one preference index. Recording buckets
 * are shared across adjacent batches, with a fixed LRU rather than a full library. */
export function createPlaylistTrackLookup(
  sql: DatabaseSync,
  request: Pick<LibraryPlaylistLookupRequest, 'versions' | 'preserveSources'>
) {
  const versions = new Map(
    request.versions.flatMap((version) =>
      version.sources.map((source) => [source, version] as const)
    )
  )
  const rules = createRecordingIdentityRules((key) => versions.get(key))
  const cache = new Map<string, RecordingIdentity[]>()
  const exact = sql.prepare('SELECT id FROM tracks WHERE id=?')
  const projection = `SELECT id,json_object('id',id,'source','local',
    'filePath',json_extract(payload,'$.filePath'),'title',json_extract(payload,'$.title'),
    'artist',json_extract(payload,'$.artist'),'album',json_extract(payload,'$.album'),
    'duration',json_extract(payload,'$.duration'),'subTrack',json_extract(payload,'$.subTrack'),
    'cueRange',json_extract(payload,'$.cueRange'),'format',json_extract(payload,'$.format'),
    'bitDepth',json_extract(payload,'$.bitDepth')) AS identity FROM tracks WHERE `
  const byRecording = sql.prepare(
    `${projection}${LIBRARY_RECORDING_INDEX_EXPRESSION}=? ORDER BY seq`
  )
  const byPath = sql.prepare(
    `${projection}playlist_path IN (SELECT value FROM json_each(?)) ORDER BY seq`
  )
  const byId = sql.prepare(`${projection}id=?`)
  function identity(value: unknown): RecordingIdentity {
    const raw = JSON.parse(text(value)) as RecordingIdentity
    const track = { ...raw, title: text(raw.title), artist: text(raw.artist) }
    if (track.cueRange === null) delete track.cueRange
    if (track.subTrack === null) delete track.subTrack
    return track
  }
  const preferred = (track: RecordingIdentity) =>
    rules.preferredSourceKey(track) === versionSourceKey(track) ? 1 : 0
  const lossless = (track: RecordingIdentity) =>
    losslessFormats.has(track.format?.trim().toLowerCase() ?? '') ||
    (typeof track.bitDepth === 'number' && track.bitDepth >= 16)
      ? 1
      : 0
  const compare = (left: RecordingIdentity, right: RecordingIdentity) =>
    preferred(right) - preferred(left) ||
    lossless(right) - lossless(left) ||
    left.title.localeCompare(right.title, 'zh') ||
    left.id.localeCompare(right.id)

  function readCandidates(snapshot: RecordingIdentity): RecordingIdentity[] {
    const key = rules.getRecordingTrackKey(snapshot)
    let candidates = cache.get(key)
    if (!candidates) {
      const version = versions.get(versionSourceKey(snapshot))
      const paths = new Set<string>()
      for (const source of version?.sources ?? []) {
        let identity: unknown
        try {
          identity = JSON.parse(source)
        } catch {
          continue
        }
        if (Array.isArray(identity) && identity[0] === 'local' && typeof identity[1] === 'string')
          paths.add(normalizePortableLibraryPath(identity[1]))
      }
      const rows = version
        ? byPath.iterate(JSON.stringify([...paths]))
        : byRecording.iterate(getLogicalTrackKey(snapshot))
      const groups: RecordingGroup[] = []
      for (const row of rows) {
        // json_object emits null for absent fields; source keys must preserve
        // the payload's actual cueRange shape, including missing pregap keys.
        const track = identity(row.identity)
        if (rules.getRecordingTrackKey(track) !== key) continue
        let group = groups.find((item) => key.startsWith('version:') || item.accepts(track))
        if (!group) {
          group = new RecordingGroup()
          groups.push(group)
        }
        group.add(track)
      }
      candidates = groups.flatMap((group) => group.items.sort(compare))
      cache.set(key, candidates)
      while (cache.size > 64) cache.delete(cache.keys().next().value!)
    } else {
      cache.delete(key)
      cache.set(key, candidates)
    }
    return candidates
  }

  const resolve = (
    entries: LibraryPlaylistLookupRequest['entries'],
    resolution?: LibraryPlaylistLookupRequest['resolution']
  ) =>
    entries.map(({ id, snapshot, sourceIds }) => {
      if (resolution === 'recent') {
        // History first checks known source IDs, then uses the first logical
        // group's preferred local recording. Unlike playlist relocation it does
        // not compare the old history duration against the local replacement.
        for (const source of sourceIds ?? []) {
          const row = byId.get(source)
          if (row) return readCandidates(identity(row.identity))[0]?.id ?? source
        }
        return snapshot ? (readCandidates(snapshot)[0]?.id ?? null) : null
      }
      if (exact.get(id)) return id
      if (!snapshot || (request.preserveSources && getTrackSource(snapshot) !== 'local'))
        return null
      const candidates = readCandidates(snapshot)
      const source = rules.preferredSourceKey(snapshot)
      return (
        candidates.find(
          (track) =>
            rules.canShareTrackIdentity(snapshot, track) &&
            (!source || versionSourceKey(track) === source)
        )?.id ?? null
      )
    })
  return Object.assign(resolve, {
    recordingKey: (track: RecordingIdentity) => rules.getRecordingTrackKey(track)
  })
}
