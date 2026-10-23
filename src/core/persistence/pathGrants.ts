import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export type GrantedPathKind = 'any' | 'directory' | 'file'

export async function resolveCanonicalExistingPath(
  targetPath: string,
  kind: GrantedPathKind = 'any'
): Promise<string> {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new Error('Path is required')
  }
  const canonicalPath = await realpath(resolve(targetPath))
  const info = await stat(canonicalPath)
  if (kind === 'directory' && !info.isDirectory()) {
    throw new Error('Path is not a directory')
  }
  if (kind === 'file' && !info.isFile()) {
    throw new Error('Path is not a file')
  }
  return canonicalPath
}

export function isCanonicalPathInside(rootPath: string, targetPath: string): boolean {
  const rel = relative(rootPath, targetPath)
  return rel === '' || (!!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

export function lexicalPathKey(targetPath: string): string {
  const normalized = resolve(targetPath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export class CanonicalPathGrantSet {
  readonly #roots = new Map<string, string>()
  readonly #files = new Map<string, string>()

  grantCanonicalRoot(canonicalPath: string): string {
    this.#roots.set(lexicalPathKey(canonicalPath), canonicalPath)
    return canonicalPath
  }

  grantCanonicalFile(canonicalPath: string): string {
    this.#files.set(lexicalPathKey(canonicalPath), canonicalPath)
    return canonicalPath
  }

  async grantRoot(targetPath: string): Promise<string> {
    return this.grantCanonicalRoot(await resolveCanonicalExistingPath(targetPath, 'directory'))
  }

  async grantFile(targetPath: string): Promise<string> {
    return this.grantCanonicalFile(await resolveCanonicalExistingPath(targetPath, 'file'))
  }

  isCanonicalWithinRoots(canonicalPath: string): boolean {
    for (const rootPath of this.#roots.values()) {
      if (isCanonicalPathInside(rootPath, canonicalPath)) return true
    }
    return false
  }

  hasCanonicalRoot(canonicalPath: string): boolean {
    return this.#roots.has(lexicalPathKey(canonicalPath))
  }

  hasCanonicalFile(canonicalPath: string): boolean {
    return this.#files.has(lexicalPathKey(canonicalPath))
  }

  async resolveWithinRoots(
    targetPath: string,
    kind: GrantedPathKind = 'any'
  ): Promise<string | null> {
    const canonicalPath = await resolveCanonicalExistingPath(targetPath, kind)
    return this.isCanonicalWithinRoots(canonicalPath) ? canonicalPath : null
  }

  async resolveExactRoot(targetPath: string): Promise<string | null> {
    const canonicalPath = await resolveCanonicalExistingPath(targetPath, 'directory')
    return this.hasCanonicalRoot(canonicalPath) ? canonicalPath : null
  }

  async resolveExactFile(targetPath: string): Promise<string | null> {
    const canonicalPath = await resolveCanonicalExistingPath(targetPath, 'file')
    return this.hasCanonicalFile(canonicalPath) ? canonicalPath : null
  }
}
