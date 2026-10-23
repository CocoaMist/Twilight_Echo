import type { LibraryDatabaseApi, LibraryMetadata } from '../../shared/libraryDatabase.ts'
import type {
  LibrarySelectionApi,
  LibrarySelectionRequest,
  LibrarySelectionRow,
  LibrarySelectionSnapshot
} from '../../shared/librarySelection.ts'
import type {
  CoreLibrarySelectionPage,
  CoreLibraryRemovalResult,
  CoreRemovalDatabase,
  CoreTagWrite,
  CoreTagResult,
  LibraryTagJournalStatus,
  LibraryTagWorkerRequest
} from '../../shared/coreLibraryMaintenance.ts'
import type { LocalLibraryRemovalMode } from '../../shared/localLibrary.ts'
import type { LocalLibraryTagWriteResult } from '../../shared/localLibraryTags.ts'
import { projectCoreError, projectCoreTrack } from '../projections.ts'
import { commitDatabaseLibraryRemoval } from './removalCoordinator.ts'

interface Database
  extends LibrarySelectionApi, CoreRemovalDatabase, Pick<LibraryDatabaseApi, 'getMetadata'> {
  resetLibrary(
    expectedRevision?: number
  ): Promise<{ metadata: LibraryMetadata; removedTrackIds: string[]; removedFilePaths: string[] }>
  clearFileExclusions(
    paths: string[],
    expectedRevision?: number
  ): Promise<{ metadata: LibraryMetadata; clearedFilePaths: string[] }>
}
interface Options {
  database: Database
  scanner: {
    maintain<T>(action: () => Promise<T>, resume?: boolean): Promise<T>
    enqueueDirectories(roots: readonly string[]): Promise<void>
  }
  maintainFiles<T>(paths: string[], action: () => Promise<T>): Promise<T>
  authorizeFile(path: string): Promise<string>
  authorizeRemoval(path: string, mode: LocalLibraryRemovalMode): Promise<void>
  trash(path: string): Promise<void>
  tagJournalExists(): Promise<boolean>
  tags(
    request: LibraryTagWorkerRequest
  ): Promise<LibraryTagJournalStatus | LocalLibraryTagWriteResult | void>
  pathKey(path: string): string
  directoryOf(path: string): string
  fileName(path: string): string
  newId(): string
  changed(): void
}
/** One Core-owned mutation lane. Accepted file work outlives the initiating
 * window; durable removal/tag journals retain their existing recovery rules. */
