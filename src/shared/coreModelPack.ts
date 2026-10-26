import type { AutoMixStemInstallStatus } from './twilightAutoMix.ts'

export type CoreModelPackStatus = AutoMixStemInstallStatus

/** Private decode ticket. Main resolves the decoder and both fixed filenames. */
export interface CoreModelPackDecode {
  directory: string
  bytes: number
}

export interface CoreModelPackPlatformOperations {
  'automix.chooseArchive': { input: Record<string, never>; output: string | null }
  'automix.decodeArchiveEntry': { input: CoreModelPackDecode; output: void }
  'automix.probeInstall': {
    input: { packDirectory: string }
    output: { cpu: boolean; gpu: boolean; gpuName?: string }
  }
}
