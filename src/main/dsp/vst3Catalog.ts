import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Vst3HelpersAvailability } from '../../shared/dspGraph.ts'
import { getNativeAddonCandidates } from '../audio/nativeBinding.ts'
import {
  Vst3CatalogService as Catalog,
  type Vst3ModuleScanner
} from '../../core/audio/vst3Catalog.ts'
export * from '../../core/audio/vst3Catalog.ts'
export class Vst3CatalogService extends Catalog {
  constructor(
    root: string,
    scanner: Vst3ModuleScanner,
    standardSearchPaths = defaultVst3SearchPaths()
  ) {
    super(root, scanner, standardSearchPaths, {
      platform: process.platform,
      get helpers() {
        return resolveVst3HelpersAvailability()
      },
      now: Date.now
    })
  }
}
export function defaultVst3SearchPaths(): string[] {
  if (process.platform !== 'win32') return []
  const commonProgramFiles = process.env.CommonProgramFiles || 'C:\\Program Files\\Common Files'
  return [join(commonProgramFiles, 'VST3')]
}

export function resolveVst3HelpersAvailability(): Vst3HelpersAvailability {
  const platformSupported = process.platform === 'win32'
  if (!platformSupported) {
    return { platformSupported: false, scannerPresent: false, hostPresent: false }
  }
  const roots = new Set<string>()
  for (const candidate of getNativeAddonCandidates()) {
    const root = candidate.replace(/[\\/][^\\/]+$/, '')
    if (root) roots.add(root)
  }
  let scannerPresent = false
  let hostPresent = false
  for (const root of roots) {
    if (existsSync(join(root, 'twilight-vst3-scanner.exe'))) scannerPresent = true
    if (existsSync(join(root, 'twilight-vst3-host.exe'))) hostPresent = true
    if (scannerPresent && hostPresent) break
  }
  return { platformSupported: true, scannerPresent, hostPresent }
}
