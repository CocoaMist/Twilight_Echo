import {
  providerAudioIdentity,
  type ProviderPlaybackSourceRegistry
} from '../security/providerPlaybackSources.ts'
import type { AutoMixOnlineSource } from './autoMixCoordinator.ts'
import type { TwilightProviderCallOptions } from '../plugins/manager.ts'

interface OnlineSourceHost {
  registry: Pick<ProviderPlaybackSourceRegistry, 'get'>
  callProvider(
    providerId: string,
    method: 'getPlaybackUrl',
    args: unknown[],
    options: TwilightProviderCallOptions
  ): Promise<unknown>
  authorize(source: string): Promise<string>
}

/** Refresh through the owning provider, then reauthorize the actual audio URL. */
export function createAutoMixOnlineResolver(host: OnlineSourceHost) {
  return async (track: { id?: string; source: string }): Promise<AutoMixOnlineSource | null> => {
    const binding = host.registry.get(track.source, track.id)
    if (!binding) return null
    const previousOptions = binding.args[1]
    const value = await host.callProvider(
      binding.providerId,
      'getPlaybackUrl',
      [
        binding.args[0],
        {
          ...(previousOptions &&
          typeof previousOptions === 'object' &&
          !Array.isArray(previousOptions)
            ? previousOptions
            : {}),
          force: true
        },
        ...binding.args.slice(2)
      ],
      { expectedPluginId: binding.pluginId, returnAutoMixSourceIdentity: true }
    )
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const envelope = value as Record<string, unknown>
    const identity = providerAudioIdentity(envelope.autoMixIdentity)
    if (
      !identity ||
      typeof envelope.streamUrl !== 'string' ||
      identity.contentId !== binding.identity.contentId ||
      identity.quality !== binding.identity.quality ||
      Math.abs(identity.durationSeconds - binding.identity.durationSeconds) >= 0.1
    )
      return null
    return {
      source: await host.authorize(envelope.streamUrl),
      contentId: JSON.stringify([binding.pluginId, binding.providerId, identity.contentId]),
      quality: identity.quality,
      durationSeconds: identity.durationSeconds
    }
  }
}
