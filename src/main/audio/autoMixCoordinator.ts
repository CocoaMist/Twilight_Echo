import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  AUTO_MIX_MODEL_HASHES,
  AUTO_MIX_ANALYSIS_VERSION,
  type AutoMixAnalysisResult,
  type AutoMixFeatures,
  type AutoMixStatus
} from '../../shared/autoMix.ts'
import { AutoMixFeatureCache, type AutoMixCacheIdentity } from './autoMixFeatureCache.ts'

interface Track {
  id?: string
  source: string
}
interface PreparedFeatures {
  features: AutoMixFeatures
  preparationSource?: string
  onlineIdentity?: AutoMixOnlineSource
}
export interface AutoMixOnlineSource {
  source: string
  contentId: string
  quality: string
  durationSeconds: number
}
export interface AutoMixPairSnapshot {
  queueToken: string
  outgoing: Track
  incoming: Track
  status: AutoMixStatus
}
export interface AutoMixCoordinatorHost {
  snapshot(): Promise<AutoMixPairSnapshot | null>
  analyze(source: string, options: string): Promise<AutoMixAnalysisResult>
  deliver(json: string): Promise<void>
  resolveOnline?(track: Track): Promise<AutoMixOnlineSource | null>
}

/** One sequential analysis owner. Playback never waits for this task. */
export class AutoMixCoordinator {
  private busy = false
  private destroyed = false
  private attempted = ''
  private readonly host: AutoMixCoordinatorHost
  private readonly cache: Pick<AutoMixFeatureCache, 'get' | 'put'>
  constructor(host: AutoMixCoordinatorHost, cache: Pick<AutoMixFeatureCache, 'get' | 'put'>) {
    this.host = host
    this.cache = cache
  }
  destroy(): void {
    this.destroyed = true
  }
  async update(): Promise<void> {
    if (this.destroyed || this.busy) return
    this.busy = true
    try {
      const pair = await this.host.snapshot()
      if (
        !pair?.status.enabled ||
        pair.status.featuresDelivered ||
        pair.status.state === 'mixing' ||
        !Number.isSafeInteger(pair.status.pairRevision)
      )
        return
      const key = this.key(pair)
      if (key === this.attempted) return
      this.attempted = key
      const outgoing = await this.features(pair.outgoing, 'tail')
      if (!outgoing || !(await this.current(key))) return
      const incoming = await this.features(pair.incoming, 'head')
      if (!incoming || !(await this.current(key))) return
      // The other track's analysis may outlive a short signed URL. Refresh both
      // again at delivery, preserving the feature's actual content and quality.
      if (
        !(await this.refreshPreparation(pair.outgoing, outgoing)) ||
        !(await this.refreshPreparation(pair.incoming, incoming)) ||
        !(await this.current(key))
      )
        return
      await this.host.deliver(
        JSON.stringify({
          pairRevision: pair.status.pairRevision,
          outgoing: {
            ...pair.outgoing,
            id: pair.outgoing.id ?? '',
            features: outgoing.features,
            preparationSource: outgoing.preparationSource
          },
          incoming: {
            ...pair.incoming,
            id: pair.incoming.id ?? '',
            features: incoming.features,
            preparationSource: incoming.preparationSource
          }
        })
      )
    } catch {
      // Decode, model, cache and deadline failures retain the native conservative
      // plan. The pair is attempted once; a new pair/config/seek gets a new key.
    } finally {
      this.busy = false
    }
  }
  private key(pair: AutoMixPairSnapshot): string {
    return JSON.stringify([
      pair.queueToken,
      pair.status.configRevision,
      pair.status.pairRevision,
      pair.outgoing.id,
      pair.outgoing.source,
      pair.incoming.id,
      pair.incoming.source
    ])
  }
  private async current(key: string): Promise<boolean> {
    if (this.destroyed) return false
    const now = await this.host.snapshot()
    return !!now?.status.enabled && now.status.state !== 'mixing' && this.key(now) === key
  }
  private async features(track: Track, segment: 'head' | 'tail'): Promise<PreparedFeatures | null> {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(track.source)) {
      const resolved = await this.host.resolveOnline?.(track)
      if (!resolved) return null
      const identity: AutoMixCacheIdentity = {
        contentId: resolved.contentId,
        quality: resolved.quality,
        analysisVersion: AUTO_MIX_ANALYSIS_VERSION,
        beatThisHash: AUTO_MIX_MODEL_HASHES.beatThis,
        yamnetHash: AUTO_MIX_MODEL_HASHES.yamnet
      }
      const cached = await this.cache.get(identity)
      if (
        cached?.windows[segment] &&
        Math.abs(cached.durationSeconds - resolved.durationSeconds) < 0.1
      )
        return { features: cached, preparationSource: resolved.source, onlineIdentity: resolved }
      const result = await this.host.analyze(resolved.source, JSON.stringify({ segment }))
      if (
        !result.available ||
        !result.windows[segment] ||
        Math.abs(result.durationSeconds - resolved.durationSeconds) >= 0.1
      )
        return null
      const refreshed = await this.host.resolveOnline?.(track)
      if (
        !refreshed ||
        refreshed.contentId !== resolved.contentId ||
        refreshed.quality !== resolved.quality ||
        Math.abs(refreshed.durationSeconds - result.durationSeconds) >= 0.1
      )
        return null
      const features = { ...result, windows: { ...(cached?.windows ?? {}), ...result.windows } }
      await this.cache.put(identity, features)
      return { features, preparationSource: refreshed.source, onlineIdentity: refreshed }
    }
    const source = resolve(track.source)
    const before = await stat(source)
    if (!before.isFile()) return null
    const identity: AutoMixCacheIdentity = {
      contentId: JSON.stringify([
        process.platform === 'win32' ? source.toLowerCase() : source,
        before.size,
        before.mtimeMs,
        before.birthtimeMs
      ]),
      quality: 'original-file',
      analysisVersion: AUTO_MIX_ANALYSIS_VERSION,
      beatThisHash: AUTO_MIX_MODEL_HASHES.beatThis,
      yamnetHash: AUTO_MIX_MODEL_HASHES.yamnet
    }
    const cached = await this.cache.get(identity)
    if (cached?.windows[segment]) return { features: cached }
    const features = await this.host.analyze(source, JSON.stringify({ segment }))
    if (!features.available || !features.windows[segment]) return null
    const after = await stat(source)
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.birthtimeMs !== before.birthtimeMs
    )
      return null
    const merged = { ...features, windows: { ...(cached?.windows ?? {}), ...features.windows } }
    await this.cache.put(identity, merged)
    return { features: merged }
  }
  private async refreshPreparation(track: Track, prepared: PreparedFeatures): Promise<boolean> {
    if (!prepared.onlineIdentity) return true
    const refreshed = await this.host.resolveOnline?.(track)
    if (
      !refreshed ||
      refreshed.contentId !== prepared.onlineIdentity.contentId ||
      refreshed.quality !== prepared.onlineIdentity.quality ||
      Math.abs(refreshed.durationSeconds - prepared.features.durationSeconds) >= 0.1
    )
      return false
    prepared.preparationSource = refreshed.source
    return true
  }
}
