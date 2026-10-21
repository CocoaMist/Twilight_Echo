import { existsSync, statSync, unlinkSync } from 'fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'path'
import type {
  LocalLibraryMutationFailure,
  LocalLibraryRemoveResult,
  LocalLibraryRemovalMode,
  LocalLibraryTrackSelection,
  LocalMusicLibraryDocument
} from '../../shared/localLibrary.ts'
import {
  applySuccessfulLibraryRemoval,
  loadMusicLibraryDocument,
  MAX_MUSIC_LIBRARY_BYTES,
  normalizeLibraryFilePath,
  persistMusicLibraryDocument
} from './libraryRepository.ts'
import {
  clearJsonFileArtifacts,
  loadJsonFileWithBackup,
  writeJsonFileAtomic,
  type JsonFileOptions
} from '../persistence/jsonFile.ts'
import type { LibraryDatabaseWorkerApi, LibraryRemovalResult } from './libraryDatabaseProtocol.ts'

const LOCAL_LIBRARY_REMOVAL_JOURNAL_VERSION = 1 as const

interface LocalLibraryRemovalJournalDocument {
  version: typeof LOCAL_LIBRARY_REMOVAL_JOURNAL_VERSION
  expectedRevision: number
  targetRevision: number
  createdAt: string
  items: LocalLibraryTrackSelection[]
  succeededFilePaths: string[]
  inFlightFilePath: string | null
  databaseRecovery?: {
    id: string
    items: LocalLibraryTrackSelection[]
    cursor: number
    removedTrackIds: string[]
    removedFilePaths: string[]
    failures: LocalLibraryMutationFailure[]
  }
}

export interface LocalLibraryRemovalJournal {
  begin: (
    document: LocalMusicLibraryDocument,
    items: LocalLibraryTrackSelection[]
  ) => Promise<void> | void
  markAttempting: (item: LocalLibraryTrackSelection) => Promise<void> | void
  markSucceeded: (item: LocalLibraryTrackSelection) => Promise<void> | void
  markFailed: (item: LocalLibraryTrackSelection) => Promise<void> | void
  clear: () => Promise<void> | void
}

interface CommitLocalLibraryRemovalOptions {
  document: LocalMusicLibraryDocument
  items: LocalLibraryTrackSelection[]
  mode: LocalLibraryRemovalMode
  trashItem: (filePath: string) => Promise<void>
  persist: (document: LocalMusicLibraryDocument) => Promise<void> | void
  journal?: LocalLibraryRemovalJournal
}

export async function commitLocalLibraryRemoval({
  document,
  items,
  mode,
  trashItem,
  persist,
  journal
}: CommitLocalLibraryRemovalOptions): Promise<LocalLibraryRemoveResult> {
  const availablePaths = collectDocumentTrackPaths(document)
  const uniqueItems = new Map<string, LocalLibraryTrackSelection>()
  const failures: LocalLibraryMutationFailure[] = []

  for (const item of items) {
    const key = normalizeLibraryFilePath(item.filePath)
    if (!availablePaths.has(key)) {
      failures.push({ filePath: item.filePath, message: '曲目已不在本地音乐库中' })
      continue
    }
    if (!uniqueItems.has(key)) uniqueItems.set(key, item)
  }

  const trashJournal = mode === 'trash' ? journal : undefined
  if (trashJournal && uniqueItems.size > 0) {
    await trashJournal.begin(document, Array.from(uniqueItems.values()))
  }

  const successfulItems: LocalLibraryTrackSelection[] = []
  for (const item of uniqueItems.values()) {
    if (mode === 'library') {
      successfulItems.push(item)
      continue
    }
    if (trashJournal) await trashJournal.markAttempting(item)
    try {
      await trashItem(item.filePath)
    } catch (error) {
      if (trashJournal) await trashJournal.markFailed(item)
      failures.push({
        filePath: item.filePath,
        message: error instanceof Error ? error.message : String(error)
      })
      continue
    }
    successfulItems.push(item)
    if (trashJournal) await trashJournal.markSucceeded(item)
  }

  const mutation = applySuccessfulLibraryRemoval(document, successfulItems, mode === 'library')
  if (mutation.removedFilePaths.length > 0) {
    await persist(mutation.document)
  }
  if (trashJournal) await trashJournal.clear()

  return {
    mode,
    library: mutation.document,
    removedTrackIds: mutation.removedTrackIds,
    removedFilePaths: mutation.removedFilePaths,
    failures
  }
}

