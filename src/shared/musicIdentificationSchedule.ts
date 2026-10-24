import type { CatalogKind } from './musicCatalog.ts'
import { validMetadataLanguage, type EntityMetadataLanguage } from './entityMetadata.ts'

/** Automatic tasks only; explicit identification keeps its existing contract. */
export interface MusicIdentificationSettings {
  newImports: boolean
  history: boolean
  sources: string[]
  language?: EntityMetadataLanguage
}
export const defaultMusicIdentificationSettings = (): MusicIdentificationSettings => ({
  newImports: false,
  history: false,
  sources: ['musicbrainz']
})
export function normalizeMusicIdentificationSettings(raw: unknown): MusicIdentificationSettings {
  const v = raw && typeof raw === 'object' ? (raw as Partial<MusicIdentificationSettings>) : {}
  return {
    newImports: v.newImports === true,
    history: v.history === true,
    ...(validMetadataLanguage(v.language) ? { language: v.language } : {}),
    sources: Array.isArray(v.sources)
      ? [
          ...new Set(
            v.sources.filter(
              (s): s is string =>
                typeof s === 'string' &&
                /^(musicbrainz|platform\.[a-z0-9][a-z0-9._-]{0,118})$/.test(s)
            )
          )
        ].slice(0, 16)
      : ['musicbrainz']
  }
}
export interface IdentificationScheduleRequest {
  enabled: boolean
  newImports: boolean
  history: boolean
  providers: Array<{ id: string; matcherVersion: string; kinds: CatalogKind[] }>
  enrichment?: {
    language: EntityMetadataLanguage
    providers: Array<{ id: string; context: string; kinds: CatalogKind[] }>
  }
}
export interface IdentificationScheduleStatus {
  pending: number
  history: { cursor: number; horizon: number | null }
}
export interface IdentificationScheduleResult extends IdentificationScheduleStatus {
  processed: number
  more: boolean
}
export interface IdentificationScheduleDatabaseApi {
  identificationSchedule(
    request: IdentificationScheduleRequest,
    now: number
  ): Promise<IdentificationScheduleResult>
  identificationScheduleStatus(): Promise<IdentificationScheduleStatus>
}
