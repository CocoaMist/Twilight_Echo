import type {
  LibraryTagJournalStatus,
  LibraryTagWorkerRequest
} from '../../shared/coreLibraryMaintenance.ts'
import type {
  LocalLibraryTagRestoreResult,
  LocalLibraryTagWriteResult
} from '../../shared/localLibraryTags.ts'
import { createTagWriteIpcHandlers } from './tagOperations.ts'
import { readTagWriteJournal, recoverInterruptedTagWrites } from './tagWriteService.ts'
import { projectCoreError } from '../projections.ts'

/** Executed in an existing analysis utility worker: taglib/copy/journal IO never
 * blocks the Core event loop. Core authorizes and releases all files first. */
export async function runLibraryTagWorker(
  backupRoot: string,
  request: LibraryTagWorkerRequest
): Promise<
  LibraryTagJournalStatus | LocalLibraryTagWriteResult | LocalLibraryTagRestoreResult | void
> {
  if (request.kind === 'inspect') {
    const journal = readTagWriteJournal(backupRoot)
    return {
      interrupted: journal.state === 'writing',
      filePaths: journal.entries
        .filter(
          (entry) =>
            entry.status === 'backedUp' ||
            entry.status === 'written' ||
            (entry.status === 'failed' && entry.error?.startsWith('Rollback failed:'))
        )
        .map((entry) => entry.filePath)
    }
  }
  if (request.kind === 'recover') return recoverInterruptedTagWrites(backupRoot)
  const handlers = createTagWriteIpcHandlers({
    backupRoot,
    assertTrustedSender: () => {},
    authorizeAudioFile: async (path) => path,
    redactError: projectCoreError
  })
  return request.kind === 'restore'
    ? handlers.restore(null, { filePaths: request.filePaths })
    : handlers.write(null, {
        items: request.items.map(({ coverBase64, ...item }) => ({
          ...item,
          ...(coverBase64 !== undefined
            ? { coverData: new Uint8Array(Buffer.from(coverBase64, 'base64')) }
            : {})
        }))
      })
}
