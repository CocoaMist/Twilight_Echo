import type { LibraryMetadata } from './libraryDatabase.ts'
import type { LibrarySelectionPage } from './librarySelection.ts'
import type {
  LocalLibraryRemovalMode,
  LocalLibraryTrackSelection,
  LocalLibraryMutationFailure
} from './localLibrary.ts'
import type { LocalLibraryTagPatch, LocalLibraryTagOperationStatus } from './localLibraryTags.ts'
import type { CoreTrackView } from './coreViews.ts'

/** Private SQL journal contracts. Filesystem capabilities remain outside SQL. */
export interface LibraryRemovalItem {
  selection: LocalLibraryTrackSelection
  state: 'pending' | 'working' | 'succeeded' | 'failed'
  identity?: { size: string; mtimeNs: string; device: string; inode: string }
  removedTrackIds: string[]
  error?: string
}
export interface LibraryRemovalOperation {
  id: string
  mode: LocalLibraryRemovalMode
  items: LibraryRemovalItem[]
}
export interface LibraryRemovalResult {
  id: string
  mode: LocalLibraryRemovalMode
  metadata: LibraryMetadata
  removedTrackIds: string[]
  removedFilePaths: string[]
  failures: LocalLibraryMutationFailure[]
}
export interface CoreRemovalDatabase {
  beginRemoval(
    id: string,
    mode: LocalLibraryRemovalMode,
    items: LocalLibraryTrackSelection[]
  ): Promise<LibraryRemovalOperation>
  markRemovalAttempting(id: string, filePath: string): Promise<LibraryRemovalOperation>
  settleRemovalItem(
    id: string,
    filePath: string,
    succeeded: boolean,
    error?: string
  ): Promise<LibraryRemovalOperation>
  finishRemoval(id: string): Promise<LibraryRemovalResult>
  recoverRemoval(): Promise<LibraryRemovalResult | null>
}

export type CoreLibrarySelectionPage = Omit<LibrarySelectionPage, 'rows'> & {
  rows: Array<Omit<LibrarySelectionPage['rows'][number], 'track'> & { track: CoreTrackView }>
}
export type CoreTagPatch = Omit<LocalLibraryTagPatch, 'coverData'> & { coverBase64?: string }
export interface CoreTagWrite {
  selectionId: string
  /** Common batch edits, or per-track overrides, resolve to distinct selected physical files. */
  patch?: CoreTagPatch
  items?: Array<{ id: string; patch: CoreTagPatch }>
}
export interface CoreFileOperationResult {
  id: string | null
  name: string
  status: LocalLibraryTagOperationStatus
  message?: string
}
export interface CoreTagResult {
  items: CoreFileOperationResult[]
}
export interface CoreLibraryRemovalResult {
  revision: number
  removedTrackIds: string[]
  removedFileCount: number
  failures: Array<{ id: string; message: string }>
}

/** Private analysis-worker request. Source paths originate in Core repositories. */
export type LibraryTagWorkerRequest =
  | { kind: 'inspect' }
  | { kind: 'recover' }
  | { kind: 'write'; items: Array<CoreTagPatch & { filePath: string }> }
  | { kind: 'restore'; filePaths: string[] }
export interface LibraryTagJournalStatus {
  interrupted: boolean
  filePaths: string[]
}
