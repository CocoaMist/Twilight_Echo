import { prepareDownloadedMetadata as prepare } from '../../core/downloads/downloadMetadata.ts'
import { fetchDownloadCover } from './downloadPlatform.ts'
export {
  detectedDownloadQuality,
  downloadLyricFiles,
  saveDownloadedLyrics
} from '../../core/downloads/downloadMetadata.ts'
export function prepareDownloadedMetadata(
  options: Parameters<typeof prepare>[0]
): ReturnType<typeof prepare> {
  return prepare({ ...options, fetchCover: options.fetchCover ?? fetchDownloadCover })
}
