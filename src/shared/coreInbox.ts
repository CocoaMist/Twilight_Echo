import type { CoreTrackView } from './coreViews.ts'
import type { CoreStateRow } from './coreState.ts'

/** Private database command; validates the library fence and writes decisions in one dispatch. */
export interface CoreInboxDatabase {
  coreInboxWrite(
    rows: CoreStateRow[],
    revision: number,
    deletes: string[],
    libraryRevision: number
  ): Promise<number>
}

export type InboxKind = 'cover' | 'tags' | 'enrichment' | 'duplicate'
export type InboxStatus = 'pending' | 'ignored' | 'done'
export interface CoreInboxState {
  id: string
  libraryRevision: number
  revision: number
  total: number
  counts: Record<InboxStatus, Record<InboxKind, number>>
}
export interface CoreInboxQuery {
  id: string
  revision: number
  kind?: InboxKind
  status?: InboxStatus
  offset?: number
  limit?: number
}
export interface CoreInboxPage {
  state: CoreInboxState
  offset: number
  total: number
  items: Array<{
    index: number
    kind: InboxKind
    status: InboxStatus
    reason: string
    track: CoreTrackView
  }>
}
export interface CoreInboxMark {
  id: string
  revision: number
  indexes: number[]
  status: InboxStatus
}
