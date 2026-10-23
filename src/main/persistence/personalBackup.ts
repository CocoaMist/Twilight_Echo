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
  previewRestoreFromDatabase,
  stagePersonalRestoreFromDatabase,
  applyPendingPersonalRestoreFromDatabase,
  readRendererRestore,
  acknowledgeRendererRestore,
  readBackupFile,
  writePersonalBackupFile
} = repository
