import {
  LIBRARY_MAX_PAGE_SIZE,
  LIBRARY_PAGE_SIZE,
  type LibraryQuery
} from '../../shared/libraryDatabase.ts'
import type { LibraryFileMutationApi } from '../../shared/libraryDatabase.ts'
import type { LibraryHistorySyncRequest } from '../../shared/libraryDatabase.ts'
import type { LibraryPlaylistLookupRequest } from '../../shared/libraryDatabase.ts'
import type { LibraryPlaylistViewSync } from '../../shared/libraryDatabase.ts'
import type { LibraryQueueEdit, LibraryQueueInsertItem } from '../../shared/libraryDatabase.ts'
import { stringifyJsonWithNestingLimit } from '../security/jsonSafety.ts'
import { isAbsolute } from 'node:path'
import { getTrackSource } from '../../shared/trackSourceIdentity.ts'
import {
  LIBRARY_QUEUE_BUILD_MAX_ENTRIES,
  type LibraryQueueBuildCommand
} from '../../shared/libraryQueueBuild.ts'

export function validateLibraryQueueBuild(
  input: unknown
): asserts input is LibraryQueueBuildCommand {
  if (!record(input)) throw new Error('Invalid library queue stream')
  if (typeof input.id !== 'string' || !/^[\w-]{1,128}$/.test(input.id))
    throw new Error('Invalid library queue stream identity')
  if (input.kind === 'abort') return
  if (input.kind === 'begin') {
    if (
      !Number.isSafeInteger(input.contentRevision) ||
      Number(input.contentRevision) < 0 ||
      (input.order !== 'original' && input.order !== 'shuffle')
    )
      throw new Error('Invalid library queue stream start')
    return
  }
  if (!Number.isSafeInteger(input.sequence) || Number(input.sequence) < 1)
    throw new Error('Invalid library queue stream sequence')
  if (input.kind === 'commit') {
    if (!Number.isSafeInteger(input.selectedIndex) || Number(input.selectedIndex) < -1)
      throw new Error('Invalid queue stream selection')
    return
  }
  if (
    input.kind !== 'append' ||
    !Array.isArray(input.items) ||
    input.items.length > LIBRARY_PAGE_SIZE
  )
    throw new Error('Invalid or oversized library queue stream batch')
  for (const item of input.items) {
    if (!record(item)) throw new Error('Invalid library queue stream occurrence')
    if (item.localSnapshot !== undefined) {
      if (
        item.snapshot !== undefined ||
        !record(item.localSnapshot) ||
        getTrackSource({
          id: String(item.id),
          source:
            typeof item.localSnapshot.source === 'string' ? item.localSnapshot.source : undefined
        }) !== 'local'
      )
        throw new Error('Invalid local library queue seed')
      validateLibraryQueueInsertItem({ id: item.id, snapshot: item.localSnapshot }, true)
    } else validateLibraryQueueInsertItem(item)
    if (
      (item.originalPosition !== undefined &&
        (!Number.isSafeInteger(item.originalPosition) ||
          Number(item.originalPosition) < 0 ||
          Number(item.originalPosition) >= LIBRARY_QUEUE_BUILD_MAX_ENTRIES)) ||
      (record(item.snapshot) && item.snapshot.source === 'playlist-import')
    )
      throw new Error('Invalid library queue stream occurrence')
  }
}

export function validateLibraryDirectoryScan(
  value: unknown
): asserts value is Parameters<LibraryFileMutationApi['scanDirectories']>[0] {
  if (
    !record(value) ||
    (value.reason !== 'import' && value.reason !== 'tags') ||
    !Array.isArray(value.directories) ||
    !value.directories.length ||
    value.directories.length > LIBRARY_MAX_PAGE_SIZE ||
    value.directories.some(
      (path) =>
        typeof path !== 'string' ||
        !path ||
        path.length > 32768 ||
        path.includes('\0') ||
        !isAbsolute(path)
    )
  )
    throw new Error('Invalid or oversized library directory scan request')
}

