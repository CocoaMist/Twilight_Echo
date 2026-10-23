import type {
  LocalLibraryTagOperationResult,
  LocalLibraryTagRestoreRequest,
  LocalLibraryTagRestoreResult,
  LocalLibraryTagWriteItem,
  LocalLibraryTagWriteRequest,
  LocalLibraryTagWriteResult
} from '../../shared/localLibraryTags.ts'
import {
  getTagWriteJournalRecoveryEntries,
  restoreTagsFromBackup,
  TagWriteBatchError,
  writeTagsBatchWithRollback,
  type TagWriteInput,
  type TagWriteJournalEntry
} from './tagWriteService.ts'

const MAX_TAG_MUTATION_ITEMS = 1_000
const MAX_TAG_TEXT_LENGTH = 1_024
const MAX_COVER_BYTES = 8 * 1024 * 1024
const MAX_COVER_DIMENSION = 4_096
const MAX_COVER_PIXELS = 16_777_216

export interface TagWriteIpcHandlers {
  write(event: unknown, request: unknown): Promise<LocalLibraryTagWriteResult>
  restore(event: unknown, request: unknown): Promise<LocalLibraryTagRestoreResult>
}

export interface TagWriteIpcDependencies {
  backupRoot: string
  assertTrustedSender(event: unknown): void
  authorizeAudioFile(filePath: string): Promise<string>
  redactError(error: unknown): string
  writeBatch?(inputs: readonly TagWriteInput[], backupRoot: string): TagWriteJournalEntry[]
  restoreFromBackup?(filePath: string, backupRoot: string): void
  readRecoveryEntries?(backupRoot: string): Array<{ filePath: string }>
}

export function createTagWriteIpcHandlers(
  dependencies: TagWriteIpcDependencies
): TagWriteIpcHandlers {
  const writeBatch = dependencies.writeBatch ?? writeTagsBatchWithRollback
  const restoreFromBackup = dependencies.restoreFromBackup ?? restoreTagsFromBackup
  const readRecoveryEntries = dependencies.readRecoveryEntries ?? getTagWriteJournalRecoveryEntries

  return {
    async write(event, rawRequest) {
      dependencies.assertTrustedSender(event)
      const request = normalizeWriteRequest(rawRequest)
      const authorization = await authorizeItems(request.items, dependencies)
      if (authorization.failures.size > 0) {
        return {
          items: request.items.map((item, index) =>
            authorization.failures.has(index)
              ? failed(item.filePath, authorization.failures.get(index)!)
              : notAttempted(
                  item.filePath,
                  'Batch not started because another path was unauthorized'
                )
          )
        }
      }

      try {
        const journalEntries = writeBatch(authorization.items, dependencies.backupRoot)
        return { items: journalEntries.map((entry) => success(entry.filePath)) }
      } catch (error) {
        if (error instanceof TagWriteBatchError) {
          return {
            items: error.journal.entries.map((entry) => toWriteOperationResult(entry, dependencies))
          }
        }
        return {
          items: authorization.items.map((item) =>
            notAttempted(
              item.filePath,
              `Batch journal could not be initialized: ${dependencies.redactError(error)}`
            )
          )
        }
      }
    },

    async restore(event, rawRequest) {
      dependencies.assertTrustedSender(event)
      const request = normalizeRestoreRequest(rawRequest)
      let filePaths: string[]
      try {
        filePaths = request.fromJournal
          ? readRecoveryEntries(dependencies.backupRoot).map((entry) => entry.filePath)
          : (request.filePaths ?? [])
      } catch (error) {
        return {
          items: [
            failed('', `Could not read tag recovery journal: ${dependencies.redactError(error)}`)
          ]
        }
      }
      const authorization = await authorizeFilePaths(filePaths, dependencies)
      if (authorization.failures.size > 0) {
        return {
          items: filePaths.map((filePath, index) =>
            authorization.failures.has(index)
              ? failed(filePath, authorization.failures.get(index)!)
              : notAttempted(filePath, 'Restore not started because another path was unauthorized')
          )
        }
      }

      return {
        items: authorization.filePaths.map((filePath) => {
          try {
            restoreFromBackup(filePath, dependencies.backupRoot)
            return success(filePath)
          } catch (error) {
            return failed(filePath, dependencies.redactError(error))
          }
        })
      }
    }
  }
}

