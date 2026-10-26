import type { CoreTrackView } from './coreViews.ts'
import type { NamedQueueSession, PlaybackOrderEntry } from './queueWorkspace.ts'

export type CoreQueueSessionSummary = Omit<
  NamedQueueSession,
  'entries' | 'originalEntryIds' | 'libraryQueue'
> & {
  count: number | null
  storage: 'libraryQueue' | 'entries'
}
export interface CoreWorkspaceState {
  revision: number
  contentRevision: number
  sessions: number
  history: number
  error: string | null
}
export type CoreWorkspaceEdit = {
  revision: number
  edit:
    | { kind: 'saveCurrent'; name: string; id?: string }
    | { kind: 'rename'; id: string; name: string }
    | { kind: 'remove'; id: string }
}
export interface CoreWorkspaceRestore {
  revision: number
  id: string
  play?: boolean
}
export interface CoreWorkspaceRestoreResult {
  restored: number
  unavailable: number
  deferred: number
  issues: Array<{ occurrenceId: string; title: string; reason: string }>
}
export interface CoreWorkspacePageQuery {
  revision: number
  contentRevision: number
  offset?: number
  limit?: number
}
export interface CoreWorkspaceSessionsPage {
  revision: number
  contentRevision: number
  offset: number
  total: number
  items: CoreQueueSessionSummary[]
}
export interface CoreWorkspaceHistoryPage {
  revision: number
  contentRevision: number
  offset: number
  total: number
  items: Array<Omit<PlaybackOrderEntry, 'track'> & { track: CoreTrackView }>
}