export function validateLibraryFileRemoval(
  value: unknown
): asserts value is Parameters<LibraryFileMutationApi['removeFiles']>[0] {
  if (
    !record(value) ||
    (value.mode !== 'library' && value.mode !== 'trash') ||
    !Array.isArray(value.items) ||
    value.items.length > LIBRARY_MAX_PAGE_SIZE
  )
    throw new Error('Invalid or oversized library removal request')
  for (const item of value.items) {
    if (
      !record(item) ||
      ['id', 'filePath', 'title', 'artist'].some(
        (key) => typeof item[key] !== 'string' || item[key].length > 32768
      ) ||
      !item.id ||
      !item.filePath ||
      (item.expectedVersion !== undefined &&
        (!Number.isSafeInteger(item.expectedVersion) || Number(item.expectedVersion) < 1)) ||
      (item.expectedInstance !== undefined &&
        (item.expectedVersion === undefined ||
          !Number.isSafeInteger(item.expectedInstance) ||
          Number(item.expectedInstance) < 1))
    )
      throw new Error('Invalid library removal item')
  }
}

const sorts = new Set([
  'title',
  'artist',
  'album',
  'format',
  'trackNumber',
  'duration',
  'sampleRate',
  'addedAt',
  'recentlyAdded',
  'lastPlayed',
  'playlist',
  'insertion',
  'unifiedSearch'
])
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const queueEntryId = (value: unknown): value is string =>
  typeof value === 'string' && !!value && value.length <= 128

export function libraryPageBounds(
  offset = 0,
  limit = LIBRARY_PAGE_SIZE
): { offset: number; limit: number } {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > LIBRARY_MAX_PAGE_SIZE
  )
    throw new Error('Invalid library page')
  return { offset, limit }
}

