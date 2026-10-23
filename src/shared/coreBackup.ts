import type { LocalMusicLibraryDocument } from './localLibrary.ts'
import type { LibraryMetadata } from './libraryDatabase.ts'
import type { LibraryPlaybackQueueReference } from './playbackSession.ts'
import type { PersonalBackupPreview, PersonalRestoreOptions } from './personalBackup.ts'

export interface PersonalLibraryDatabase {
  exportDocument(options?: {
    maxBytes?: number
    redactPrivateData?: boolean
  }): Promise<LocalMusicLibraryDocument>
  restoreDocument(
    document: LocalMusicLibraryDocument,
    restoreId: string,
    expectedRevision: number
  ): Promise<LibraryMetadata>
  restorePersonalLibrary(
    document: LocalMusicLibraryDocument,
    conflict: 'keep-local' | 'use-backup',
    restoreId: string,
    expectedRevision: number
  ): Promise<LibraryMetadata>
  previewPersonalLibrary(
    document: LocalMusicLibraryDocument
  ): Promise<{ incoming: number; current: number; conflicts: number; revision: number }>
  getMetadata(): Promise<LibraryMetadata>
  exportPlaybackQueue(
    reference: LibraryPlaybackQueueReference,
    maxBytes: number
  ): Promise<{ queue: Record<string, unknown>[]; queueIndex: number; libraryRevision: number }>
}
export interface CorePersonalBackupPreview extends PersonalBackupPreview {
  id: string
}
export interface CorePersonalRestore {
  id: string
  options: PersonalRestoreOptions
}
/** Private database service operations. The journal belongs to this profile. */
export interface CorePersonalRestoreApi {
  corePersonalRestore(): Promise<{ id: string | null; applied: boolean }>
}
