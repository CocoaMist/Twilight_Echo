import type {
  LibraryQueueBuildCommand,
  LibraryQueueBuildReply,
  LibraryQueueSeedItem
} from './libraryQueueBuild.ts'
import type { NamedQueueSession } from './queueWorkspace.ts'

/** Private Core capability: restore a named array session without changing its
 * occurrence IDs. Uses the normal once-only hidden builder, not upgrade recovery. */
export type CoreQueueRestoreCommand =
  | Exclude<LibraryQueueBuildCommand, { kind: 'append' | 'begin' }>
  | (Extract<LibraryQueueBuildCommand, { kind: 'begin' }> & {
      playMode: NamedQueueSession['playMode']
    })
  | {
      kind: 'append'
      id: string
      sequence: number
      items: Array<LibraryQueueSeedItem & { occurrenceId: string }>
    }
export interface CoreQueueRestoreApi {
  restoreNamedPlaybackQueue(command: CoreQueueRestoreCommand): Promise<LibraryQueueBuildReply>
}
