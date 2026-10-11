import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile, open, readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { AutoMixSelection } from '../../shared/twilightAutoMix.ts'
import { normalizeAutoMixStemCacheMiB } from '../../shared/twilightAutoMix.ts'

// A bounded read on one handle binds the digest and length to the same file.
export async function validateStemMaterial(
  path: string,
  length: number,
  digest: string,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const file = await open(path, 'r')
  try {
    if ((await file.stat()).size !== length) throw new Error('material_digest_mismatch')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(256 * 1024)
    let total = 0
    for (;;) {
      signal.throwIfAborted()
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      total += bytesRead
      if (total > length) throw new Error('material_digest_mismatch')
      hash.update(buffer.subarray(0, bytesRead))
    }
    signal.throwIfAborted()
    if (total !== length || hash.digest('hex') !== digest)
      throw new Error('material_digest_mismatch')
  } finally {
    await file.close()
  }
}

export const STEM_CHECKPOINT_SHA256 =
  '8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4'
export const STEM_MODEL_VERSION = 'demucs-4.0.1:955717e8'
export function stemBudgetMs(selectionStart: number, position: number): number {
  return Math.max(0, Math.min(90_000, (selectionStart - position - 2) * 1000 - 20_000))
}
export function findAutoMixStemPack(candidates: string[]): string | null {
  for (const directory of candidates) {
    if (
      ['manifest.json', 'model.lock.json', 'worker.py', 'runtime/python.exe'].every((p) =>
        existsSync(join(directory, p))
      )
    )
      return resolve(directory)
  }
  return null
}
export class AutoMixStemService {
  private busy = false
  private directories = new Set<string>()
  private cacheDirectory: string
  private pack: () => string | null
  private enabled: () => boolean
  private reportResources?: (resources: Record<string, unknown>) => void
  private cacheMiB: () => unknown
  constructor(
    cacheDirectory: string,
    pack: () => string | null,
    enabled: () => boolean,
    reportResources?: (resources: Record<string, unknown>) => void,
    cacheMiB: () => unknown = () => 512
  ) {
    this.cacheDirectory = cacheDirectory
    this.pack = pack
    this.enabled = enabled
    this.reportResources = reportResources
    this.cacheMiB = cacheMiB
  }
  async select(
    request: string,
    select: (request: string) => Promise<AutoMixSelection>
  ): Promise<AutoMixSelection> {
    if (!this.enabled() || !this.pack()) return select(request)
    const directory = await mkdtemp(join(tmpdir(), 'twilight-automix-material-'))
    this.directories.add(directory)
    let result: AutoMixSelection
    try {
      result = await select(
        JSON.stringify({ ...JSON.parse(request), materialDirectory: directory })
      )
    } catch (error) {
      await this.release({ ok: false, stemDirectory: directory })
      throw error
    }
    if (!result.ok && /^material_export_/.test(result.reason ?? '')) {
      await this.release({ ok: false, stemDirectory: directory })
      return select(request)
    }
    if (!result.stemDirectory) await this.release({ ok: false, stemDirectory: directory })
    return result
  }
  async prepare(
    selection: AutoMixSelection,
    position: () => number,
    signal: AbortSignal
  ): Promise<Record<string, unknown> | null> {
    const pack = this.pack()
    if (
      !this.enabled() ||
      !pack ||
      !selection.stemDirectory ||
      !selection.inputs ||
      selection.channels! > 2
    )
      return null
    if (this.busy) throw new Error('stem_worker_busy')
    const budget = stemBudgetMs(selection.currentStartSeconds ?? 0, position())
    if (budget < 1000) throw new Error('stem_budget_exhausted')
    signal.throwIfAborted()
    this.busy = true
    let completed = false
    try {
      const directory = resolve(selection.stemDirectory)
      if (!this.directories.has(directory)) throw new Error('invalid_material_ticket')
      const manifest = JSON.parse(await readFile(join(pack, 'manifest.json'), 'utf8'))
      const lock = JSON.parse(await readFile(join(pack, 'model.lock.json'), 'utf8'))
      if (
        manifest.modelVersion !== STEM_MODEL_VERSION ||
        manifest.checkpointSha256 !== lock.checkpointSha256 ||
        lock.checkpointSha256 !== STEM_CHECKPOINT_SHA256 ||
        !/^[a-f0-9]{64}$/.test(lock.checkpointSha256)
      )
        throw new Error('model_manifest_mismatch')
      await mkdir(this.cacheDirectory, { recursive: true })
      // A reusable selection can be retried; a crashed new worker must never
      // authenticate a previous run's result under the same selection ID.
      for (const name of ['result.json', 'current-mixed.f32', 'next-mixed.f32'])
        await rm(join(directory, name), { force: true })
      const request = join(directory, 'request.json')
      await writeFile(
        request,
        JSON.stringify({
          selection,
          cacheDirectory: this.cacheDirectory,
          cacheBudgetBytes: normalizeAutoMixStemCacheMiB(this.cacheMiB()) * 1024 ** 2
        }),
        'utf8'
      )
      await new Promise<void>((resolveTask, reject) => {
        const child = spawn(
          join(pack, 'runtime', 'python.exe'),
          [join(pack, 'worker.py'), request],
          {
            cwd: pack,
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe'],
            env: {
              ...process.env,
              PYTHONNOUSERSITE: '1',
              PYTHONUTF8: '1',
              PYTHONDONTWRITEBYTECODE: '1',
              OPENBLAS_NUM_THREADS: '1'
            }
          }
        )
        let settled = false
        let pendingError: Error | undefined
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal.removeEventListener('abort', cancel)
          if (error) {
            reject(error)
          } else resolveTask()
        }
        const stop = (error: Error) => {
          pendingError ??= error
          // close fires only after the worker exits and its pipes close. Keep
          // busy/material ownership until then; cleanup cannot race the worker.
          child.kill()
        }
        const cancel = () => stop(new Error('stems_cancelled'))
        const timer = setTimeout(() => stop(new Error('stem_timeout')), budget)
        child.stderr?.on('data', () => {})
        child.on('error', () => finish(new Error('stem_worker_unavailable')))
        child.on('close', (code) =>
          finish(
            pendingError ??
              (code !== 0 && !existsSync(join(directory, 'result.json'))
                ? new Error('stem_worker_exited')
                : undefined)
          )
        )
        signal.addEventListener('abort', cancel, { once: true })
        if (signal.aborted) cancel()
      })
      signal.throwIfAborted()
      const text = await readFile(join(directory, 'result.json'), 'utf8')
      if (Buffer.byteLength(text) > 64 * 1024) throw new Error('invalid_material_ticket')
      const result = JSON.parse(text)
      if (!result.ok) {
        this.reportResources?.({ ...(result.resources ?? {}), reason: result.reason })
        throw new Error(/^[a-z_]{1,80}$/.test(result.reason) ? result.reason : 'stem_worker_failed')
      }
      if (
        result.stemMaterials?.selectionId !== selection.selectionId ||
        result.stemMaterials?.version !== 2 ||
        result.stemMaterials?.modelVersion !== STEM_MODEL_VERSION
      )
        throw new Error('invalid_material_ticket')
      for (const [deck, prefix] of ['current', 'next'].entries()) {
        const material = result.stemMaterials[prefix],
          original = selection.inputs[deck]
        if (
          material?.sourceIdentity !== original.sourceIdentity ||
          material?.origin !== original.origin ||
          material?.frames !== original.frames ||
          resolve(material?.path ?? '') !== join(directory, `${prefix}-mixed.f32`)
        )
          throw new Error('invalid_material_ticket')
        await validateStemMaterial(
          material.path,
          original.frames * selection.channels! * 4,
          material.sha256,
          signal
        )
      }
      this.reportResources?.(result.resources ?? {})
      completed = true
      return { stemMaterials: result.stemMaterials }
    } finally {
      // Worker termination was awaited above. Only remove controlled outputs
      // and worker-owned temporary cache writes; native inputs remain reusable.
      const directory = resolve(selection.stemDirectory)
      if (this.directories.has(directory) && !completed) {
        for (const name of ['current-mixed.f32', 'next-mixed.f32', 'result.json', 'request.json'])
          await rm(join(directory, name), { force: true }).catch(() => {})
      }
      for (const name of await readdir(this.cacheDirectory).catch(() => [] as string[]))
        if (/^[a-f0-9]{64}(?:\.json)?\.tmp$/.test(name))
          await rm(join(this.cacheDirectory, name), { force: true }).catch(() => {})
      this.busy = false
    }
  }
  async release(selection?: AutoMixSelection): Promise<void> {
    if (!selection?.stemDirectory) return
    const directory = resolve(selection.stemDirectory)
    if (
      !this.directories.has(directory) ||
      dirname(directory) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('twilight-automix-material-')
    )
      return
    this.directories.delete(directory)
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}
