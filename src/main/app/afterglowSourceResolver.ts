import { afterglowTrackPathOf, isAfterglowPlayableSource } from '../../shared/afterglowMode.ts'
import { remoteMediaGrants, type RemoteMediaGrantService } from '../security/remoteMediaGrants.ts'

export interface ResolvedAfterglowSource {
  source: string
  /** Absolute epoch ms when the provider URL expires; null when unknown. */
  expiresAt: number | null
}

export interface AfterglowSourceResolver {
  resolve(track: unknown, signal?: AbortSignal): Promise<ResolvedAfterglowSource | null>
}

export interface AfterglowSourceResolverDependencies {
  callProvider?: (
    providerId: string,
    method: 'getPlaybackUrl',
    args: unknown[],
    options: { signal: AbortSignal; playbackExpiry: true }
  ) => Promise<unknown>
  grants?: Pick<RemoteMediaGrantService, 'resolve'>
  quality?: string
  now?: () => number
}

/** SACD selectors belong to the native target, not to its filesystem grant. */
export async function authorizeAfterglowNativeSource(
  source: string,
  authorize: (source: string) => Promise<string>
): Promise<string> {
  const local = isAfterglowPlayableSource(source) && !/^https?:\/\//i.test(source)
  const iso = local
    ? /^(.*\.iso)(\?area=(?:stereo|multichannel)&track=[1-9]\d{0,8})$/i.exec(source)
    : null
  return iso ? `${await authorize(iso[1])}${iso[2]}` : await authorize(source)
}

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i
const PROVIDER_TIMEOUT_MS = 12_000
const UNKNOWN_PROVIDER_TTL_MS = 8 * 60 * 1000

export const isAfterglowSourceCurrent = (
  resolved: ResolvedAfterglowSource,
  now = Date.now()
): boolean => resolved.expiresAt === null || resolved.expiresAt > now

const providerIdOf = (track: unknown): string => {
  if (!track || typeof track !== 'object') return ''
  const record = track as Record<string, unknown>
  if (typeof record.source === 'string' && record.source.trim()) {
    return record.source.trim()
  }
  if (typeof record.id === 'string') {
    const separator = record.id.indexOf(':')
    if (separator > 0) return record.id.slice(0, separator)
  }
  return ''
}

const normalizeProviderResult = (result: unknown): ResolvedAfterglowSource | null => {
  if (typeof result === 'string') {
    return { source: result.trim(), expiresAt: null }
  }
  if (!result || typeof result !== 'object') return null
  const record = result as Record<string, unknown>
  const streamUrl = typeof record.streamUrl === 'string' ? record.streamUrl.trim() : ''
  if (!streamUrl) return null
  const providerSource =
    record.providerSource && typeof record.providerSource === 'object'
      ? (record.providerSource as Record<string, unknown>)
      : null
  const rawExpiry = providerSource?.expiresAt
  const expiresAt = typeof rawExpiry === 'number' && Number.isFinite(rawExpiry) ? rawExpiry : null
  return { source: streamUrl, expiresAt }
}

const withTimeout = <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    const finish = (settle: () => void) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      controller.signal.removeEventListener('abort', onCancelled)
      settle()
    }
    const onCancelled = () => finish(() => reject(controller.signal.reason))
    const timer = setTimeout(
      () => controller.abort(new Error('provider resolve timeout')),
      timeoutMs
    )
    timer.unref?.()
    controller.signal.addEventListener('abort', onCancelled, { once: true })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    else
      void Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted()
          return operation(controller.signal)
        })
        .then(
          (value) => finish(() => resolve(value)),
          (error) => finish(() => reject(error))
        )
  })

/**
 * Resolves a logical queue entry into a native-playable source while the renderer
 * is unloaded. Local files are used as-is; provider tracks go through the same
 * trusted `getPlaybackUrl` route the renderer uses.
 */
export const createAfterglowSourceResolver = (
  dependencies: AfterglowSourceResolverDependencies = {}
): AfterglowSourceResolver => {
  const now = dependencies.now ?? Date.now
  const injectedCallProvider = dependencies.callProvider
  return {
    async resolve(track: unknown, signal?: AbortSignal): Promise<ResolvedAfterglowSource | null> {
      if (signal?.aborted) return null
      if (!track || typeof track !== 'object') return null
      const record = track as Record<string, unknown>
      // CUE uses the physical file plus cueRange; SACD/other subtracks already
      // carry their logical native target and must not play the container.
      const localPath =
        !record.cueRange && typeof record.subTrack === 'string' && record.subTrack.trim()
          ? record.subTrack.trim()
          : afterglowTrackPathOf(track)
      if (isAfterglowPlayableSource(localPath)) {
        return { source: localPath, expiresAt: null }
      }

      const providerId = providerIdOf(track)
      if (!providerId || !PROVIDER_ID_PATTERN.test(providerId)) return null

      const options: Record<string, unknown> = {}
      if (providerId === 'ncm') {
        let quality = dependencies.quality
        if (!quality) {
          const { runtime } = await import('../core/runtime.ts')
          quality = runtime.appSettings.ncmPlaybackQuality ?? 'auto'
        }
        options.quality = quality
      }

      const callProvider =
        injectedCallProvider ??
        (async (
          targetProviderId: string,
          method: 'getPlaybackUrl',
          args: unknown[],
          callOptions: { signal: AbortSignal; playbackExpiry: true }
        ) => {
          const { runtime } = await import('../core/runtime.ts')
          if (!runtime.pluginManager) throw new Error('provider manager unavailable')
          return runtime.pluginManager.callProvider(targetProviderId, method, args, callOptions)
        })

      try {
        const result = await withTimeout(
          (signal) =>
            callProvider(providerId, 'getPlaybackUrl', [track, options], {
              signal,
              playbackExpiry: true
            }),
          PROVIDER_TIMEOUT_MS,
          signal
        )
        const normalized = normalizeProviderResult(result)
        if (!normalized || !isAfterglowSourceCurrent(normalized, now())) return null
        // Resolve only issued, unexpired audio grants. The opaque handle itself
        // is never sent to native, and image/unknown tokens remain unauthorized.
        const source = normalized.source.startsWith('twilight-media:')
          ? (dependencies.grants ?? remoteMediaGrants).resolve(normalized.source, 'audio').source
          : normalized.source
        if (!isAfterglowPlayableSource(source)) return null
        return {
          source,
          expiresAt: normalized.expiresAt ?? now() + UNKNOWN_PROVIDER_TTL_MS
        }
      } catch (error) {
        if (signal?.aborted) return null
        console.warn(
          `[afterglow] provider ${providerId} could not resolve a playback source:`,
          error instanceof Error ? error.message : String(error)
        )
        return null
      }
    }
  }
}
