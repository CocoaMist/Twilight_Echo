import { runtime } from '../core/runtime'
import { getCoverCacheDir, resizeCoverImageBytes } from '../library/coverCache.ts'
import { createRemoteCoverCache } from './remoteCoverCache.ts'

/** Protocol requests and Core maintenance must use the same writer lifetime. */
export const mediaCoverCache = createRemoteCoverCache(
  () => (runtime.appSettings.cachePolicy.cover ? getCoverCacheDir() : null),
  { resize: resizeCoverImageBytes }
)
