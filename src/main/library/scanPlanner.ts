import type {
  LocalLibraryFileIdentity,
  LocalLibraryScanMode,
  LocalLibraryWatchChange
} from '../../shared/localLibraryScan.ts'
import { LOCAL_LIBRARY_METADATA_VERSION } from '../../shared/localLibraryScan.ts'
import { normalizeLibraryFilePath } from './libraryRepository.ts'
import { createLocalLibraryFileIndexMap, sameLocalLibraryFileIdentity } from './fileIndex.ts'

export interface LocalLibraryScanPlan {
  parseFilePaths: string[]
  releaseDateFilePaths: string[]
  skippedUnchanged: number
  removedFilePaths: string[]
}

export function createLocalLibraryScanPlan(options: {
  mode: LocalLibraryScanMode
  identities: LocalLibraryFileIdentity[]
  knownIdentities: LocalLibraryFileIdentity[]
  knownTrackPaths: string[]
  excludedPaths: string[]
  forceParse?: boolean
  changes?: LocalLibraryWatchChange[]
  completeIdentitySnapshot: boolean
}): LocalLibraryScanPlan {
  const knownByPath = createLocalLibraryFileIndexMap(options.knownIdentities)
  const knownTrackPaths = new Set(options.knownTrackPaths.map(normalizeLibraryFilePath))
  const excludedPaths = new Set(options.excludedPaths.map(normalizeLibraryFilePath))
  const identitiesByPath = createLocalLibraryFileIndexMap(options.identities)
  const parseFilePaths: string[] = []
  const releaseDateFilePaths: string[] = []
  let skippedUnchanged = 0

  for (const identity of options.identities) {
    const key = normalizeLibraryFilePath(identity.filePath)
    if (excludedPaths.has(key)) {
      skippedUnchanged++
      continue
    }
    const known = knownByPath.get(key)
    const needsParse =
      options.forceParse === true ||
      options.mode === 'full' ||
      !known ||
      !knownTrackPaths.has(key) ||
      !sameLocalLibraryFileIdentity(known, identity)

    if (needsParse) parseFilePaths.push(identity.filePath)
    else if ((known?.metadataVersion ?? 0) < LOCAL_LIBRARY_METADATA_VERSION) {
      parseFilePaths.push(identity.filePath)
      releaseDateFilePaths.push(identity.filePath)
    } else skippedUnchanged++
  }

  const removed = new Set<string>()
  if (options.completeIdentitySnapshot) {
    for (const known of options.knownIdentities) {
      const key = normalizeLibraryFilePath(known.filePath)
      if (!identitiesByPath.has(key) || excludedPaths.has(key)) removed.add(known.filePath)
    }
    for (const knownTrackPath of options.knownTrackPaths) {
      const key = normalizeLibraryFilePath(knownTrackPath)
      if (!identitiesByPath.has(key) || excludedPaths.has(key)) {
        removed.add(knownTrackPath)
      }
    }
  }
  for (const change of options.changes ?? []) {
    const key = normalizeLibraryFilePath(change.path)
    if (change.kind === 'remove' && (knownByPath.has(key) || knownTrackPaths.has(key))) {
      removed.add(change.path)
    }
  }

  return {
    parseFilePaths,
    releaseDateFilePaths,
    skippedUnchanged,
    removedFilePaths: Array.from(removed)
  }
}
