import type { CorePlayerPresentation } from '../../shared/coreSystemPlayer.ts'

export interface ArtworkPlatform {
  normalizeCachedCover(handle: string): Promise<string>
  migrateBase64Cover(data: string): string | null
  grant(source: string, expiresAt?: number): string
  resolve(handle: string): { source: string; expiresAt?: number }
  retainMetadata?(source: string, signal: AbortSignal): Promise<void>
}

/** Re-issue session grants here; presentation clients never receive durable CDN URLs. */
export function createArtworkProjection(platform: ArtworkPlatform) {
  return async (
    input: {
      cover: string | null
      coverSource: string | null
      imageExpiresAt?: number
      retainMetadata?: boolean
    },
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
      cover = platform.grant(input.coverSource!, input.imageExpiresAt)
    } else if (/^https?:\/\//i.test(handle ?? '')) {
      cover = platform.grant(handle!, input.imageExpiresAt)
    } else if (handle?.startsWith('twilight-media://image/')) {
      const original = platform.resolve(handle)
      const deadlines = [original.expiresAt, input.imageExpiresAt].filter(
        (v): v is number => v !== undefined
      )
      cover = platform.grant(original.source, deadlines.length ? Math.min(...deadlines) : undefined)
    }
    signal.throwIfAborted()
    if (
      input.retainMetadata &&
      cover?.startsWith('twilight-media://image/') &&
      platform.retainMetadata
    ) {
      const original = platform.resolve(cover)
      if (original.expiresAt === undefined && input.imageExpiresAt === undefined) {
        try {
          await platform.retainMetadata(original.source, signal)
        } catch {
          // A disk/network failure must not discard an otherwise usable grant.
          signal.throwIfAborted()
        }
      }
    }
    signal.throwIfAborted()
    return { cover, coverSource: null }
  }
}
