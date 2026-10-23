import type { AutoMixStemCapabilities } from './twilightAutoMix.ts'

export type CoreAutoMixCapabilities = Omit<AutoMixStemCapabilities, 'packs'> & {
  packs: Array<{ cpu: boolean; gpu: boolean; gpuName?: string }>
}

/** Private, fixed-purpose Python job. Executable and worker are resolved by main. */
export interface CoreAutoMixWorkerRequest {
  packDirectory: string
  requestPath: string
  budgetMs: number
}
