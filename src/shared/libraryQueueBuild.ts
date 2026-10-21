import type {
  LibraryQueueInsertItem,
  LibraryQueueSnapshot,
  LibraryTrackRecord
} from './libraryDatabase.ts'

/** Existing array occurrences may refer to temporary local files outside the
 * library. This seed-only snapshot preserves them without importing a track or
 * relaxing the ordinary queue insertion contract. */
export type LibraryQueueSeedItem = LibraryQueueInsertItem & {
  localSnapshot?: LibraryTrackRecord
  originalPosition?: number
}

/** Hidden queue construction. Renderer IDs are sender-bound leases; main maps
 * them to private worker IDs. Only a successful commit exposes a ready queue. */
export type LibraryQueueBuildCommand =
  | {
      kind: 'begin'
      id: string
      contentRevision: number
      order: 'original' | 'shuffle'
    }
  | {
      kind: 'append'
      id: string
      sequence: number
      /** Current order is the stream order. Only an existing array source needs
       * to supply its independent original positions. New suffixes omit them. */
      items: LibraryQueueSeedItem[]
    }
  | { kind: 'commit'; id: string; sequence: number; selectedIndex: number }
  | { kind: 'abort'; id: string }

export type LibraryQueueBuildReply =
  | { kind: 'building'; id: string; sequence: number; total: number }
  | { kind: 'ready'; id: string; queue: LibraryQueueSnapshot }
  | { kind: 'aborted'; id: string }

export interface LibraryQueueBuildApi {
  buildQueue(command: LibraryQueueBuildCommand): Promise<LibraryQueueBuildReply>
}

export const LIBRARY_QUEUE_BUILD_IDLE_MS = 120_000
export const LIBRARY_QUEUE_BUILD_MAX_ENTRIES = 1_000_000
