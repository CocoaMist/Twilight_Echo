import type { LegacyMusicDetail } from '../../shared/legacyMusicMetadata.ts'
import { metadataPageUrl } from '../../shared/musicMetadata.ts'

/** A reading projection only. Full payloads, including unconfirmed names and old
 * external-ID assertions, remain in the authorized migration inventory. */
export function legacyMusicDetail(row: Record<string, unknown>): LegacyMusicDetail {
  const value = JSON.parse(String(row.payload))
  const manual = row.description_disposition === 'manual'
  const text = (value: unknown, max: number) =>
    typeof value === 'string' ? value.slice(0, max) : ''
  const description = text(value?.description, 20000)
  const note = text(value?.localNote, 20000)
  const rawSources = value?.descriptionSource?.references ?? [value?.descriptionSource]
  const sources: unknown[] = manual ? [] : Array.isArray(rawSources) ? rawSources : []
  const credits: unknown[] = Array.isArray(value?.producers) ? value.producers : []
  const safeRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  return {
    pluginId: String(row.plugin_id),
    albumId: String(row.legacy_id),
    revision: Number(row.revision),
    disposition: row.disposition === 'conflict' ? 'conflict' : 'bound',
    method: manual ? 'manual' : value?.descriptionSource?.method === 'external-ai' ? 'external-ai' : 'historical',
    description: description || null,
    ...(manual && (value == null || !Object.hasOwn(value, 'description') || value.description === null || value.description === '')
      ? { descriptionCleared: true } : {}),
    localNote: note || null,
    truncated:
      (typeof value?.description === 'string' && value.description.length > 20000) ||
      (typeof value?.localNote === 'string' && value.localNote.length > 20000) ||
      sources.length > 8 ||
      credits.length > 64,
    sources: sources.slice(0, 8).flatMap((raw) => {
      const source = safeRecord(raw)
      if (!source || !metadataPageUrl(source.url)) return []
      return [
        {
          name: text(source.name, 200) || 'Imported source',
          url: source.url,
          ...(text(source.author, 300) ? { author: text(source.author, 300) } : {}),
          ...(text(source.license, 300) ? { license: text(source.license, 300) } : {})
        }
      ]
    }),
    credits: credits.slice(0, 64).flatMap((raw) => {
      const credit = safeRecord(raw)
      if (!credit || !text(credit.name, 300)) return []
      return [
        {
          name: text(credit.name, 300),
          role: text(credit.role, 300),
          source: text(credit.source, 300) || 'historical',
          ...(text(credit.trackTitle, 300) ? { trackTitle: text(credit.trackTitle, 300) } : {}),
          ...(metadataPageUrl(credit.url) ? { url: credit.url } : {})
        }
      ]
    })
  }
}