export function getLocalLibraryRemovalJournalPath(libraryFilePath: string): string {
  return join(dirname(libraryFilePath), 'music-library-removal-journal.json')
}

export function createLocalLibraryRemovalJournal(
  libraryFilePath: string
): LocalLibraryRemovalJournal {
  const journalFilePath = getLocalLibraryRemovalJournalPath(libraryFilePath)
  let current: LocalLibraryRemovalJournalDocument | null = null

  const persistCurrent = (): void => {
    if (!current) throw new Error('Local library removal journal was not initialized')
    writeJsonFileAtomic(
      journalFilePath,
      JSON.stringify(current),
      LOCAL_LIBRARY_REMOVAL_JOURNAL_OPTIONS,
      current
    )
  }

  return {
    begin(document, items) {
      current = {
        version: LOCAL_LIBRARY_REMOVAL_JOURNAL_VERSION,
        expectedRevision: document.revision,
        targetRevision: document.revision + 1,
        createdAt: new Date().toISOString(),
        items,
        succeededFilePaths: [],
        inFlightFilePath: null
      }
      persistCurrent()
    },
    markAttempting(item) {
      if (!current) throw new Error('Local library removal journal was not initialized')
      current = { ...current, inFlightFilePath: item.filePath }
      persistCurrent()
    },
    markSucceeded(item) {
      if (!current) throw new Error('Local library removal journal was not initialized')
      const succeeded = new Map(
        current.succeededFilePaths.map((filePath) => [normalizeLibraryFilePath(filePath), filePath])
      )
      succeeded.set(normalizeLibraryFilePath(item.filePath), item.filePath)
      current = {
        ...current,
        succeededFilePaths: Array.from(succeeded.values()),
        inFlightFilePath: null
      }
      persistCurrent()
    },
    markFailed() {
      if (!current) throw new Error('Local library removal journal was not initialized')
      current = { ...current, inFlightFilePath: null }
      persistCurrent()
    },
    clear() {
      clearJsonFileArtifacts(journalFilePath)
      current = null
    }
  }
}

export function recoverLocalLibraryRemoval(
  libraryFilePath: string,
  options: {
    persistDocument?: typeof persistMusicLibraryDocument
  } = {}
): {
  recovered: boolean
  removedTrackIds: string[]
  removedFilePaths: string[]
} {
  const journalFilePath = getLocalLibraryRemovalJournalPath(libraryFilePath)
  const loadedJournal = loadJsonFileWithBackup(
    journalFilePath,
    LOCAL_LIBRARY_REMOVAL_JOURNAL_OPTIONS
  )
  if (loadedJournal.status === 'missing') {
    return { recovered: false, removedTrackIds: [], removedFilePaths: [] }
  }

  const journal = loadedJournal.value
  if (
    journal.databaseRecovery ||
    existsSync(join(dirname(libraryFilePath), 'music-library.sqlite'))
  )
    throw new Error('此删除日志需要 SQLite 曲库恢复，未写入旧 JSON')
  const recoverablePaths = new Set(journal.succeededFilePaths.map(normalizeLibraryFilePath))
  if (journal.inFlightFilePath && !existsSync(journal.inFlightFilePath)) {
    recoverablePaths.add(normalizeLibraryFilePath(journal.inFlightFilePath))
  }
  const recoverableItems = journal.items.filter((item) =>
    recoverablePaths.has(normalizeLibraryFilePath(item.filePath))
  )
  const loadedLibrary = loadMusicLibraryDocument(libraryFilePath)
  const mutation = applySuccessfulLibraryRemoval(loadedLibrary.document, recoverableItems, false)
  if (mutation.removedFilePaths.length > 0) {
    mutation.document.revision = Math.max(
      loadedLibrary.document.revision + 1,
      journal.targetRevision
    )
    const persistDocument = options.persistDocument ?? persistMusicLibraryDocument
    persistDocument(libraryFilePath, mutation.document)
  }
  clearJsonFileArtifacts(journalFilePath)
  return {
    recovered: recoverableItems.length > 0,
    removedTrackIds: mutation.removedTrackIds,
    removedFilePaths: mutation.removedFilePaths
  }
}