async function authorizeItems(
  items: readonly LocalLibraryTagWriteItem[],
  dependencies: TagWriteIpcDependencies
): Promise<{ items: TagWriteInput[]; failures: Map<number, string> }> {
  const authorization = await authorizeFilePaths(
    items.map((item) => item.filePath),
    dependencies
  )
  return {
    items: items.map((item, index) => ({ ...item, filePath: authorization.filePaths[index] })),
    failures: authorization.failures
  }
}

async function authorizeFilePaths(
  filePaths: readonly string[],
  dependencies: TagWriteIpcDependencies
): Promise<{ filePaths: string[]; failures: Map<number, string> }> {
  const authorized: string[] = []
  const failures = new Map<number, string>()
  for (const [index, filePath] of filePaths.entries()) {
    try {
      authorized[index] = await dependencies.authorizeAudioFile(filePath)
    } catch (error) {
      failures.set(index, dependencies.redactError(error))
      authorized[index] = filePath
    }
  }
  return { filePaths: authorized, failures }
}

function normalizeWriteRequest(value: unknown): LocalLibraryTagWriteRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tag write request must be an object')
  }
  const items = (value as Record<string, unknown>).items
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_TAG_MUTATION_ITEMS) {
    throw new Error(`Tag write request must include 1-${MAX_TAG_MUTATION_ITEMS} items`)
  }
  return { items: items.map(normalizeWriteItem) }
}

function normalizeWriteItem(value: unknown): LocalLibraryTagWriteItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tag write item must be an object')
  }
  const record = value as Record<string, unknown>
  const patch = normalizeTagPatch(record)
  if (Object.keys(patch).length === 0) {
    throw new Error('Tag write item must include at least one tag field')
  }
  return { filePath: normalizeFilePath(record.filePath), ...patch }
}

function normalizeRestoreRequest(value: unknown): LocalLibraryTagRestoreRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tag restore request must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.fromJournal === true) {
    if (record.filePaths !== undefined) {
      throw new Error('Journal restore must not include file paths')
    }
    return { fromJournal: true }
  }
  if (
    !Array.isArray(record.filePaths) ||
    record.filePaths.length === 0 ||
    record.filePaths.length > MAX_TAG_MUTATION_ITEMS
  ) {
    throw new Error(`Tag restore request must include 1-${MAX_TAG_MUTATION_ITEMS} file paths`)
  }
  return { filePaths: record.filePaths.map(normalizeFilePath) }
}

function normalizeTagPatch(record: Record<string, unknown>): Omit<TagWriteInput, 'filePath'> {
  const title = optionalText(record.title, 'title')
  const artist = optionalText(record.artist, 'artist')
  const album = optionalText(record.album, 'album')
  const albumArtist = optionalText(record.albumArtist, 'album artist')
  const track = optionalPositiveInteger(record.track, 'track')
  const disc = optionalPositiveInteger(record.disc, 'disc')
  const year = optionalPositiveInteger(record.year, 'year')
  const genre = optionalText(record.genre, 'genre')
  const cover = record.coverData === undefined ? undefined : normalizeCoverData(record.coverData)
  return {
    ...(title !== undefined ? { title } : {}),
    ...(artist !== undefined ? { artist } : {}),
    ...(album !== undefined ? { album } : {}),
    ...(albumArtist !== undefined ? { albumArtist } : {}),
    ...(track !== undefined ? { track } : {}),
    ...(disc !== undefined ? { disc } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(genre !== undefined ? { genre } : {}),
    ...(cover ? { coverData: cover.data, coverMimeType: cover.mimeType } : {})
  }
}

function normalizeFilePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096) {
    throw new Error('Tag audio file path is invalid')
  }
  return value
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > MAX_TAG_TEXT_LENGTH) {
    throw new Error(`Tag ${field} is invalid`)
  }
  return value
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 9_999) {
    throw new Error(`Tag ${field} is invalid`)
  }
  return value as number
}

