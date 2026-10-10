import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, stat, unlink, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AUTO_MIX_ANALYSIS_VERSION,
  isAutoMixAnalysisResult,
  type AutoMixFeatures
} from '../../shared/autoMix.ts'

export interface AutoMixCacheIdentity {
  /** Durable content identity; online identity must survive a refreshed signed URL. */
  contentId: string
  quality: string
  analysisVersion: typeof AUTO_MIX_ANALYSIS_VERSION
  beatThisHash: string
  yamnetHash: string
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const identityKey = (id: AutoMixCacheIdentity): string =>
  hash(
    JSON.stringify([id.contentId, id.quality, id.analysisVersion, id.beatThisHash, id.yamnetHash])
  )
const ENTRY_LIMIT = 512 * 1024
const DISK_LIMIT = 512 * 1024 * 1024
const HOT_LIMIT = 16 * 1024 * 1024
// Conservative UTF-16 storage plus per-entry Map/key overhead. Disk accounting
// remains UTF-8; a numeric JSON string must not use half the intended heap cap.
const residentBytes = (text: string): number => text.length * 2 + 512

export class AutoMixFeatureCache {
  private readonly hot = new Map<string, string>()
  private hotBytes = 0
  private pendingBytes = 0
  private writes: Promise<void> = Promise.resolve()
  private readonly directory: string
  private readonly diskLimit: number
  private readonly hotLimit: number
  constructor(directory: string, diskLimit = DISK_LIMIT, hotLimit = HOT_LIMIT) {
    this.directory = directory
    this.diskLimit = diskLimit
    this.hotLimit = hotLimit
  }

  private remember(key: string, payload: string): void {
    const existing = this.hot.get(key)
    if (existing !== undefined) this.hotBytes -= residentBytes(existing)
    this.hot.delete(key)
    const bytes = residentBytes(payload)
    const limit = Math.max(0, this.hotLimit - this.pendingBytes)
    if (bytes > limit) return
    this.hot.set(key, payload)
    this.hotBytes += bytes
    while (this.hotBytes > limit) {
      const first = this.hot.entries().next().value
      if (!first) break
      this.hot.delete(first[0])
      this.hotBytes -= residentBytes(first[1])
    }
  }

  async get(identity: AutoMixCacheIdentity): Promise<AutoMixFeatures | null> {
    const key = identityKey(identity)
    const cached = this.hot.get(key)
    if (cached !== undefined) {
      this.remember(key, cached)
      return JSON.parse(cached) as AutoMixFeatures
    }
    const path = join(this.directory, `${key}.amfx`)
    try {
      const size = (await stat(path)).size
      if (size > ENTRY_LIMIT || size <= 0) return null
      const raw = await readFile(path, 'utf8')
      if (Buffer.byteLength(raw) > ENTRY_LIMIT) return null
      const entry = JSON.parse(raw) as {
        format?: unknown
        key?: unknown
        checksum?: unknown
        payload?: unknown
      }
      if (
        entry.format !== 1 ||
        entry.key !== key ||
        typeof entry.payload !== 'string' ||
        entry.checksum !== hash(entry.payload)
      )
        return null
      const features: unknown = JSON.parse(entry.payload)
      if (
        !isAutoMixAnalysisResult(features) ||
        !features.available ||
        features.analysisVersion !== identity.analysisVersion ||
        features.modelHashes.beatThis !== identity.beatThisHash ||
        features.modelHashes.yamnet !== identity.yamnetHash
      )
        return null
      this.remember(key, entry.payload)
      const now = new Date()
      void utimes(path, now, now).catch(() => {})
      return features
    } catch {
      return null
    }
  }

  put(identity: AutoMixCacheIdentity, features: AutoMixFeatures): Promise<void> {
    if (
      !isAutoMixAnalysisResult(features) ||
      !features.available ||
      features.analysisVersion !== identity.analysisVersion ||
      features.modelHashes.beatThis !== identity.beatThisHash ||
      features.modelHashes.yamnet !== identity.yamnetHash ||
      !identity.contentId ||
      /^https?:\/\//i.test(identity.contentId)
    ) {
      return Promise.reject(new Error('Invalid AutoMix feature cache identity or payload'))
    }
    const key = identityKey(identity)
    const payload = JSON.stringify(features)
    const entry = JSON.stringify({ format: 1, key, checksum: hash(payload), payload })
    if (Buffer.byteLength(entry) > ENTRY_LIMIT || Buffer.byteLength(entry) > this.diskLimit)
      return Promise.reject(new Error('AutoMix feature cache entry exceeds limit'))
    const resident = residentBytes(entry) + residentBytes(payload) + Buffer.byteLength(entry)
    if (resident > this.hotLimit - this.pendingBytes)
      return Promise.reject(new Error('AutoMix pending cache writes exceed memory limit'))
    this.pendingBytes += resident
    while (this.hotBytes > this.hotLimit - this.pendingBytes) {
      const first = this.hot.entries().next().value
      if (!first) break
      this.hot.delete(first[0])
      this.hotBytes -= residentBytes(first[1])
    }
    const write = this.writes
      .then(async () => {
        await mkdir(this.directory, { recursive: true })
        const temporary = join(this.directory, `${key}.${randomUUID()}.tmp`)
        try {
          const file = await open(temporary, 'wx')
          try {
            await file.writeFile(entry, 'utf8')
            await file.sync()
          } finally {
            await file.close()
          }
          await rename(temporary, join(this.directory, `${key}.amfx`))
          await this.evict()
        } finally {
          await unlink(temporary).catch(() => {})
        }
      })
      .finally(() => {
        this.pendingBytes -= resident
      })
      .then(() => {
        this.remember(key, payload)
      })
    this.writes = write.catch(() => {})
    return write
  }

  private async evict(): Promise<void> {
    const entries = await Promise.all(
      (await readdir(this.directory))
        .filter((name) => /^[a-f0-9]{64}\.amfx$/.test(name))
        .map(async (name) => {
          const info = await stat(join(this.directory, name))
          return { name, bytes: info.size, modified: info.mtimeMs }
        })
    )
    let total = entries.reduce((sum, file) => sum + file.bytes, 0)
    for (const file of entries.sort(
      (a, b) => a.modified - b.modified || a.name.localeCompare(b.name)
    )) {
      if (total <= this.diskLimit) break
      await unlink(join(this.directory, file.name))
      total -= file.bytes
      const key = file.name.slice(0, 64),
        payload = this.hot.get(key)
      if (payload !== undefined) {
        this.hotBytes -= residentBytes(payload)
        this.hot.delete(key)
      }
    }
  }
}