/** Validate in the data owner as well as the eventual renderer IPC seam. */
export function validateLibraryQuery(value: unknown): asserts value is LibraryQuery {
  if (!record(value)) throw new Error('Invalid library query')
  if (
    value.playlistView !== undefined &&
    (typeof value.playlistView !== 'string' ||
      !value.playlistView ||
      value.playlistView.length > 128)
  )
    throw new Error('Invalid playlist query identity')
  if (
    value.playlistEntryId !== undefined &&
    (typeof value.playlistView !== 'string' ||
      typeof value.playlistEntryId !== 'string' ||
      !/^(0|[1-9]\d{0,6})$/.test(value.playlistEntryId))
  )
    throw new Error('Invalid playlist occurrence')
  if (
    value.contentRevision !== undefined &&
    (!Number.isSafeInteger(value.contentRevision) || Number(value.contentRevision) < 0)
  )
    throw new Error('Invalid library content revision')
  if (
    value.historyRevision !== undefined &&
    (!Number.isSafeInteger(value.historyRevision) || Number(value.historyRevision) < 0)
  )
    throw new Error('Invalid library history revision')
  for (const key of [
    'search',
    'folder',
    'artist',
    'albumId',
    'genre',
    'genreSeparators',
    'collectionGenre',
    'anchorId'
  ]) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 32768))
      throw new Error(`Invalid library query ${key}`)
  }
  for (const key of [
    'searchFileName',
    'searchLiteral',
    'recursive',
    'collectionNamesOnly',
    'collectionCountOnly'
  ])
    if (value[key] !== undefined && typeof value[key] !== 'boolean')
      throw new Error(`Invalid library query ${key}`)
  if (
    value.collectionSearchMode !== undefined &&
    !['albumTerms', 'artistName'].includes(value.collectionSearchMode as string)
  )
    throw new Error('Invalid library collection search mode')
  if (
    value.collectionSort !== undefined &&
    value.collectionSort !== 'trackCount' &&
    value.collectionSort !== 'label'
  )
    throw new Error('Invalid library collection sort')
  if (value.sort !== undefined && (typeof value.sort !== 'string' || !sorts.has(value.sort)))
    throw new Error('Unknown library sort')
  if (value.direction !== undefined && value.direction !== 'asc' && value.direction !== 'desc')
    throw new Error('Unknown library sort direction')
  if (value.ids !== undefined) validateLibraryIds(value.ids)
  if (value.aggregate !== undefined) {
    const aggregate = value.aggregate
    if (
      !record(aggregate) ||
      Object.keys(aggregate).some(
        (key) =>
          !['hiddenSources', 'variantPreferences', 'variantRow', 'sourceCounts'].includes(key)
      ) ||
      typeof value.playlistView !== 'string' ||
      (aggregate.hiddenSources !== undefined &&
        (!Array.isArray(aggregate.hiddenSources) ||
          aggregate.hiddenSources.some(
            (source) => typeof source !== 'string' || source.length > 32768
          ))) ||
      (aggregate.variantPreferences !== undefined &&
        (!record(aggregate.variantPreferences) ||
          Object.entries(aggregate.variantPreferences).some(
            ([id, source]) =>
              !id ||
              id.length > 32768 ||
              typeof source !== 'string' ||
              !source ||
              source.length > 32768
          ))) ||
      (aggregate.variantRow !== undefined &&
        (typeof aggregate.variantRow !== 'string' ||
          !/^(0|[1-9]\d{0,6})$/.test(aggregate.variantRow))) ||
      (aggregate.sourceCounts !== undefined && typeof aggregate.sourceCounts !== 'boolean') ||
      (aggregate.sourceCounts === true && aggregate.variantRow !== undefined) ||
      Buffer.byteLength(stringifyJsonWithNestingLimit(aggregate, 'aggregate playlist query')) >
        20 * 1024 * 1024
    )
      throw new Error('Invalid or oversized aggregate playlist query')
    const allowed = new Set([
      'playlistView',
      'playlistEntryId',
      'aggregate',
      'search',
      'searchLiteral',
      'sort',
      'contentRevision',
      'offset',
      'limit',
      'anchorId'
    ])
    if (
      Object.entries(value).some(([key, part]) => part !== undefined && !allowed.has(key)) ||
      (value.sort !== undefined && value.sort !== 'playlist')
    )
      throw new Error('Unsupported aggregate playlist query scope')
  }
  if (value.collectionOrder !== undefined) {
    if (
      !Array.isArray(value.collectionOrder) ||
      value.collectionOrder.length > 1_000_000 ||
      value.collectionOrder.some((id) => typeof id !== 'string' || !id || id.length > 32768) ||
      Buffer.byteLength(JSON.stringify(value.collectionOrder)) > 20 * 1024 * 1024
    )
      throw new Error('Invalid or oversized playlist collection order')
  }
  if (value.preferredSources !== undefined) {
    if (!Array.isArray(value.preferredSources) || value.preferredSources.length > 20000)
      throw new Error('Invalid library search preferences')
    let length = 0
    for (const source of value.preferredSources) {
      if (
        typeof source !== 'string' ||
        !source ||
        source.length > 8192 ||
        (length += source.length) > 8 * 1024 * 1024
      )
        throw new Error('Invalid or oversized library search preferences')
    }
    if (JSON.stringify(value.preferredSources).length > 8 * 1024 * 1024)
      throw new Error('Oversized library search preferences')
  }
  libraryPageBounds(value.offset as number | undefined, value.limit as number | undefined)
  if (value.filters !== undefined) {
    if (!record(value.filters)) throw new Error('Invalid library filters')
    for (const key of ['lossless', 'dsd'])
      if (value.filters[key] !== undefined && typeof value.filters[key] !== 'boolean')
        throw new Error(`Invalid library filter ${key}`)
    for (const key of ['sampleRate', 'bitDepth'])
      if (
        value.filters[key] !== undefined &&
        (typeof value.filters[key] !== 'number' ||
          !Number.isFinite(value.filters[key]) ||
          value.filters[key] <= 0)
      )
        throw new Error(`Invalid library filter ${key}`)
    for (const key of ['folder', 'provider'])
      if (
        value.filters[key] !== undefined &&
        (typeof value.filters[key] !== 'string' || value.filters[key].length > 32768)
      )
        throw new Error(`Invalid library filter ${key}`)
  }
}

