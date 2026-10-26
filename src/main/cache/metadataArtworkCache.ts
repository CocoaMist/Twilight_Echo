import { join } from 'node:path'
import { createRemoteCoverCache, type RemoteCoverResizer } from './remoteCoverCache.ts'
import {
  createRemoteMediaRequestHandler,
  RemoteMediaGrantService
} from '../security/remoteMediaGrants.ts'

/** Only Core-approved, non-expiring metadata images enter this store. Every
 * display still needs a fresh Core projection and a valid media grant. */
export function createMetadataArtworkCache(
  directory: () => string | null,
  options: { resize?: RemoteCoverResizer; fetch: typeof globalThis.fetch }
) {
  const cache = createRemoteCoverCache(
    () => {
      const root = directory()
      return root ? join(root, 'metadata-artwork') : null
    },
    { resize: options.resize, maxAgeMs: Infinity }
  )
  const grants = new RemoteMediaGrantService()
  const handler = createRemoteMediaRequestHandler({
    grants,
    imageCache: cache,
    fetch: options.fetch
  })
  return {
    ...cache,
    async retain(source: string, signal: AbortSignal) {
      if (!directory()) return
      // The shared handler enforces redirects, content type, size and no-store.
      const response = await handler(new Request(grants.grant(source, 'image'), { signal }))
      await response.body?.cancel()
      signal.throwIfAborted()
    }
  }
}