function normalizeCoverData(value: unknown): {
  data: Uint8Array
  mimeType: 'image/jpeg' | 'image/png'
} {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > MAX_COVER_BYTES
  ) {
    throw new Error('Tag cover data is invalid')
  }
  const dimensions = parsePngDimensions(value) ?? parseJpegDimensions(value)
  if (!dimensions) throw new Error('Only PNG and JPEG tag covers are supported')
  if (
    dimensions.width > MAX_COVER_DIMENSION ||
    dimensions.height > MAX_COVER_DIMENSION ||
    dimensions.width * dimensions.height > MAX_COVER_PIXELS
  ) {
    throw new Error('Tag cover dimensions exceed the allowed limit')
  }
  return { data: value, mimeType: dimensions.mimeType }
}

function parsePngDimensions(
  data: Uint8Array
): { width: number; height: number; mimeType: 'image/png' } | null {
  if (
    data.byteLength < 24 ||
    data[0] !== 0x89 ||
    data[1] !== 0x50 ||
    data[2] !== 0x4e ||
    data[3] !== 0x47 ||
    data[4] !== 0x0d ||
    data[5] !== 0x0a ||
    data[6] !== 0x1a ||
    data[7] !== 0x0a ||
    data[12] !== 0x49 ||
    data[13] !== 0x48 ||
    data[14] !== 0x44 ||
    data[15] !== 0x52
  ) {
    return null
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height, mimeType: 'image/png' } : null
}

function parseJpegDimensions(
  data: Uint8Array
): { width: number; height: number; mimeType: 'image/jpeg' } | null {
  if (data.byteLength < 11 || data[0] !== 0xff || data[1] !== 0xd8) return null
  let offset = 2
  while (offset < data.byteLength) {
    while (offset < data.byteLength && data[offset] === 0xff) offset++
    if (offset >= data.byteLength) return null
    const marker = data[offset++]
    if (marker === 0xd9 || marker === 0xda) return null
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > data.byteLength) return null
    const length = (data[offset] << 8) | data[offset + 1]
    if (length < 7 || offset + length > data.byteLength) return null
    if (isJpegStartOfFrame(marker)) {
      const height = (data[offset + 3] << 8) | data[offset + 4]
      const width = (data[offset + 5] << 8) | data[offset + 6]
      return width > 0 && height > 0 ? { width, height, mimeType: 'image/jpeg' } : null
    }
    offset += length
  }
  return null
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  )
}

function toWriteOperationResult(
  entry: TagWriteJournalEntry,
  dependencies: TagWriteIpcDependencies
): LocalLibraryTagOperationResult {
  switch (entry.status) {
    case 'written':
      return success(entry.filePath)
    case 'rolledBack':
      return {
        filePath: entry.filePath,
        status: 'rolledBack',
        ...(entry.error ? { message: dependencies.redactError(entry.error) } : {})
      }
    case 'pending':
      return notAttempted(entry.filePath, 'Write was not attempted')
    case 'backedUp':
      return failed(entry.filePath, 'Backup exists and requires journal recovery')
    case 'failed':
      return failed(entry.filePath, dependencies.redactError(entry.error ?? 'Tag write failed'))
  }
}

function success(filePath: string): LocalLibraryTagOperationResult {
  return { filePath, status: 'success' }
}

function failed(filePath: string, message: string): LocalLibraryTagOperationResult {
  return { filePath, status: 'failed', message }
}

function notAttempted(filePath: string, message: string): LocalLibraryTagOperationResult {
  return { filePath, status: 'notAttempted', message }
}
