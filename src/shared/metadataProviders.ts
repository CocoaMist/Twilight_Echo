import type { CatalogKind } from './musicCatalog.ts'
import type { MusicExternalReference } from './musicIdentification.ts'
import type { EntityMetadataFact, EntityMetadataLanguage } from './entityMetadata.ts'
import { metadataLanguageFamily } from './musicMetadata.ts'

export const publicMetadataSources = ['vocadb', 'theaudiodb', 'discogs'] as const
export type PublicMetadataSource = (typeof publicMetadataSources)[number]
export const isPublicMetadataSource = (id: string): id is PublicMetadataSource =>
  publicMetadataSources.some((source) => source === id)

export function metadataIdentityProvider(id: string): string | null {
  if (['musicbrainz-wiki', 'musicbrainz-details', 'public-artwork'].includes(id))
    return 'musicbrainz'
  if (isPublicMetadataSource(id)) return id
  return id.startsWith('platform.') ? id.slice(9) : null
}

/** Follow exact IDs/URL cross-references, never a same-name fallback. */
export function metadataProviderReference(
  id: string,
  kind: CatalogKind,
  refs: MusicExternalReference[]
) {
  const provider = metadataIdentityProvider(id)
  const native = refs.find(
    (r) =>
      r.provider === provider &&
      r.kind === kind &&
      r.idType === (provider === 'musicbrainz' ? 'mbid' : 'native')
  )
  return (
    native ??
    (isPublicMetadataSource(id) || (id === 'platform.ncm' && ['artist', 'release'].includes(kind))
      ? refs.find((r) => r.provider === 'musicbrainz' && r.kind === kind && r.idType === 'mbid')
      : undefined)
  )
}

export const metadataProviderLabel = (id: string) =>
  ({
    musicbrainz: 'MusicBrainz / Wikipedia / 公共图片',
    'musicbrainz-wiki': 'MusicBrainz / Wikipedia',
    'musicbrainz-details': 'MusicBrainz / Wikipedia',
    'public-artwork': 'Commons / Cover Art Archive',
    vocadb: 'VocaDB',
    theaudiodb: 'TheAudioDB',
    discogs: 'Discogs',
    'platform.ncm': '网易云音乐（兜底）'
  })[id] ?? (id.startsWith('platform.') ? `平台 · ${id.slice(9)}` : id)

/** Caller supplies authorised, source-ranked facts. NCM only fills an empty
 * local biography; an explicit source preference can still select it. */
export function selectMetadataIntroduction(
  facts: EntityMetadataFact[],
  language: EntityMetadataLanguage,
  fallbackNcm = false
) {
  const languages =
    language === 'en'
      ? ['en', 'und', 'ja']
      : language === 'zh-Hant'
        ? ['zh-Hant', 'zh', 'zh-Hans', 'en', 'und', 'ja']
        : ['zh-Hans', 'zh', 'zh-Hant', 'en', 'und', 'ja']
  const select = (items: EntityMetadataFact[]) =>
    ['introduction', 'description'].flatMap((field) =>
      languages.flatMap((lang) =>
        items.filter((f) => f.field === field && metadataLanguageFamily(f.language) === lang)
      )
    )[0]
  return (
    (fallbackNcm
      ? select(facts.filter((f) => f.attribution.provider !== 'platform.ncm'))
      : undefined) ?? select(facts)
  )
}
