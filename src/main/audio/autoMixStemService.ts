import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { AutoMixStemService as CoreStemService } from '../../core/audio/autoMixStemService.ts'
import { runAutoMixStemWorker } from './autoMixStemRuntime.ts'
export * from '../../core/audio/autoMixStemService.ts'

/** Compatibility constructor for the legacy owner, removed at production cutover. */
export class AutoMixStemService extends CoreStemService {
  constructor(
    cacheDirectory: string,
    pack: () => string | null | Promise<string | null>,
    enabled: () => boolean,
    reportResources?: (resources: Record<string, unknown>) => void,
    cacheMiB: () => unknown = () => 512,
    workerDirectory: () => string = () => resolve('resources/automix-stems'),
    device: () => unknown = () => 'auto'
  ) {
    super({
      cacheDirectory,
      pack,
      enabled,
      reportResources,
      cacheMiB,
      workerDirectory,
      device,
      temporaryDirectory: tmpdir(),
      runWorker: runAutoMixStemWorker
    })
  }
}
