import { mkdir, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

interface Options {
  root: string
  legacyCover: string
  authorizeRoot(): Promise<string>
  maintainRemote<T>(action: () => Promise<T>): Promise<T>
  maintainCovers<T>(action: () => Promise<T>): Promise<T>
  clearMemory(): void
  clearChromium(): Promise<void>
}

/** Main's finite platform capability. Chromium owns its live disk cache; only
 * drained cover repositories may be removed directly. No caller-supplied paths. */
export function createPlatformCacheMaintenance(options: Options) {
  const root = resolve(options.root),
    legacy = resolve(options.legacyCover)
  const fromLegacy = relative(legacy, root)
  // A user may select the legacy cover directory (or a child) as their new
  // music-cache root. Never remove that selected root through legacy cleanup.
  const legacyContainsRoot =
    !fromLegacy ||
    (!isAbsolute(fromLegacy) && fromLegacy !== '..' && !fromLegacy.startsWith(`..${sep}`))
  const directories = new Set([join(root, 'cover-cache'), ...(!legacyContainsRoot ? [legacy] : [])])
  return async (signal: AbortSignal): Promise<void> => {
    await options.authorizeRoot()
    signal.throwIfAborted()
    await options.maintainRemote(() =>
      options.maintainCovers(async () => {
        signal.throwIfAborted()
        options.clearMemory()
        // The cover gate excludes normalization and synchronous imports. rm
        // removes a directory symlink itself, not its contents.
        try {
          for (const directory of directories) {
            signal.throwIfAborted()
            await rm(directory, { recursive: true, force: true })
            await mkdir(directory, { recursive: true })
          }
        } finally {
          options.clearMemory()
        }
      })
    )
    signal.throwIfAborted()
    await options.clearChromium()
  }
}
