import type { DownloadPreferences } from './downloadPreferences.ts'
import type { ProviderDownloadQuality, ProviderDownloadTrackInput } from './providerDownloads.ts'

/** Private analysis-service request: local temporary files only; no network authority. */
export interface DownloadMetadataRequest {
  targetPath: string
  track: Pick<ProviderDownloadTrackInput, 'id' | 'title' | 'artist' | 'album' | 'cover'>
  preferences: DownloadPreferences
  lyrics: { lyrics?: string; translatedLyrics?: string; wordLyrics?: string }
  lyricFailure: boolean
  cover: { base64: string; mime: string } | null
  coverFailure: boolean
}
export interface DownloadMetadataResult {
  actualQuality: ProviderDownloadQuality | null
  warning: string | null
  lyrics: Array<{ suffix: string; text: string }>
}
