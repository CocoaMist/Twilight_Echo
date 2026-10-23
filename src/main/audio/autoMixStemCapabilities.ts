import { AutoMixStemDetector as CoreStemDetector } from '../../core/audio/autoMixStemCapabilities.ts'
import { probeStemRuntime } from './autoMixStemRuntime.ts'
export * from '../../core/audio/autoMixStemCapabilities.ts'
export { probeStemRuntime } from './autoMixStemRuntime.ts'

export class AutoMixStemDetector extends CoreStemDetector {
  constructor(candidates: () => string[], workerDirectory: () => string, probe = probeStemRuntime) {
    super(candidates, workerDirectory, probe)
  }
}
