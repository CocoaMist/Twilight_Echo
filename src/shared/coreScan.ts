import type {
  LibraryDatabaseScanResult,
  LibraryMetadata,
  LibraryScanCommit,
  LibraryScanDatabaseApi,
  LibraryScanJob,
  LibraryScanProgressSnapshot,
  LibraryScanStartRequest
} from './libraryDatabase.ts'

export interface CoreScanDatabase extends LibraryScanDatabaseApi {
  getMetadata(): Promise<LibraryMetadata>
  listScanJobs(): Promise<LibraryScanJob[]>
  getLatestScanJob(): Promise<LibraryScanJob | null>
  startScan(request: LibraryScanStartRequest): Promise<LibraryScanJob>
  setScanState(id: string, state: LibraryScanJob['state']): Promise<void>
  resumeScan(id: string): Promise<LibraryScanJob>
}
export interface CoreScanRunner {
  scanDatabase(
    jobId: string,
    coverCacheDir: string,
    database: LibraryScanDatabaseApi,
    onProgress?: (
      progress: LibraryScanProgressSnapshot,
      phase: 'checking' | 'parsing' | 'committing'
    ) => void,
    prepareBatch?: (batch: LibraryScanCommit) => Promise<LibraryScanCommit>,
    signal?: AbortSignal,
    forceParse?: boolean
  ): Promise<LibraryDatabaseScanResult>
  pause(id: string): void
  resume(id: string): void
  destroy(): void
}
export type CoreScanStatus = LibraryScanProgressSnapshot & {
  phase: 'checking' | 'parsing' | 'committing' | 'idle'
  error: string
}
export class LibraryScanInterruptedError extends Error {}
