import { runtime } from '../core/runtime'
import {
  isActiveLibraryPathExcluded,
  isLibraryPathMutationInProgress
} from './libraryRepository.ts'
import { createLibraryWatchers } from '../../core/library/watcher.ts'
export type {
  LibraryWatcherFolderStatus,
  LibraryWatcherMode,
  LibraryWatcherState
} from '../../shared/localLibraryScan.ts'
export { LIBRARY_WATCH_EXTENSIONS } from '../../core/library/watcher.ts'

const watchers = createLibraryWatchers({
  platform: process.platform,
  now: () => new Date(),
  debounceMs: () => runtime.libraryWatcherDebounceMs,
  database: () => runtime.libraryDatabase,
  coordinator: () => runtime.localLibraryIndexCoordinator,
  isExcluded: isActiveLibraryPathExcluded,
  isMutating: isLibraryPathMutationInProgress,
  changed: (change) => {
    runtime.mainWindow?.webContents.send('library:changed', change)
  }
})
export const applyLibraryWatchers = watchers.apply
export const getLibraryWatcherStatus = watchers.status
export const getLibraryWatcherStatusSnapshot = watchers.snapshot
