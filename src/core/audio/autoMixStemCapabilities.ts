import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AutoMixStemCapabilities, AutoMixStemDevice } from '../../shared/twilightAutoMix.ts'
import { STEM_CHECKPOINT_SHA256, STEM_MODEL_VERSION } from './autoMixStemService.ts'

export interface StemRuntimeProbe {
  cpu: boolean
  gpu: boolean
  gpuName?: string
}

export type StemRuntimeProbeFunction = (
  directory: string,
  workerDirectory: string
) => Promise<StemRuntimeProbe>

const PACK_FILES = [
  'manifest.json',
  'model.lock.json',
  'runtime/python.exe',
  'models/955717e8-8726e21a.th'
]

export class AutoMixStemDetector {
  private cached?: { key: string; result: Promise<AutoMixStemCapabilities>; pending: boolean }
  private candidates: () => string[]
  private workerDirectory: () => string
  private probe: StemRuntimeProbeFunction
  constructor(
    candidates: () => string[],
    workerDirectory: () => string,
    probe: StemRuntimeProbeFunction
  ) {
    this.candidates = candidates
    this.workerDirectory = workerDirectory
    this.probe = probe
  }

  get(refresh = false): Promise<AutoMixStemCapabilities> {
    const directories = [...new Set(this.candidates().map((path) => resolve(path)))]
    const key = JSON.stringify(
      directories.map((directory) => [
        directory,
        ...PACK_FILES.map((name) => {
          try {
            const stat = statSync(join(directory, name))
            return [stat.size, stat.mtimeMs]
          } catch {
            return null
          }
        })
      ])
    )
    if (this.cached?.key === key && (!refresh || this.cached.pending)) return this.cached.result
    const entry = { key, result: this.detect(directories), pending: true }
    this.cached = entry
    void entry.result.finally(() => {
      entry.pending = false
    })
    return entry.result
  }

  async resolveDevice(device: AutoMixStemDevice): Promise<string | null> {
    const result = await this.get()
    const pack =
      device === 'cpu'
        ? result.packs.find((item) => item.cpu)
        : (result.packs.find((item) => item.gpu) ??
          (device === 'auto' ? result.packs.find((item) => item.cpu) : undefined))
    return pack?.directory ?? null
  }

  private async detect(directories: string[]): Promise<AutoMixStemCapabilities> {
    const packs: AutoMixStemCapabilities['packs'] = []
    let installed = false
    let reason: AutoMixStemCapabilities['reason']
    for (const directory of directories) {
      if (!existsSync(directory)) continue
      installed = true
      try {
        if (!PACK_FILES.every((name) => existsSync(join(directory, name))))
          throw new Error('pack_invalid')
        const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
        const lock = JSON.parse(await readFile(join(directory, 'model.lock.json'), 'utf8'))
        if (
          manifest.modelVersion !== STEM_MODEL_VERSION ||
          lock.modelVersion !== STEM_MODEL_VERSION ||
          manifest.checkpointSha256 !== STEM_CHECKPOINT_SHA256 ||
          lock.checkpointSha256 !== STEM_CHECKPOINT_SHA256
        )
          throw new Error('pack_invalid')
        const capabilities = await this.probe(directory, this.workerDirectory())
        if (capabilities.cpu) packs.push({ directory, ...capabilities })
        else reason = 'runtime_unavailable'
      } catch (error) {
        reason =
          error instanceof Error && error.message === 'probe_timeout'
            ? 'probe_timeout'
            : error instanceof Error && error.message === 'runtime_unavailable'
              ? 'runtime_unavailable'
              : 'pack_invalid'
      }
    }
    return {
      status: packs.length ? 'ready' : installed ? 'unavailable' : 'missing',
      cpu: packs.some((pack) => pack.cpu),
      gpu: packs.some((pack) => pack.gpu),
      packs,
      ...(packs.length ? {} : { reason })
    }
  }
}