/** Redirect an old JSON removal redo log into the current database authority.
 * Persist a bounded cursor before each request so losing a worker reply never
 * replays a completed deletion against newly restored songs at the same path. */
export async function recoverLocalLibraryRemovalFromDatabase(
  libraryFilePath: string,
  database: Pick<LibraryDatabaseWorkerApi, 'recoverRemovalJournal' | 'getMetadata'>
): Promise<LibraryRemovalResult | null> {
  const path = getLocalLibraryRemovalJournalPath(libraryFilePath)
  const loaded = loadJsonFileWithBackup(path, LOCAL_LIBRARY_REMOVAL_JOURNAL_OPTIONS)
  if (loaded.status === 'missing') return null
  const journal = loaded.value
  const persist = () =>
    writeJsonFileAtomic(
      path,
      JSON.stringify(journal),
      LOCAL_LIBRARY_REMOVAL_JOURNAL_OPTIONS,
      journal
    )
  if (!journal.databaseRecovery) {
    const recoverablePaths = new Set(journal.succeededFilePaths.map(normalizeLibraryFilePath))
    if (journal.inFlightFilePath) {
      try {
        statSync(journal.inFlightFilePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (!statSync(dirname(journal.inFlightFilePath)).isDirectory())
          throw new Error('回收站目录不可访问')
        recoverablePaths.add(normalizeLibraryFilePath(journal.inFlightFilePath))
      }
    }
    journal.databaseRecovery = {
      id: randomUUID(),
      cursor: 0,
      items: [
        ...new Map(
          journal.items
            .filter((item) => recoverablePaths.has(normalizeLibraryFilePath(item.filePath)))
            .map((item) => [normalizeLibraryFilePath(item.filePath), item])
        ).values()
      ],
      removedTrackIds: [],
      removedFilePaths: [],
      failures: []
    }
    persist()
  }
  const checkpoint = journal.databaseRecovery
  let result: LibraryRemovalResult | null = null
  // An empty log needs no database call and cannot accidentally touch the JSON library.
  while (checkpoint.cursor < checkpoint.items.length) {
    const batch = checkpoint.items.slice(checkpoint.cursor, checkpoint.cursor + 256)
    result = await database.recoverRemovalJournal(`${checkpoint.id}-${checkpoint.cursor}`, batch)
    checkpoint.removedTrackIds.push(...result.removedTrackIds)
    checkpoint.removedFilePaths.push(...result.removedFilePaths)
    checkpoint.failures.push(...result.failures)
    checkpoint.cursor += batch.length
    persist()
  }
  // If every batch was already acknowledged before a crash, its durable cursor
  // proves that only journal cleanup remains; do not issue a fresh deletion.
  const recovered = checkpoint.items.length
    ? {
        id: checkpoint.id,
        mode: 'trash' as const,
        metadata: result?.metadata ?? (await database.getMetadata()),
        removedTrackIds: checkpoint.removedTrackIds,
        removedFilePaths: checkpoint.removedFilePaths,
        failures: checkpoint.failures
      }
    : null
  // Delete the fallback before the primary log; never swallow a real cleanup
  // error and leave an old cursor to be replayed after normal startup.
  for (const suffix of ['.bak', '']) {
    try {
      unlinkSync(path + suffix)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return recovered
}

export function recoverLocalLibraryRemovalResult(
  libraryFilePath: string,
  originalDocument: LocalMusicLibraryDocument,
  items: LocalLibraryTrackSelection[]
): LocalLibraryRemoveResult | null {
  const recovery = recoverLocalLibraryRemoval(libraryFilePath)
  if (!recovery.recovered) return null

  const authoritative = loadMusicLibraryDocument(libraryFilePath).document
  const authoritativePaths = collectDocumentTrackPaths(authoritative)
  const removedItems = items.filter(
    (item) => !authoritativePaths.has(normalizeLibraryFilePath(item.filePath))
  )
  const mutation = applySuccessfulLibraryRemoval(originalDocument, removedItems, false)
  const removedPaths = new Set(mutation.removedFilePaths.map(normalizeLibraryFilePath))
  return {
    mode: 'trash',
    library: authoritative,
    removedTrackIds: mutation.removedTrackIds,
    removedFilePaths: mutation.removedFilePaths,
    failures: items
      .filter((item) => !removedPaths.has(normalizeLibraryFilePath(item.filePath)))
      .map((item) => ({
        filePath: item.filePath,
        message: '回收站操作未完成'
      }))
  }
}

const LOCAL_LIBRARY_REMOVAL_JOURNAL_OPTIONS: JsonFileOptions<LocalLibraryRemovalJournalDocument> = {
  label: 'music library removal journal',
  maxBytes: MAX_MUSIC_LIBRARY_BYTES,
  validate: isLocalLibraryRemovalJournalDocument
}

function isLocalLibraryRemovalJournalDocument(
  value: unknown
): value is LocalLibraryRemovalJournalDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.version === LOCAL_LIBRARY_REMOVAL_JOURNAL_VERSION &&
    isNonNegativeSafeInteger(record.expectedRevision) &&
    isNonNegativeSafeInteger(record.targetRevision) &&
    typeof record.createdAt === 'string' &&
    Array.isArray(record.items) &&
    record.items.every(isLocalLibraryTrackSelection) &&
    Array.isArray(record.succeededFilePaths) &&
    record.succeededFilePaths.every((filePath) => typeof filePath === 'string' && !!filePath) &&
    (record.inFlightFilePath === null || typeof record.inFlightFilePath === 'string') &&
    (record.databaseRecovery === undefined || isDatabaseRemovalRecovery(record.databaseRecovery))
  )
}

function isDatabaseRemovalRecovery(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    /^[a-zA-Z0-9-]{1,96}$/.test(record.id) &&
    Array.isArray(record.items) &&
    record.items.every(isLocalLibraryTrackSelection) &&
    isNonNegativeSafeInteger(record.cursor) &&
    Number(record.cursor) <= record.items.length &&
    Array.isArray(record.removedTrackIds) &&
    record.removedTrackIds.every((id) => typeof id === 'string') &&
    Array.isArray(record.removedFilePaths) &&
    record.removedFilePaths.every((path) => typeof path === 'string') &&
    Array.isArray(record.failures) &&
    record.failures.every(
      (failure) =>
        !!failure &&
        typeof failure === 'object' &&
        typeof failure.filePath === 'string' &&
        typeof failure.message === 'string'
    )
  )
}

function isLocalLibraryTrackSelection(value: unknown): value is LocalLibraryTrackSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.filePath === 'string' &&
    !!record.filePath &&
    typeof record.title === 'string' &&
    typeof record.artist === 'string'
  )
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function collectDocumentTrackPaths(document: LocalMusicLibraryDocument): Set<string> {
  const paths = new Set<string>()
  for (const track of document.tracks) {
    if (!track || typeof track !== 'object' || Array.isArray(track)) continue
    const filePath = (track as Record<string, unknown>).filePath
    if (typeof filePath === 'string' && filePath) {
      paths.add(normalizeLibraryFilePath(filePath))
    }
  }
  return paths
}