export class CoreLibraryMaintenance {
  private readonly options: Options
  private readonly busySelections = new Set<string>()
  private serial: Promise<unknown> = Promise.resolve()
  private stopped = false
  constructor(options: Options) {
    this.options = options
  }
  async initialize(): Promise<void> {
    await this.options.database.recoverRemoval()
    await this.recoverTags()
  }
  async open(
    request: LibrarySelectionRequest,
    signal?: AbortSignal
  ): Promise<LibrarySelectionSnapshot> {
    this.running()
    signal?.throwIfAborted()
    const snapshot = await this.options.database.createTrackSelection(request)
    if (this.stopped || signal?.aborted) {
      await this.options.database.closeTrackSelection(snapshot.id)
      signal?.throwIfAborted()
      this.running()
    }
    return snapshot
  }
  async page(
    id: string,
    cursor = 0,
    projection: 'tracks' | 'files' = 'tracks'
  ): Promise<CoreLibrarySelectionPage> {
    this.running()
    const page = await this.options.database.readTrackSelection(id, cursor, projection)
    return {
      ...page,
      rows: page.rows.map((row) => ({ ...row, track: projectCoreTrack(row.track) }))
    }
  }
  async close(id: string): Promise<void> {
    this.running()
    if (this.busySelections.has(id))
      throw Object.assign(new Error('Selection is used by an accepted file operation'), {
        code: 'BUSY'
      })
    await this.release(id)
  }
  private async release(id: string): Promise<void> {
    this.busySelections.delete(id)
    await this.options.database.closeTrackSelection(id)
  }
  private running(): void {
    if (this.stopped) throw new Error('Core library maintenance is shutting down')
  }
  private enqueue<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.running()
    signal?.throwIfAborted()
    const work = this.serial.then(async () => {
      // Cancellation can withdraw waiting work, never an already dispatched write.
      signal?.throwIfAborted()
      await this.options.database.recoverRemoval()
      return action()
    })
    this.serial = work.catch(() => {})
    return work
  }
  private async files(
    id: string,
    maximum: number,
    current = false
  ): Promise<LibrarySelectionRow[]> {
    const rows: LibrarySelectionRow[] = []
    let cursor: number | null = 0
    do {
      const page = await this.options.database.readTrackSelection(id, cursor, 'files', current)
      if (page.snapshot.fileCount === 0 || page.snapshot.fileCount > maximum)
        throw new Error(`Select 1-${maximum} local files`)
      rows.push(...page.rows)
      cursor = page.nextCursor
    } while (cursor !== null)
    return rows
  }
  private withSelection<T>(id: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.busySelections.has(id))
      throw Object.assign(new Error('Selection already has an accepted operation'), {
        code: 'BUSY'
      })
    this.busySelections.add(id)
    let work: Promise<T>
    try {
      work = this.enqueue(action, signal)
    } catch (error) {
      this.busySelections.delete(id)
      throw error
    }
    return work.finally(() => this.release(id))
  }
  remove(
    id: string,
    mode: LocalLibraryRemovalMode,
    signal?: AbortSignal
  ): Promise<CoreLibraryRemovalResult> {
    return this.withSelection(
      id,
      async () => {
        const rows = await this.files(id, 10_000)
        const run = async () => {
          const removedTrackIds: string[] = [],
            failures: CoreLibraryRemovalResult['failures'] = []
          let removedFileCount = 0
          for (let offset = 0; offset < rows.length; offset += 200) {
            const batch = rows.slice(offset, offset + 200)
            const result = await commitDatabaseLibraryRemoval({
              database: this.options.database,
              id: this.options.newId(),
              mode,
              items: batch.map((row) => ({
                id: row.track.id,
                filePath: row.track.filePath,
                title: String(row.track.title ?? ''),
                artist: String(row.track.artist ?? ''),
                expectedVersion: row.version,
                expectedInstance: row.instance
              })),
              authorize: (path) => this.options.authorizeRemoval(path, mode),
              trashItem: this.options.trash,
              pathKey: this.options.pathKey
            })
            removedTrackIds.push(...result.removedTrackIds)
            removedFileCount += result.removedFilePaths.length
            failures.push(
              ...result.failures.map((failure) => ({
                id: batch.find(
                  (row) =>
                    this.options.pathKey(row.track.filePath) ===
                    this.options.pathKey(failure.filePath)
                )!.track.id,
                message: projectCoreError(failure.message)
              }))
            )
            this.options.changed()
          }
          return {
            revision: (await this.options.database.getMetadata()).revision,
            removedTrackIds,
            removedFileCount,
            failures
          }
        }
        return mode === 'trash'
          ? this.options.scanner.maintain(() =>
              this.options.maintainFiles(
                rows.map((row) => row.track.filePath),
                run
              )
            )
          : run()
      },
      signal
    )
  }
  reset(
    revision: number,
    signal?: AbortSignal
  ): Promise<{ revision: number; removedTracks: number; removedFiles: number }> {
    return this.enqueue(
      () =>
        this.options.scanner.maintain(async () => {
          const result = await this.options.database.resetLibrary(revision)
          this.options.changed()
          return {
            revision: result.metadata.revision,
            removedTracks: result.removedTrackIds.length,
            removedFiles: new Set(result.removedFilePaths.map(this.options.pathKey)).size
          }
        }, false),
      signal
    )
  }
  clearExclusions(
    revision: number,
    paths: string[],
    signal?: AbortSignal
  ): Promise<{ revision: number; clearedFiles: number }> {
    return this.enqueue(async () => {
      // This removes exclusion records only. Import/scan remains an explicit action.
      const result = await this.options.database.clearFileExclusions(paths, revision)
      this.options.changed()
      return { revision: result.metadata.revision, clearedFiles: result.clearedFilePaths.length }
    }, signal)
  }
  writeTags(request: CoreTagWrite, signal?: AbortSignal): Promise<CoreTagResult> {
    return this.withSelection(
      request.selectionId,
      () =>
        this.options.scanner.maintain(async () => {
          await this.recoverTags()
          const rows = await this.files(request.selectionId, 1000, true)
          const overrides = new Map(request.items?.map((item) => [item.id, item.patch]))
          if (
            request.items &&
            (overrides.size !== request.items.length ||
              request.items.some((item) => !rows.some((row) => row.track.id === item.id)))
          )
            throw new Error('Tag overrides must identify distinct selected physical files')
          const selected = rows.filter((row) => request.patch || overrides.has(row.track.id))
          const paths = await this.authorizeFiles(selected.map((row) => row.track.filePath))
          return this.options.maintainFiles(paths, async () => {
            // Authorization/resource draining can take time. Recheck row incarnation
            // as well as version before dispatching the irreversible worker job.
            await this.files(request.selectionId, 1000, true)
            try {
              const result = (await this.options.tags({
                kind: 'write',
                items: selected.map((row, index) => ({
                  ...request.patch,
                  ...overrides.get(row.track.id),
                  filePath: paths[index]
                }))
              })) as LocalLibraryTagWriteResult
              return this.tagResult(result, selected)
            } finally {
              await this.reindex(paths)
            }
          })
        }),
      signal
    )
  }
  restoreTags(selectionId: string | undefined, signal?: AbortSignal): Promise<CoreTagResult> {
    const run = () =>
      this.options.scanner.maintain(async () => {
        const rows = selectionId ? await this.files(selectionId, 1000, true) : []
        const journal = selectionId ? null : await this.inspectTags()
        const paths = await this.authorizeFiles(
          selectionId ? rows.map((row) => row.track.filePath) : journal!.filePaths
        )
        if (!paths.length) return { items: [] }
        return this.options.maintainFiles(paths, async () => {
          if (selectionId) await this.files(selectionId, 1000, true)
          try {
            const result = (await this.options.tags({
              kind: 'restore',
              filePaths: paths
            })) as LocalLibraryTagWriteResult
            return this.tagResult(result, rows)
          } finally {
            await this.reindex(paths)
          }
        })
      })
    return selectionId ? this.withSelection(selectionId, run, signal) : this.enqueue(run, signal)
  }
  private tagResult(
    result: LocalLibraryTagWriteResult,
    rows: LibrarySelectionRow[]
  ): CoreTagResult {
    return {
      items: result.items.map((item) => ({
        id:
          rows.find(
            (row) =>
              this.options.pathKey(row.track.filePath) === this.options.pathKey(item.filePath)
          )?.track.id ?? null,
        name: this.options.fileName(item.filePath),
        status: item.status,
        ...(item.message ? { message: projectCoreError(item.message) } : {})
      }))
    }
  }
  private async authorizeFiles(paths: string[]): Promise<string[]> {
    const authorized: string[] = []
    for (const path of paths) authorized.push(await this.options.authorizeFile(path))
    return authorized
  }
  private async inspectTags(): Promise<LibraryTagJournalStatus> {
    return (await this.options.tagJournalExists())
      ? ((await this.options.tags({ kind: 'inspect' })) as LibraryTagJournalStatus)
      : { interrupted: false, filePaths: [] }
  }
  private async recoverTags(): Promise<void> {
    const journal = await this.inspectTags()
    if (!journal.interrupted) return
    const paths = await this.authorizeFiles(journal.filePaths)
    await this.options.maintainFiles(paths, async () => {
      await this.options.tags({ kind: 'recover' })
      await this.reindex(paths)
    })
  }
  private async reindex(paths: string[]): Promise<void> {
    await this.options.scanner.enqueueDirectories([...new Set(paths.map(this.options.directoryOf))])
    this.options.changed()
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    await this.serial
  }
}
