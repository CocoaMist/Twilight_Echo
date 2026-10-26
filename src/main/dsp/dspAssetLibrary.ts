import { randomUUID } from 'node:crypto'
import { DspAssetLibrary as Assets } from '../../core/audio/dspAssetLibrary.ts'
export * from '../../core/audio/dspAssetLibrary.ts'
export class DspAssetLibrary extends Assets {
  constructor(root: string) {
    super(root, { now: Date.now, newId: randomUUID })
  }
}