export function validateLibraryQueueReadOptions(
  value: unknown
): asserts value is import('../../shared/libraryDatabase.ts').LibraryQueueReadOptions {
  if (value === undefined) return
  if (
    !record(value) ||
    Object.keys(value).some((key) => !['expectedRevision', 'search'].includes(key))
  )
    throw new Error('Invalid library queue read options')
  if (
    value.expectedRevision !== undefined &&
    (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0)
  )
    throw new Error('Invalid library queue revision')
  if (
    value.search !== undefined &&
    (typeof value.search !== 'string' || value.search.length > 32768)
  )
    throw new Error('Invalid library queue search')
}

export function validateLibraryHistorySync(
  value: unknown
): asserts value is LibraryHistorySyncRequest {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    !value.id ||
    value.id.length > 128 ||
    value.id.includes('\0')
  )
    throw new Error('Invalid history projection identity')
  if (value.kind === 'begin') {
    if (
      !['replace', 'patch'].includes(String(value.mode)) ||
      (value.mode === 'patch' && value.expectedRevision === undefined) ||
      (value.expectedRevision !== undefined &&
        (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0))
    )
      throw new Error('Invalid history projection start')
  } else if (value.kind === 'append' || value.kind === 'commit') {
    if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1)
      throw new Error('Invalid history projection sequence')
    if (
      value.kind === 'append' &&
      (!Array.isArray(value.entries) ||
        value.entries.length > LIBRARY_MAX_PAGE_SIZE ||
        value.entries.some(
          (entry) =>
            !record(entry) ||
            typeof entry.id !== 'string' ||
            !entry.id ||
            entry.id.length > 32768 ||
            typeof entry.lastPlayed !== 'number' ||
            !Number.isFinite(entry.lastPlayed) ||
            entry.lastPlayed < 0 ||
            entry.lastPlayed > Number.MAX_SAFE_INTEGER
        ))
    )
      throw new Error('Invalid or oversized history projection batch')
  } else throw new Error('Unknown history projection operation')
}

export function validateLibraryIds(value: unknown): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > LIBRARY_MAX_PAGE_SIZE ||
    value.some((id) => typeof id !== 'string' || !id || id.length > 32768)
  )
    throw new Error('Invalid or oversized library identity batch')
}

const queueSnapshotStringFields = [
  'title',
  'artist',
  'album',
  'fileName',
  'dir',
  'format',
  'source',
  'cover',
  'coverSource',
  'coverSmall',
  'coverSmallSource',
  'streamUrl'
] as const

