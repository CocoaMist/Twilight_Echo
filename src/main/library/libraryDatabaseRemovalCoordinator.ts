import { commitDatabaseLibraryRemoval as commit } from '../../core/library/removalCoordinator.ts'
import { normalizeLibraryFilePath } from './libraryRepository.ts'

/** Compatibility entry point until the single production owner cutover. */
export function commitDatabaseLibraryRemoval(
  options: Omit<Parameters<typeof commit>[0], 'pathKey'>
) {
  return commit({ ...options, pathKey: normalizeLibraryFilePath })
}
