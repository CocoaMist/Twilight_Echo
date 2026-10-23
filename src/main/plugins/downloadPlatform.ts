import { createRemoteMediaRequestHandler } from '../security/remoteMediaGrants.ts'
import type { FetchDownloadCover } from '../../core/downloads/downloadMetadata.ts'

/** Resolve only an already-granted image handle through the existing media policy. */
export const fetchDownloadCover: FetchDownloadCover = async (handle, signal) => {
  if (!handle.startsWith('twilight-media://image/'))
    throw new Error('Invalid download cover handle')
  const response = await createRemoteMediaRequestHandler({ fetch: globalThis.fetch })(
    new Request(handle, { signal })
  )
  const mime = response.headers.get('content-type')?.split(';')[0] ?? ''
  if (!response.ok || !['image/jpeg', 'image/png'].includes(mime)) {
    await response.body?.cancel()
    return null
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  return bytes.length <= 8 * 1024 * 1024 ? { bytes, mime } : null
}
