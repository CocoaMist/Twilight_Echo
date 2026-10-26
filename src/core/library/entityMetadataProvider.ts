import type {
  ArtistIdentityCandidate,
  EntityMetadataFact,
  EntityMetadataLanguage,
  EntityMetadataPolicy,
  EntityMetadataPolicyView,
  MetadataAttribution
} from '../../shared/entityMetadata.ts'
import { validMusicBrainzArtistId } from '../../shared/entityMetadata.ts'
import { MetadataHttpError, publicMetadataHttp, retryAfter } from './metadataHttp.ts'
import type { CatalogKind } from '../../shared/musicCatalog.ts'
import type { MusicCreditSet, MusicCreditTarget } from '../../shared/musicCredits.ts'
import { musicBrainzCredits } from './musicBrainzCredits.ts'
import { musicBrainzExploration } from './musicBrainzExploration.ts'
import type { MetadataDetailProvider } from './metadataDetailProvider.ts'

export interface MetadataProvider {
  readonly id: 'musicbrainz-wiki'
  readonly capabilities: {
    entities: readonly ['artist']
    fields: readonly ['name', 'description', 'introduction']
    explicitIdentity: true
  }
  resolve(mbid: string, signal: AbortSignal): Promise<ArtistIdentityCandidate | null>
  enrich(
    mbid: string,
    language: EntityMetadataLanguage,
    signal: AbortSignal
  ): Promise<EntityMetadataFact[]>
}
export function metadataPolicyView(policy: EntityMetadataPolicy): EntityMetadataPolicyView {
  const reason = !policy.enabled
    ? 'metadata_disabled'
    : !policy.publicServiceApproved
      ? 'public_service_not_approved'
      : !policy.contact.trim()
        ? 'missing_application_contact'
        : null
  return {
    enabled: policy.enabled,
    identity: !reason,
    introduction: !reason && policy.wikipediaText,
    reason
  }
}
type Json = Record<string, any>
export class MetadataIdentityError extends Error {}
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const CC0 = ['CC0-1.0', 'https://creativecommons.org/publicdomain/zero/1.0/']
const BYSA = ['CC-BY-SA-4.0', 'https://creativecommons.org/licenses/by-sa/4.0/']
/** Stateless, exact ID lookups only. Search scores never establish identity. */
export class MusicBrainzWikiProvider implements MetadataProvider {
  readonly id = 'musicbrainz-wiki' as const
  readonly capabilities = {
    entities: ['artist'] as const,
    fields: ['name', 'description', 'introduction'] as const,
    explicitIdentity: true as const
  }
  private readonly policy: () => EntityMetadataPolicy
  private readonly fetcher: typeof publicMetadataHttp.fetch
  private readonly now: () => number
  constructor(
    policy: () => EntityMetadataPolicy,
    fetcher = publicMetadataHttp.fetch,
    now = Date.now
  ) {
    this.policy = policy
    this.fetcher = fetcher
    this.now = now
  }
  private async json(url: URL, signal: AbortSignal): Promise<Json | null> {
    const policy = this.policy()
    const view = metadataPolicyView(policy)
    if (!view.identity || (url.hostname.endsWith('wikipedia.org') && !view.introduction))
      throw new MetadataHttpError(view.reason ?? 'wikipedia_text_not_permitted', 403)
    const response = await this.fetcher(url, {
      signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': `TwilightEcho/1.3.1 (${policy.contact})`
      }
    })
    signal.throwIfAborted()
    if (response.status === 404) return null
    if (!response.ok)
      throw new MetadataHttpError(
        `metadata_http_${response.status}`,
        response.status,
        retryAfter(response.headers.get('retry-after'), this.now())
      )
    const data = (await response.json()) as Json
    if (data.error)
      throw new MetadataHttpError(
        `metadata_api_${str(data.error.code) || 'error'}`,
        data.error.code === 'maxlag' ? 503 : 400
      )
    return data
  }
  private attribution(
    provider: MetadataAttribution['provider'],
    externalId: string,
    url: string,
    revision: string,
    license: string[]
  ): MetadataAttribution {
    return {
      provider,
      externalId,
      url,
      revision,
      license: license[0],
      licenseUrl: license[1],
      attribution:
        provider === 'musicbrainz'
          ? 'MusicBrainz contributors'
          : provider === 'wikidata'
            ? 'Wikidata contributors'
            : 'Wikipedia contributors; author history is linked from the source page',
      retrievedAt: this.now()
    }
  }
  async resolve(mbid: string, signal: AbortSignal): Promise<ArtistIdentityCandidate | null> {
    if (!validMusicBrainzArtistId(mbid)) throw new Error('Invalid MusicBrainz artist ID')
    const id = mbid.toLowerCase()
    const data = await this.json(
      new URL(`https://musicbrainz.org/ws/2/artist/${id}?inc=url-rels&fmt=json`),
      signal
    )
    if (!data) return null
    if (
      str(data.id).toLowerCase() !== id ||
      !str(data.name) ||
      str(data.name).length > 1024 ||
      // MusicBrainz leaves type null for valid, sparsely documented artists.
      // The exact artist endpoint/ID establish the entity kind, not this subtype.
      (data.type != null &&
        !['Person', 'Group', 'Orchestra', 'Choir', 'Character', 'Other'].includes(data.type))
    )
      throw new MetadataIdentityError('invalid_artist_identity')
    const qids = new Set<string>(
      (data.relations ?? [])
        .filter((r: Json) => r.type === 'wikidata')
        .flatMap((r: Json) => {
          const match = /^https:\/\/(?:www\.)?wikidata\.org\/wiki\/(Q[1-9]\d*)\/?$/.exec(
            str(r.url?.resource)
          )
          return match ? [match[1]] : []
        })
    )
    if (qids.size > 1) throw new MetadataIdentityError('ambiguous_wikidata_relation')
    return {
      mbid: id,
      name: str(data.name),
      disambiguation: str(data.disambiguation),
      type: str(data.type),
      wikidataId: [...qids][0] ?? null,
      evidence: this.attribution(
        'musicbrainz',
        id,
        `https://musicbrainz.org/artist/${id}`,
        str(data['last-updated']),
        CC0
      )
    }
  }
  async enrich(
    mbid: string,
    language: EntityMetadataLanguage,
    signal: AbortSignal
  ): Promise<EntityMetadataFact[]> {
    const identity = await this.resolve(mbid, signal)
    if (!identity) return []
    const facts: EntityMetadataFact[] = [
      { field: 'name', value: identity.name, language: 'und', attribution: identity.evidence }
    ]
    if (!identity.wikidataId) return facts
    return [...facts, ...await this.wikiFacts(identity.wikidataId, mbid, 'P434', language, signal)]
  }
  private async wikiFacts(qid: string, mbid: string, property: 'P434' | 'P436', language: EntityMetadataLanguage, signal: AbortSignal): Promise<EntityMetadataFact[]> {
    const facts: EntityMetadataFact[] = []
    const data = await this.json(
      new URL(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`),
      signal
    )
    const entity = data?.entities?.[qid]
    if (!entity || entity.id !== qid || entity.missing !== undefined) return facts
    // Reciprocal typed ID corroborates the MB relation. A wrong/ambiguous target never
    // becomes an introduction merely because its title resembles the artist.
    const ids = (entity.claims?.[property] ?? [])
      .filter((c: Json) => c.rank !== 'deprecated')
      .map((c: Json) => str(c.mainsnak?.datavalue?.value).toLowerCase())
    if (
      !ids.includes(mbid.toLowerCase()) ||
      ids.some((id: string) => id !== mbid.toLowerCase()) ||
      (entity.claims?.P31 ?? []).some((c: Json) =>
        ['Q4167410', 'Q13406463'].includes(c.mainsnak?.datavalue?.value?.id)
      )
    )
      throw new MetadataIdentityError('conflicting_wikidata_identity')
    const langs =
      language === 'en'
        ? ['en']
        : language === 'zh-Hant'
          ? ['zh-hant', 'zh', 'zh-hans', 'en']
          : ['zh-hans', 'zh', 'zh-hant', 'en']
    for (const lang of langs) {
      const description = entity.descriptions?.[lang]
      if (str(description?.value)) {
        facts.push({
          field: 'description',
          value: str(description.value).slice(0, 20000),
          language:
            lang === 'zh'
              ? 'zh'
              : lang === 'zh-hant'
                ? 'zh-Hant'
                : lang === 'zh-hans'
                  ? 'zh-Hans'
                  : 'en',
          attribution: this.attribution(
            'wikidata',
            qid,
            `https://www.wikidata.org/wiki/${qid}`,
            String(entity.lastrevid ?? ''),
            CC0
          )
        })
        break
      }
    }
    if (!metadataPolicyView(this.policy()).introduction) return facts
    for (const site of language === 'en' ? ['enwiki'] : ['zhwiki', 'enwiki']) {
      const title = str(entity.sitelinks?.[site]?.title)
      if (!title) continue
      const host = site === 'zhwiki' ? 'zh.wikipedia.org' : 'en.wikipedia.org'
      const variant = site === 'zhwiki' ? (language === 'zh-Hant' ? 'zh-hant' : 'zh-hans') : 'en'
      const url = new URL(`https://${host}/w/api.php`)
      url.search = new URLSearchParams({
        action: 'query',
        format: 'json',
        formatversion: '2',
        prop: 'extracts|info|pageprops|revisions',
        inprop: 'url',
        rvprop: 'ids',
        exintro: '1',
        explaintext: '1',
        // Read the complete lead. exchars is capped at 1200 by MediaWiki,
        // even when a larger value is supplied; the display handles collapse.
        redirects: '1',
        titles: title,
        variant,
        maxlag: '5'
      }).toString()
      const wiki = await this.json(url, signal)
      const pages = wiki?.query?.pages
      const page = Array.isArray(pages) && pages.length === 1 ? pages[0] : null
      if (
        !page ||
        page.missing !== undefined ||
        Object.hasOwn(page.pageprops ?? {}, 'disambiguation') ||
        page.pageprops?.wikibase_item !== qid ||
        !str(page.extract)
      )
        continue
      const source = `https://${host}/wiki/${encodeURIComponent(str(page.title).replaceAll(' ', '_'))}`
      facts.push({
        field: 'introduction',
        value: str(page.extract).slice(0, 20000),
        language: site === 'zhwiki' ? (variant === 'zh-hant' ? 'zh-Hant' : 'zh-Hans') : 'en',
        ...(site === 'zhwiki'
          ? { sourceLanguage: 'zh', rendering: 'mediawiki-variant' as const }
          : {}),
        attribution: this.attribution(
          'wikipedia',
          String(page.pageid),
          source,
          String(page.revisions?.[0]?.revid ?? ''),
          BYSA
        )
      })
      break
    }
    return facts
  }
  async enrichEntity(kind: CatalogKind, mbid: string, language: EntityMetadataLanguage, signal: AbortSignal): Promise<{ facts: EntityMetadataFact[]; credits?: MusicCreditSet; exploration?: import('../../shared/musicExploration.ts').MusicExplorationIngest }> {
    if (kind === 'artist') {
      const facts = await this.enrich(mbid, language, signal)
      const name = facts.find(f => f.field === 'name')
      return { facts, ...(name ? { exploration: musicBrainzExploration({ name: name.value },
        { provider: 'musicbrainz', kind: 'artist', idType: 'mbid', value: mbid.toLowerCase() }, name.attribution) } : {}) }
    }
    if (!validMusicBrainzArtistId(mbid)) throw new Error('Invalid MusicBrainz entity ID')
    const endpoint = kind === 'album_project' ? 'release-group' : kind
    const inc = kind === 'album_project' ? 'artist-credits+artist-rels+url-rels' : kind === 'release'
      ? 'artist-credits+recordings+recording-level-rels+artist-rels+release-groups+work-rels+work-level-rels'
      : 'artist-credits+artist-rels+work-rels+work-level-rels'
    const id = mbid.toLowerCase()
    const data = await this.json(new URL(`https://musicbrainz.org/ws/2/${endpoint}/${id}?inc=${inc}&fmt=json`), signal)
    if (!data) return { facts: [] }
    if (str(data.id).toLowerCase() !== id || !str(data.title)) throw new MetadataIdentityError('invalid_entity_identity')
    const attribution = this.attribution('musicbrainz', id, `https://musicbrainz.org/${endpoint}/${id}`, str(data['last-updated']), CC0)
    const facts: EntityMetadataFact[] = [{ field: 'name', value: str(data.title), language: 'und', attribution }]
    const add = (field: EntityMetadataFact['field'], value: unknown) => {
      if (str(value)) facts.push({ field, value: str(value), language: 'und', attribution })
    }
    add('description', data.disambiguation)
    if (kind === 'album_project') {
      add('firstReleaseDate', data['first-release-date']); add('primaryType', data['primary-type'])
      const qids = new Set<string>((data.relations ?? []).filter((r: Json) => r.type === 'wikidata').flatMap((r: Json) => {
        const match = /^https:\/\/(?:www\.)?wikidata\.org\/wiki\/(Q[1-9]\d*)\/?$/.exec(str(r.url?.resource))
        return match ? [match[1]] : []
      }))
      if (qids.size > 1) throw new MetadataIdentityError('ambiguous_wikidata_relation')
      if (qids.size) facts.push(...await this.wikiFacts([...qids][0], id, 'P436', language, signal))
    } else if (kind === 'release') {
      add('releaseDate', data.date); add('country', data.country); add('barcode', data.barcode)
    }
    const root: MusicCreditTarget = { provider: 'musicbrainz', kind, idType: 'mbid', value: id }
    return { facts, credits: musicBrainzCredits(data, root, attribution), exploration: musicBrainzExploration(data, root, attribution) }
  }
}

/** New typed details do not change the legacy explicit-artist API. */
export class MusicBrainzDetailsProvider implements MetadataDetailProvider {
  readonly id = 'musicbrainz-details'
  private readonly policy: () => EntityMetadataPolicy
  private readonly provider: MusicBrainzWikiProvider
  constructor(policy: () => EntityMetadataPolicy, provider = new MusicBrainzWikiProvider(policy)) {
    this.policy = policy; this.provider = provider
  }
  supports(kind: CatalogKind) { return ['artist', 'recording', 'release', 'album_project'].includes(kind) }
  blockedReason(kind: CatalogKind) {
    return this.supports(kind) ? metadataPolicyView(this.policy()).reason : 'metadata_capability_not_supported'
  }
  context() { return JSON.stringify(this.policy()) }
  async enrich(request: { kind: CatalogKind; externalId: string; language: EntityMetadataLanguage }, signal: AbortSignal) {
    const result = await this.provider.enrichEntity(request.kind, request.externalId, request.language, signal)
    return { ...result, availability: result.facts.length || result.credits?.items.length ? 'available' as const : 'not_found' as const }
  }
}