function validateLibraryQueueInsertItem(
  value: unknown,
  allowLocal = false
): asserts value is LibraryQueueInsertItem {
  if (!record(value) || typeof value.id !== 'string' || !value.id || value.id.length > 32768)
    throw new Error('Invalid library queue insertion item')
  if (value.snapshot === undefined) return
  const snapshot = value.snapshot
  if (
    !record(snapshot) ||
    snapshot.id !== value.id ||
    typeof snapshot.filePath !== 'string' ||
    !snapshot.filePath ||
    snapshot.filePath.includes('\0') ||
    snapshot.filePath.length > 32768 ||
    (!allowLocal &&
      getTrackSource({
        id: value.id,
        source: typeof snapshot.source === 'string' ? snapshot.source : undefined
      }) === 'local')
  )
    throw new Error('Invalid remote library queue snapshot')
  for (const key of queueSnapshotStringFields) {
    if (
      snapshot[key] !== undefined &&
      !(
        snapshot[key] === null &&
        ['cover', 'coverSource', 'coverSmall', 'coverSmallSource', 'streamUrl'].includes(key)
      ) &&
      (typeof snapshot[key] !== 'string' || snapshot[key].length > 32768)
    )
      throw new Error('Invalid remote library queue snapshot')
  }
  for (const key of ['duration', 'size', 'sampleRate', 'bitrate', 'bitDepth', 'ncmSongId']) {
    if (
      snapshot[key] !== undefined &&
      (typeof snapshot[key] !== 'number' || !Number.isFinite(snapshot[key]))
    )
      throw new Error('Invalid remote library queue snapshot')
  }
  const payload = stringifyJsonWithNestingLimit(snapshot, 'library queue snapshot')
  if (Buffer.byteLength(payload, 'utf8') > 512 * 1024)
    throw new Error('Remote library queue snapshot is too large')
}

export function validateLibraryQueueEdit(value: unknown): asserts value is LibraryQueueEdit {
  if (!record(value) || typeof value.kind !== 'string') throw new Error('Invalid queue edit')
  if (value.kind === 'undo') {
    if (Object.keys(value).some((key) => key !== 'kind')) throw new Error('Invalid queue undo')
    return
  }
  if (value.kind === 'mode') {
    if (
      Object.keys(value).some((key) => !['kind', 'mode'].includes(key)) ||
      !['sequential', 'listLoop', 'repeat', 'shuffle'].includes(value.mode as string)
    )
      throw new Error('Invalid library queue mode')
    return
  }
  if (value.kind !== 'insert') return
  const hasIds = value.trackIds !== undefined,
    hasItems = value.items !== undefined
  if (hasIds === hasItems || (hasIds && !Array.isArray(value.trackIds)))
    throw new Error('Invalid library queue insertion')
  if (hasIds) validateLibraryIds(value.trackIds)
  else {
    if (!Array.isArray(value.items) || value.items.length > LIBRARY_MAX_PAGE_SIZE)
      throw new Error('Invalid or oversized library queue insertion')
    for (const item of value.items) validateLibraryQueueInsertItem(item)
    if (
      Buffer.byteLength(stringifyJsonWithNestingLimit(value.items, 'library queue insertion')) >
      8 * 1024 * 1024
    )
      throw new Error('Library queue insertion is too large')
  }
  for (const key of ['afterEntryId', 'beforeEntryId']) {
    if (value[key] !== undefined && !queueEntryId(value[key]))
      throw new Error('Invalid queue insertion anchor')
  }
  if (value.afterEntryId !== undefined && value.beforeEntryId !== undefined)
    throw new Error('Choose one queue insertion anchor')
}

