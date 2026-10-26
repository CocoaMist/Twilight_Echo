import type {
  LibraryQueueBuildCommand,
  LibraryQueueBuildReply,
  LibraryQueueSeedItem
} from './libraryQueueBuild.ts'

/** Private database capability for a legacy session upgrade. Ordinary queue
 * builders cannot choose persistent occurrence IDs or continue this namespace. */
export type CoreQueueImportCommand =
  | Exclude<LibraryQueueBuildCommand, { kind: 'append' }>
  | {
      kind: 'append'
      id: string
      sequence: number
      items: Array<LibraryQueueSeedItem & { occurrenceId: string }>
    }
export type CoreQueueImportReply = LibraryQueueBuildReply | { kind: 'retiring'; id: string }
export interface CoreQueueImportApi {
  importLegacyPlaybackQueue(command: CoreQueueImportCommand): Promise<CoreQueueImportReply>
}
