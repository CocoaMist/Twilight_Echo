import { tmpdir } from 'node:os'
import { importDspProfileArchive as importArchive } from '../../core/audio/dspProfileArchive.ts'
import type { DspAssetLibrary } from './dspAssetLibrary.ts'
export * from '../../core/audio/dspProfileArchive.ts'
export function importDspProfileArchive(path: string, assets: DspAssetLibrary) {
  return importArchive(path, assets, tmpdir())
}
