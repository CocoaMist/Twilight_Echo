import type { prepareDownloadedMetadata } from './downloadMetadata.ts'
import type {
  DownloadMetadataRequest,
  DownloadMetadataResult
} from '../../shared/coreDownloadMetadata.ts'

/** Fetches with Core's provider/image authority, then isolates parsing and tag writes. */
export function createDownloadMetadataPreparation(
  run: (
    partPath: string,
    request: DownloadMetadataRequest,
    signal: AbortSignal
  ) => Promise<DownloadMetadataResult>
): typeof prepareDownloadedMetadata {
  return async (options) => {
    const { track, preferences, signal } = options
    const request: DownloadMetadataRequest = {
      targetPath: options.targetPath,
      track: {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        cover: track.cover
      },
      preferences,
      lyrics: {},
      lyricFailure: false,
      cover: null,
      coverFailure: false
    }
    if (preferences.saveLyrics || preferences.embedMetadata) {
      try {
        const raw = (await options.getLyrics()) as Record<string, unknown> | null
        for (const key of ['lyrics', 'translatedLyrics', 'wordLyrics'] as const) {
          if (typeof raw?.[key] === 'string' && Buffer.byteLength(raw[key]) <= 1024 * 1024)
            request.lyrics[key] = raw[key]
        }
      } catch {
        signal.throwIfAborted()
        request.lyricFailure = true
      }
    }
    if (preferences.embedMetadata && track.cover?.startsWith('twilight-media://image/')) {
      try {
        const cover = await options.fetchCover?.(track.cover, signal)
        if (cover)
          request.cover = { base64: Buffer.from(cover.bytes).toString('base64'), mime: cover.mime }
      } catch {
        signal.throwIfAborted()
        request.coverFailure = true
      }
    }
    signal.throwIfAborted()
    return run(options.partPath, request, signal)
  }
}
