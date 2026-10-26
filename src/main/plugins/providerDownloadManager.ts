import { ProviderDownloadManager as PortableDownloadManager } from '../../core/downloads/providerDownloadManager.ts'
import { writeDiagnostic } from '../diagnostics/logger.ts'
import {
  filterAuthorizedLibraryRoots,
  grantCompletedDownloadAudioFile
} from '../security/localPaths.ts'
import { fetchDownloadCover } from './downloadPlatform.ts'
import type { TwilightPluginManager } from './manager.ts'
import type { LocalLibraryIndexCoordinator } from '../library/libraryIndexCoordinator.ts'
import type { DownloadPreferences } from '../../shared/downloadPreferences.ts'
import type { ProviderDownloadTaskSnapshot } from '../../shared/providerDownloads.ts'

interface Options {
  pluginManager: TwilightPluginManager
  getPreferences?: () => DownloadPreferences
  getLibraryFolders: () => string[]
  resolveDownloadRoot?: () => Promise<string | null>
  libraryIndexCoordinator: () => Pick<LocalLibraryIndexCoordinator, 'enqueueWatcherChanges'> | null
  onChanged: (tasks: ProviderDownloadTaskSnapshot[]) => void
  fetch?: typeof globalThis.fetch
  now?: () => Date
}
/** Legacy composition only. The algorithms and lifecycle have one portable owner. */
export class ProviderDownloadManager extends PortableDownloadManager {
  constructor(options: Options) {
    super({
      pluginManager: options.pluginManager,
      getPreferences: options.getPreferences,
      authorizedRoots: async () => ({
        libraryRoots: await filterAuthorizedLibraryRoots(options.getLibraryFolders()),
        downloadRoot: (await options.resolveDownloadRoot?.().catch(() => null)) ?? null
      }),
      indexer: () => {
        const coordinator = options.libraryIndexCoordinator()
        return coordinator
          ? (path) => coordinator.enqueueWatcherChanges([{ kind: 'add', path }])
          : null
      },
      grant: grantCompletedDownloadAudioFile,
      fetchCover: fetchDownloadCover,
      onChanged: () => options.onChanged(this.list()),
      fetch: options.fetch,
      now: options.now,
      log: (taskId, previous, patch) =>
        writeDiagnostic(
          'download',
          'task.state',
          { taskId, previous, ...patch },
          patch.status === 'failed' ? 'error' : 'info',
          { operationId: taskId }
        )
    })
  }
}
