import type { LibraryDatabaseApi } from '../../../../shared/libraryDatabase.ts'
import type { LibraryMetadataEnrichmentTrackUpdate } from '../../utils/libraryMetadataEnrichment.ts'

const fields = [
  'artist',
  'album',
  'genre',
  'cover',
  'lyrics',
  'translatedLyrics',
  'lyricsSource',
  'translatedLyricsSource',
  'metadataMatch'
] as const

const equal = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

/** Provider work can outlive a scan/edit. Compare its source with the authority,
 * then use that record's version to fence changes after this read. */
export async function patchLibraryMetadata(
  api: Pick<LibraryDatabaseApi, 'getTracksByIds' | 'patchTracks'>,
  update: LibraryMetadataEnrichmentTrackUpdate,
  isCurrent: () => boolean
) {
  if (!isCurrent()) return null
  const patch: Record<string, unknown> = {}
  for (const field of fields) {
    if (!equal(update.source[field], update.track[field]) && update.track[field] !== undefined)
      patch[field] = update.track[field]
  }
  if (!Object.keys(patch).length) return null
  const page = await api.getTracksByIds([update.source.id])
  const current = page.tracks[0]
  if (!isCurrent() || !current || current.id !== update.source.id) return null
  for (const field of [
    'filePath',
    'title',
    'artist',
    'album',
    'duration',
    'cueRange',
    ...Object.keys(patch)
  ]) {
    if (!equal(current[field], update.source[field as keyof typeof update.source])) return null
  }
  return api.patchTracks([
    {
      id: current.id,
      expectedVersion: page.versions[current.id],
      patch
    }
  ])
}
