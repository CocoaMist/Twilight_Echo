import type { LibraryQuery, LibraryTrackRecord } from './libraryDatabase.ts'

/** Half-open absolute positions in one displayed query, not loaded-page indices. */
export type LibrarySelectionRange = [start: number, end: number]

export interface LibrarySelectionRequest {
  query: LibraryQuery & { contentRevision: number }
  /** Displayed query count; a different count cannot silently narrow the selection. */
  total: number
  /** Ordered, disjoint, non-adjacent ranges. A full query needs just [0, total]. */
  ranges: LibrarySelectionRange[]
}

export interface LibrarySelectionSnapshot {
  id: string
  revision: number
  historyRevision?: number
  total: number
  selectedCount: number
  localTrackCount: number
  /** Distinct physical files; selecting several CUE tracks still counts one file. */
  fileCount: number
}

export interface LibrarySelectionRow {
  position: number
  entryId?: string
  /** Original configured member, before preferred-source or relinking resolution. */
  definitionId: string
  track: LibraryTrackRecord
  version: number
  /** Local row incarnation; deletion/re-addition cannot reuse this identity. */
  instance?: number
}

export interface LibrarySelectionPage {
  snapshot: LibrarySelectionSnapshot
  rows: LibrarySelectionRow[]
  /** Keyset cursor over the immutable snapshot; unaffected by subsequent removals. */
  nextCursor: number | null
}

/** Internal main-to-worker transport. The renderer uses the sender-bound lease.
 * Frozen records describe selection intent, not current metadata or file authority.
 * Mutations must still use their existing version/identity/authorization checks. */
export interface LibrarySelectionApi {
  createTrackSelection(request: LibrarySelectionRequest): Promise<LibrarySelectionSnapshot>
  readTrackSelection(
    id: string,
    cursor?: number,
    projection?: 'tracks' | 'files',
    requireCurrent?: boolean
  ): Promise<LibrarySelectionPage>
  closeTrackSelection(id: string): Promise<void>
}

/** Sender-bound renderer lease. Closing also cancels an in-flight open. */
export type LibrarySelectionCommand =
  | { kind: 'open'; id: string; request: LibrarySelectionRequest }
  | { kind: 'read'; id: string; cursor?: number; projection?: 'tracks' | 'files' }
  | { kind: 'close'; id: string }
export type LibrarySelectionReply =
  | { kind: 'ready'; id: string; snapshot: LibrarySelectionSnapshot }
  | { kind: 'page'; id: string; page: LibrarySelectionPage }
  | { kind: 'closed'; id: string }
export interface LibrarySelectionBridgeApi {
  selection(command: LibrarySelectionCommand): Promise<LibrarySelectionReply>
}
