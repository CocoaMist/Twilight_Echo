import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { tryParseJsonWithNestingLimit } from '../security/jsonSafety.ts'

interface AnalysisCacheFile<Analysis> {
  version: 1
  entries: Record<string, Analysis>
}

interface AnalysisCacheOptions<Identity, Analysis> {
  key: (identity: Identity) => string
  isAnalysis: (value: unknown, identity: Identity) => value is Analysis
  prune?: (entries: Record<string, Analysis>) => void
}

/** Shared version-1 storage; adapters own identity, validation and eviction rules. */
export class FileAnalysisCache<Identity, Analysis> {
  private readonly cachePath: string
  private readonly options: AnalysisCacheOptions<Identity, Analysis>
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(cachePath: string, options: AnalysisCacheOptions<Identity, Analysis>) {
    this.cachePath = cachePath
    this.options = options
  }

  async get(identity: Identity): Promise<Analysis | null> {
    await this.mutationTail
    const file = await this.read()
    const result = file.entries[this.options.key(identity)]
    return this.options.isAnalysis(result, identity) ? result : null
  }

  async set(identity: Identity, analysis: Analysis): Promise<void> {
    await this.enqueueMutation(async () => {
      const file = await this.read()
      file.entries[this.options.key(identity)] = analysis
      this.options.prune?.(file.entries)
      await this.write(file)
    })
  }

  async deleteIfMatches(identity: Identity, analysis: Analysis): Promise<boolean> {
    return await this.enqueueMutation(async () => {
      const file = await this.read()
      const key = this.options.key(identity)
      if (!isDeepStrictEqual(file.entries[key], analysis)) return false
      delete file.entries[key]
      await this.write(file)
      return true
    })
  }

  async getSize(): Promise<number> {
    try {
      return (await stat(this.cachePath)).size
    } catch {
      return 0
    }
  }

  async clear(): Promise<number> {
    await rm(this.cachePath, { force: true })
    return 0
  }

  protected async countEntries(): Promise<number> {
    return Object.keys((await this.read()).entries).length
  }

  private async read(): Promise<AnalysisCacheFile<Analysis>> {
    if (existsSync(this.cachePath)) {
      try {
        const parsed = tryParseJsonWithNestingLimit(await readFile(this.cachePath, 'utf-8'))
        if (parsed.ok && isAnalysisCacheFile<Analysis>(parsed.value)) return parsed.value
      } catch {
        // Missing, corrupt or inaccessible caches remain a cache miss.
      }
    }
    return { version: 1, entries: {} }
  }

  private async write(file: AnalysisCacheFile<Analysis>): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true })
    await writeFile(this.cachePath, JSON.stringify(file), 'utf-8')
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation)
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

function isAnalysisCacheFile<Analysis>(value: unknown): value is AnalysisCacheFile<Analysis> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const file = value as Partial<AnalysisCacheFile<Analysis>>
  return (
    file.version === 1 &&
    !!file.entries &&
    typeof file.entries === 'object' &&
    !Array.isArray(file.entries)
  )
}
