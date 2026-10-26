import type { LibraryPlaybackQueueReference } from './playbackSession.ts'
import type { LibraryQueueSeedItem } from './libraryQueueBuild.ts'
import type { LibraryQueueSnapshot } from './libraryDatabase.ts'

/** Private Core capability. The caller must resolve/authorize the replacement
 * and fence native selection before committing; UI clients cannot upload it. */
export interface CoreQueueSourceReplacement {
  queue: LibraryPlaybackQueueReference
  contentRevision: number
  occurrenceId: string
  expectedTrackId: string
  replacement: LibraryQueueSeedItem
}
export interface CoreSourceRecoveryApi {
  replacePlaybackQueueSource(command: CoreQueueSourceReplacement): Promise<LibraryQueueSnapshot>
}
