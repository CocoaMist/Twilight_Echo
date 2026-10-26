import { loadMusicLibraryDocument } from '../library/libraryRepository.ts'
import { createPersonalBackupRepository } from '../../core/persistence/personalBackup.ts'
export { checkRestoreOptions } from '../../core/persistence/personalBackup.ts'
export type { PersonalLibraryDatabase } from '../../shared/coreBackup.ts'
const repository = createPersonalBackupRepository((path) => loadMusicLibraryDocument(path).document)
export const {
  parsePersonalBackup,
  readPersonalData,
  createPersonalBackup,
  stagePersonalRestore,
  buildRestoreData,
  previewRestore,
  applyPendingPersonalRestore,
  createPersonalBackupFromDatabase,
  createPersonalBackupV1FromDatabase,
  previewRestoreFromDatabase,
  stagePersonalRestoreFromDatabase,
  applyPendingPersonalRestoreFromDatabase,
  readRendererRestore,
  acknowledgeRendererRestore,
  deferStalePersonalRestore,
  personalRestoreNeedsReview,
  readPersonalRestoreReview,
  acknowledgePersonalRestoreReview,
  readBackupFile,
  writePersonalBackupFile
} = repository
