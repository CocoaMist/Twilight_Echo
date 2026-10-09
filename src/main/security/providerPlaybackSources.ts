import { classifyAudioSource } from './audioSourcePolicy.ts'

export interface ProviderAudioIdentity {
  contentId: string
  quality: string
  durationSeconds: number
  seekable: true
}
export interface ProviderPlaybackSourceBinding {
  providerId: string
  pluginId: string
  args: unknown[]
  identity: ProviderAudioIdentity
}
const record = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
export function providerAudioIdentity(value: unknown): ProviderAudioIdentity | null {
  if (
    !record(value) ||
    typeof value.contentId !== 'string' ||
    !value.contentId ||
    value.contentId.length > 512 ||
    /^https?:\/\//i.test(value.contentId) ||
    typeof value.quality !== 'string' ||
    !value.quality ||
    value.quality.length > 512 ||
    typeof value.durationSeconds !== 'number' ||
    !Number.isFinite(value.durationSeconds) ||
    value.durationSeconds <= 0 ||
    value.seekable !== true
  )
    return null
  return {
    contentId: value.contentId,
    quality: value.quality,
    durationSeconds: value.durationSeconds,
    seekable: true
  }
}

/** Trusted main-process provider resolutions, not renderer-supplied URL claims. */
export class ProviderPlaybackSourceRegistry {
  private readonly entries = new Map<
    string,
    { binding: ProviderPlaybackSourceBinding; lastAccess: number }
  >()
  private readonly now: () => number
  private readonly limit: number
  private readonly ttl: number
  constructor(now: () => number = Date.now, limit = 128, ttl = 30 * 60 * 1000) {
    this.now = now
    this.limit = limit
    this.ttl = ttl
  }
  register(source: string, binding: ProviderPlaybackSourceBinding): void {
    try {
      const identity = providerAudioIdentity(binding.identity)
      if (
        classifyAudioSource(source).kind !== 'remote' ||
        source.length > 8192 ||
        !identity ||
        !binding.providerId ||
        !binding.pluginId ||
        !Array.isArray(binding.args)
      )
        return
      source = new URL(source).toString()
      const args = JSON.stringify(binding.args)
      if (Buffer.byteLength(args) > 32768) return
      this.entries.delete(source)
      this.entries.set(source, {
        binding: { ...binding, identity, args: JSON.parse(args) },
        lastAccess: this.now()
      })
      while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!)
    } catch {
      /* An optional analysis registration must never interrupt playback. */
    }
  }
  get(source: string, trackId?: string): ProviderPlaybackSourceBinding | null {
    try {
      source = new URL(source).toString()
    } catch {
      return null
    }
    const entry = this.entries.get(source)
    if (!entry) return null
    if (this.now() - entry.lastAccess > this.ttl) {
      this.entries.delete(source)
      return null
    }
    const track = entry.binding.args[0]
    if (trackId && (!record(track) || String(track.id) !== trackId)) return null
    entry.lastAccess = this.now()
    this.entries.delete(source)
    this.entries.set(source, entry)
    return structuredClone(entry.binding)
  }
  clear(): void {
    this.entries.clear()
  }
}
export const providerPlaybackSources = new ProviderPlaybackSourceRegistry()
