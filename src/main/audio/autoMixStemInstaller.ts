import { join } from 'node:path'
import { AutoMixStemInstaller as CoreInstaller } from '../../core/audio/autoMixStemInstaller.ts'
import { probeStemRuntime } from './autoMixStemRuntime.ts'
import { decodeStemZipLzma } from './autoMixStemZipLzma.ts'

export {
  managedStemPackDirectories,
  validateStemArchivePath
} from '../../core/audio/autoMixStemInstaller.ts'

/** Compatibility for the current main owner until the production Core switch. */
export class AutoMixStemInstaller extends CoreInstaller {
  constructor(
    options: Omit<ConstructorParameters<typeof CoreInstaller>[0], 'probe' | 'decodeLzma'> & {
      probe?: typeof probeStemRuntime
      workerDirectory: () => string
    }
  ) {
    super({
      ...options,
      probe: (directory, signal) =>
        (options.probe ?? probeStemRuntime)(directory, options.workerDirectory(), signal),
      decodeLzma: (input, bytes, signal) =>
        decodeStemZipLzma(input, bytes, join(options.workerDirectory(), '7za.exe'), signal)
    })
  }
}