export function validateLibraryPlaylistLookup(
  value: unknown
): asserts value is LibraryPlaylistLookupRequest {
  if (
    !record(value) ||
    !Array.isArray(value.entries) ||
    value.entries.length > LIBRARY_PAGE_SIZE ||
    !Array.isArray(value.versions) ||
    value.versions.length > 20000 ||
    (value.resolution !== undefined && value.resolution !== 'recent') ||
    (value.preserveSources !== undefined && typeof value.preserveSources !== 'boolean')
  )
    throw new Error('Invalid or oversized playlist lookup')
  validateLibraryIds(value.entries.map((entry) => (record(entry) ? entry.id : undefined)))
  for (const entry of value.entries) {
    if (
      entry.sourceIds !== undefined &&
      (!Array.isArray(entry.sourceIds) ||
        entry.sourceIds.some((id) => typeof id !== 'string' || !id || id.length > 32768))
    )
      throw new Error('Invalid recent recording sources')
    if (entry.snapshot === undefined) continue
    const snapshot = entry.snapshot
    if (
      !record(snapshot) ||
      ['id', 'title', 'artist'].some(
        (field) => typeof snapshot[field] !== 'string' || snapshot[field].length > 32768
      ) ||
      !snapshot.id ||
      ['album', 'source', 'filePath', 'format'].some(
        (field) =>
          snapshot[field] !== undefined &&
          (typeof snapshot[field] !== 'string' || snapshot[field].length > 32768)
      ) ||
      ['duration', 'bitDepth'].some(
        (field) =>
          snapshot[field] !== undefined &&
          (typeof snapshot[field] !== 'number' || !Number.isFinite(snapshot[field]))
      )
    )
      throw new Error('Invalid playlist recording identity')
  }
  const ids = new Set<string>(),
    sources = new Set<string>()
  for (const version of value.versions) {
    if (
      !record(version) ||
      typeof version.id !== 'string' ||
      !version.id ||
      version.id.length > 8192 ||
      ids.has(version.id) ||
      !Array.isArray(version.sources) ||
      !version.sources.length ||
      version.sources.some(
        (source) =>
          typeof source !== 'string' || !source || source.length > 8192 || sources.has(source)
      ) ||
      (version.preferredSource !== null && !version.sources.includes(version.preferredSource))
    )
      throw new Error('Invalid playlist recording version')
    ids.add(version.id)
    for (const source of version.sources) {
      if (sources.has(source)) throw new Error('Duplicate playlist recording source')
      sources.add(source)
    }
  }
  if (
    [value.entries, value.versions].some(
      (part) =>
        Buffer.byteLength(stringifyJsonWithNestingLimit(part, 'playlist recording lookup')) >
        8 * 1024 * 1024
    )
  )
    throw new Error('Playlist lookup exceeds 8 MiB')
}

export function validateLibraryPlaylistViewSync(
  value: unknown
): asserts value is LibraryPlaylistViewSync {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    !value.id ||
    value.id.length > 128 ||
    value.id.includes('\0')
  )
    throw new Error('Invalid playlist view identity')
  if (value.kind === 'drop') return
  if (value.kind === 'begin') {
    validateLibraryPlaylistLookup({
      entries: [],
      versions: value.versions,
      preserveSources: value.preserveSources
    })
    if (value.catalog !== undefined && typeof value.catalog !== 'boolean')
      throw new Error('Invalid playlist catalog mode')
    return
  }
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1)
    throw new Error('Invalid playlist view sequence')
  if (value.kind === 'commit') return
  if (value.kind === 'groups') {
    if (
      !Array.isArray(value.groups) ||
      value.groups.length > LIBRARY_PAGE_SIZE ||
      value.groups.some(
        (group) =>
          !record(group) ||
          typeof group.id !== 'string' ||
          !group.id ||
          group.id.length > 32768 ||
          typeof group.name !== 'string' ||
          group.name.length > 32768 ||
          (group.cover !== undefined && group.cover !== null && typeof group.cover !== 'string') ||
          (group.isDefault !== undefined && typeof group.isDefault !== 'boolean')
      ) ||
      Buffer.byteLength(stringifyJsonWithNestingLimit(value.groups, 'playlist catalog groups')) >
        20 * 1024 * 1024
    )
      throw new Error('Invalid or oversized playlist catalog groups')
    return
  }
  if (value.kind !== 'append') throw new Error('Unknown playlist view operation')
  validateLibraryPlaylistLookup({ entries: value.entries, versions: [] })
  for (const entry of value.entries as Extract<
    LibraryPlaylistViewSync,
    { kind: 'append' }
  >['entries']) {
    if (
      entry.collectionId !== undefined &&
      (typeof entry.collectionId !== 'string' ||
        !entry.collectionId ||
        entry.collectionId.length > 32768)
    )
      throw new Error('Invalid playlist collection identity')
    if (
      entry.snapshot &&
      (typeof entry.snapshot.filePath !== 'string' || entry.snapshot.filePath.includes('\0'))
    )
      throw new Error('Invalid playlist snapshot path')
  }
}
