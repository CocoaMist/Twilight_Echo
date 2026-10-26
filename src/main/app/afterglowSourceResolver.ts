import {
  createSourceResolver,
  type SourceResolverDependencies
} from '../../core/playback/sourceResolver.ts'
import { remoteMediaGrants } from '../security/remoteMediaGrants.ts'
import { afterglowTrackPathOf, isAfterglowPlayableSource } from '../../shared/afterglowMode.ts'
export {
  authorizeNativeSource as authorizeAfterglowNativeSource,
  isSourceCurrent as isAfterglowSourceCurrent
} from '../../core/playback/sourceResolver.ts'
export type {
  SourceResolver as AfterglowSourceResolver,
  ResolvedSource as ResolvedAfterglowSource,
  SourceResolverDependencies as AfterglowSourceResolverDependencies
} from '../../core/playback/sourceResolver.ts'

/** Compatibility platform composition until Afterglow's ownership handoff is removed. */
export function createAfterglowSourceResolver(dependencies: SourceResolverDependencies = {}) {
  return createSourceResolver({
    reuseResolvedProviderPaths: true,
    ...dependencies,
    // The staged Core resolves current network identity. Until cutover, the
    // existing Afterglow contract accepts the renderer's already-resolved path.
    resolveNetwork:
      dependencies.resolveNetwork ??
      (async (track) => {
        const source = afterglowTrackPathOf(track)
        return isAfterglowPlayableSource(source) ? { source, expiresAt: null } : null
      }),
    grants: dependencies.grants ?? remoteMediaGrants,
    quality: dependencies.quality,
    callProvider:
      dependencies.callProvider ??
      (async (id, method, args, options) => {
        const { runtime } = await import('../core/runtime.ts')
        if (!runtime.pluginManager) throw new Error('provider manager unavailable')
        // Resolve the current preference at invocation time, not module import.
        if (id === 'ncm' && !dependencies.quality)
          args = [
            args[0],
            { ...(args[1] as object), quality: runtime.appSettings.ncmPlaybackQuality ?? 'auto' }
          ]
        return runtime.pluginManager.callProvider(id, method, args, options)
      })
  })
}
