import type { CorePlayerPresentation } from '../../shared/coreSystemPlayer.ts'

export interface ArtworkPlatform {
  normalizeCachedCover(handle: string): Promise<string>
  migrateBase64Cover(data: string): string | null
  grant(source: string): string
  resolve(handle: string): { source: string }
}

/** Re-issue session grants here; presentation clients never receive durable CDN URLs. */
export function createArtworkProjection(platform: ArtworkPlatform) {
  return async (
    input: { cover: string | null; coverSource: string | null },
    signal: AbortSignal
  ): Promise<Pick<CorePlayerPresentation, 'cover' | 'coverSource'>> => {
    signal.throwIfAborted()
    const handle = input.cover?.trim()
    let cover: string | null = null
    if (handle?.startsWith('cover://')) {
      cover = await platform.normalizeCachedCover(handle.split(/[?#]/, 1)[0])
    } else if (handle?.startsWith('data:image/')) {
      cover = platform.migrateBase64Cover(handle)
    } else if (/^https?:\/\//i.test(input.coverSource ?? '')) {
      cover = platform.grant(input.coverSource!)
    } else if (/^https?:\/\//i.test(handle ?? '')) {
      cover = platform.grant(handle!)
    } else if (handle?.startsWith('twilight-media://image/')) {
      cover = platform.grant(platform.resolve(handle).source)
    }
    signal.throwIfAborted()
    return { cover, coverSource: null }
  }
}
