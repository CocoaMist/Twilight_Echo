import type {
  LibraryCollectionKind,
  LibraryCollectionPage,
  LibraryQuery
} from './libraryDatabase.ts'
import type { CoreLibraryPage } from './coreViews.ts'
import { normalizeCueRange } from './cue.ts'
import type { CueRange } from './cue.ts'
import type { RecordingIdentity } from './recordingIdentity.ts'

export type CoreRecentTrackHint = RecordingIdentity & {
  subTrack?: string
  cueRange?: CueRange
  ncmSongId?: number
}
export type CoreRecentLibraryEntry = {
  id: string
  sourceIds?: string[]
  snapshot?: CoreRecentTrackHint
}

/** Bounded read projections. Neither a path lookup nor a track view grants media access. */
export interface CoreLibraryQueries {
  'library.recent.resolve': {
    input: {
      entries: CoreRecentLibraryEntry[]
      revision: number
      versionsRevision: number
    }
    output: { ids: Array<string | null>; revision: number; versionsRevision: number }
  }
  'library.artwork': {
    input: { ids: string[]; revision?: number }
    output: { revision: number; items: Array<{ id: string; cover: string | null }> }
  }
  'library.collections': {
    input: { kind: LibraryCollectionKind; query?: LibraryQuery }
    output: LibraryCollectionPage
  }
  'library.byIds': {
    input: { ids: string[]; revision?: number }
    output: CoreLibraryPage
  }
  'library.paths.lookup': {
    input: { paths: string[]; revision?: number }
    output: { ids: Array<string | null>; revision: number }
  }
}

export type CoreLibraryReadRequest = {
  [K in keyof CoreLibraryQueries]: { name: K; payload: CoreLibraryQueries[K]['input'] }
}[keyof CoreLibraryQueries]

export function validCoreLibraryReadPayload(
  name: string,
  value: unknown,
  query: (value: unknown) => boolean
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  const keys = (allowed: string[]) => Object.keys(v).every((key) => allowed.includes(key))
  const revision =
    v.revision === undefined || (Number.isSafeInteger(v.revision) && Number(v.revision) >= 0)
  if (name === 'library.recent.resolve') {
    if (
      !keys(['entries', 'revision', 'versionsRevision']) ||
      !Number.isSafeInteger(v.revision) ||
      Number(v.revision) < 0 ||
      !Number.isSafeInteger(v.versionsRevision) ||
      Number(v.versionsRevision) < 0 ||
      !Array.isArray(v.entries) ||
      v.entries.length > 30
    )
      return false
    let encodedBudget = 64 * 1024
    const boundedText = (value: unknown, allowEmpty = true): value is string => {
      if (
        typeof value !== 'string' ||
        (!allowEmpty && value.length === 0) ||
        value.length > 32768 ||
        value.includes('\0')
      )
        return false
      encodedBudget += value.length * 6
      return encodedBudget <= 512 * 1024
    }
    return v.entries.every((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
      const item = entry as Record<string, unknown>
      if (!Object.keys(item).every((key) => ['id', 'snapshot', 'sourceIds'].includes(key))) return false
      if (!boundedText(item.id, false)) return false
      if (
        item.sourceIds !== undefined &&
        (!Array.isArray(item.sourceIds) ||
          item.sourceIds.length > 200 ||
          !item.sourceIds.every((id) => boundedText(id, false)))
      )
        return false
      if (item.snapshot === undefined) return true
      const snapshot = item.snapshot
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false
      const value = snapshot as Record<string, unknown>
      if (
        !Object.keys(value).every((key) =>
          [
            'id',
            'title',
            'artist',
            'album',
            'filePath',
            'format',
            'source',
            'duration',
            'bitDepth',
            'subTrack',
            'cueRange',
            'ncmSongId'
          ].includes(key)
        )
      )
        return false
      if (!boundedText(value.id, false) || !boundedText(value.title) || !boundedText(value.artist)) return false
      if (
        !['album', 'filePath', 'format', 'source', 'subTrack'].every(
          (key) => value[key] === undefined || boundedText(value[key])
        )
      )
        return false
      if (
        value.duration !== undefined &&
        (typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration < 0)
      )
        return false
      if (
        value.bitDepth !== undefined &&
        (typeof value.bitDepth !== 'number' || !Number.isFinite(value.bitDepth) || value.bitDepth < 0)
      )
        return false
      if (
        value.ncmSongId !== undefined &&
        (!Number.isSafeInteger(value.ncmSongId) || Number(value.ncmSongId) < 0)
      )
        return false
      if (
        value.cueRange !== undefined &&
        (!value.cueRange || typeof value.cueRange !== 'object' || Array.isArray(value.cueRange))
      )
        return false
      if (value.cueRange !== undefined) {
        const cueRange = value.cueRange as Record<string, unknown>
        if (
          !Object.keys(cueRange).every((key) =>
            ['startSeconds', 'endSeconds', 'pregapSeconds', 'virtualPregapSeconds', 'sourcePregapSeconds'].includes(key)
          ) ||
          normalizeCueRange(cueRange) === null
        )
          return false
      }
      return true
    })
  }
  if (name === 'library.collections')
    return (
      keys(['kind', 'query']) &&
      ['albums', 'artists', 'genres', 'folders', 'playlists'].includes(String(v.kind)) &&
      (v.query === undefined || query(v.query))
    )
  const byId = name === 'library.byIds' || name === 'library.artwork'
  const list = byId ? v.ids : v.paths
  return (
    (byId || name === 'library.paths.lookup') &&
    keys([byId ? 'ids' : 'paths', 'revision']) &&
    revision &&
    Array.isArray(list) &&
    list.length <= 200 &&
    list.every(
      (id) => typeof id === 'string' && id.length > 0 && id.length <= 32768 && !id.includes('\0')
    )
  )
}
