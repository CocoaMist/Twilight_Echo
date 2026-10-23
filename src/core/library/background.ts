import type { LibraryMetadata } from '../../shared/libraryDatabase.ts'
import type { LocalLibraryWatchChange } from '../../shared/localLibraryScan.ts'
import type { CoreScanService } from './scanService.ts'
import { createLibraryWatchers, type LibraryWatcherOptions } from './watcher.ts'

export interface CoreLibraryBackgroundOptions {
  database: { getMetadata(): Promise<LibraryMetadata> }
  scan: Pick<CoreScanService, 'startup' | 'poll' | 'enqueueDirectories'>
  enabled(): boolean
  authorizeDirectory(path: string): Promise<string>
  pathKey(path: string): string
  directoryOf(path: string): string
  platform: string
  now(): Date
  failed(error: unknown): void
  watch?: LibraryWatcherOptions['watch']
}

/** Core owns library startup and file monitoring independently of connected windows. */
export class CoreLibraryBackground {
  private readonly watchers: ReturnType<typeof createLibraryWatchers>
  private folders: string[] = []
  private enabled = false
  private exclusions = new Set<string>()
  private activated = false
  private stopped = false
  private work: Promise<void> = Promise.resolve()
  private readonly options: CoreLibraryBackgroundOptions
  constructor(options: CoreLibraryBackgroundOptions) {
    this.options = options
    const sink = {
      poll: (directory: string) => options.scan.poll(directory),
      enqueueWatcherChanges: (changes: LocalLibraryWatchChange[]) => {
        const directories = changes.map((change) =>
          change.kind === 'reconcile' ? change.path : options.directoryOf(change.path)
        )
        void options.scan.enqueueDirectories(directories).catch(options.failed)
      }
    }
    this.watchers = createLibraryWatchers({
      platform: options.platform,
      now: options.now,
      debounceMs: () => 350,
      database: () => sink,
      coordinator: () => null,
      isExcluded: (path) => this.exclusions.has(options.pathKey(path)),
      isMutating: () => false,
      changed: () => {},
      watch: options.watch
    })
  }
  activate(): void {
    if (this.activated || this.stopped) return
    this.activated = true
    this.work = (async () => {
      await this.options.scan.startup().catch(this.options.failed)
      await this.apply()
    })().catch(this.options.failed)
  }
  configure(): Promise<void> {
    if (!this.activated || this.stopped) return Promise.resolve()
    const work = this.work.then(() => this.apply())
    this.work = work.catch(this.options.failed)
    return work
  }
  private async apply(): Promise<void> {
    const metadata = await this.options.database.getMetadata()
    const folders: string[] = []
    const enabled = this.options.enabled()
    if (enabled)
      for (const folder of metadata.folders) {
        if (this.stopped) return
        folders.push(await this.options.authorizeDirectory(folder))
      }
    if (this.stopped) return
    this.folders = enabled ? folders : metadata.folders
    this.enabled = enabled
    this.exclusions = new Set(
      metadata.exclusions.map((exclusion) => this.options.pathKey(exclusion.filePath))
    )
    this.watchers.apply(this.folders, enabled)
  }
  snapshot() {
    return this.watchers.snapshot(this.folders, this.enabled)
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    // Remove handles immediately; scan.shutdown concurrently releases any active poll.
    const closing = this.watchers.close()
    await this.work
    await closing
  }
}
