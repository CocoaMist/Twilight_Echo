import type { CatalogKind } from '../../shared/musicCatalog.ts'
import type {
  EntityMetadataFact,
  EntityMetadataLanguage,
  MetadataAttribution
} from '../../shared/entityMetadata.ts'
import type {
  IdentificationInput,
  IdentificationRecall,
  MusicExternalReference
} from '../../shared/musicIdentification.ts'
import type { MetadataUsage } from '../../shared/musicMetadata.ts'
import { validMetadataUsage } from '../../shared/musicMetadata.ts'
import type { MetadataArtworkRecord } from '../../shared/musicArtwork.ts'
import type { PublicMetadataSource } from '../../shared/metadataProviders.ts'
import type { IdentificationProvider } from './musicIdentificationProvider.ts'
import type { MetadataDetailProvider } from './metadataDetailProvider.ts'
import { MetadataHttpError, publicMetadataHttp, retryAfter } from './metadataHttp.ts'

type Json = Record<string, unknown>
const object = (v: unknown): Json =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {}
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(object) : [])
const text = (v: unknown, max = 20000) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const id = (v: unknown) => (/^(?:[1-9]\d{0,11})$/.test(String(v)) ? String(v) : '')
const mbid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v)
    ? v.toLowerCase()
    : ''
const norm = (s: string) => s.normalize('NFKC').trim().toLocaleLowerCase('en')
const openUsage: MetadataUsage = { display: true, cache: true, crossSource: true, export: true }
const TERMS = {
  vocadb: 'https://wiki.vocadb.net/docs/license',
  theaudiodb: 'https://www.theaudiodb.com/docs_terms_of_use.php',
  discogs: 'https://support.discogs.com/hc/en-us/articles/360009334593-API-Terms-of-Use'
}
export interface PublicMusicPolicy {
  enabled: boolean
  contact: string
  /** Only the optional exact MB cross-reference route needs MB eligibility. */
  musicbrainzApproved: boolean
  vocadb: boolean
  theaudiodb: boolean
  /** Official public development key is 123. Production must configure its own. */
  audioDbKey: string
  discogs: boolean
  discogsToken: string
  /** Separately reviewed image rights, never inferred from database text rights. */
  artwork?: Partial<Record<PublicMetadataSource, MetadataUsage>>
}
export function publicArtworkApprovals(raw: string | undefined): PublicMusicPolicy['artwork'] {
  if (!raw) return {}
  const data: unknown = JSON.parse(raw)
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !Object.entries(data).every(
      ([key, value]) =>
        ['vocadb', 'theaudiodb', 'discogs'].includes(key) && validMetadataUsage(value)
    )
  )
    throw new Error('Invalid public metadata artwork approvals')
  return data as PublicMusicPolicy['artwork']
}

interface Entry {
  id: string
  name: string
  aliases: string[]
  summary: string
  references: MusicExternalReference[]
  raw: Json
}

/** Public GET adapters share the durable identification/enrichment queue and
 * Core HTTP budget. Search results are candidates, not identity authority. */
export class PublicMusicSource implements IdentificationProvider, MetadataDetailProvider {
  readonly matcherVersion = 'public-music-v1-exact-candidates'
  readonly id: PublicMetadataSource
  private readonly policy: () => PublicMusicPolicy
  private readonly fetcher: typeof publicMetadataHttp.fetch
  private readonly now: () => number
  constructor(
    id: PublicMetadataSource,
    policy: () => PublicMusicPolicy,
    fetcher = publicMetadataHttp.fetch,
    now = Date.now
  ) {
    this.id = id
    this.policy = policy
    this.fetcher = fetcher
    this.now = now
  }
  supports(kind: CatalogKind) {
    return (
      kind === 'artist' || kind === 'album_project' || (this.id === 'discogs' && kind === 'release')
    )
  }
  supportsArtwork(kind: CatalogKind) {
    if (!this.supports(kind) || this.blockedReason(kind)) return false
    const usage = this.policy().artwork?.[this.id]
    if (usage)
      return (
        usage.display &&
        usage.cache &&
        usage.crossSource &&
        (usage.expiresAt === undefined || usage.expiresAt > this.now())
      )
    return this.id === 'theaudiodb' && kind === 'artist'
  }
  blockedReason(kind: CatalogKind): string | null {
    const p = this.policy()
    if (!p.enabled) return 'metadata_disabled'
    if (!this.supports(kind)) return 'metadata_capability_not_supported'
    if (!p[this.id]) return 'public_source_disabled'
    if (!p.contact.trim()) return 'missing_application_contact'
    if (this.id === 'discogs' && p.discogsToken && !/^[A-Za-z0-9_-]{8,256}$/.test(p.discogsToken))
      return 'discogs_token_invalid'
    if (this.id === 'theaudiodb' && !/^[A-Za-z0-9_-]{1,128}$/.test(p.audioDbKey))
      return 'theaudiodb_key_required'
    return null
  }
  identification(): IdentificationProvider {
    return {
      id: this.id,
      matcherVersion: this.matcherVersion,
      supports: (kind) => this.supports(kind),
      context: () => this.context(),
      recall: (input, signal) => this.recall(input, signal),
      blockedReason: (kind) =>
        this.blockedReason(kind) ??
        (this.id === 'discogs' && !this.policy().discogsToken ? 'discogs_token_required' : null)
    }
  }
  context() {
    const p = this.policy()
    // Never serialize credentials to jobs, policy views, logs or the renderer.
    return JSON.stringify([
      this.matcherVersion,
      p.enabled,
      p[this.id],
      p.contact,
      p.musicbrainzApproved,
      this.id === 'discogs' ? !!p.discogsToken : this.id === 'theaudiodb' ? !!p.audioDbKey : true,
      p.artwork?.[this.id] ?? null
    ])
  }
  private assert(kind: CatalogKind) {
    const reason = this.blockedReason(kind)
    if (reason) throw new MetadataHttpError(reason, 403)
  }
  private async get(url: URL, signal: AbortSignal): Promise<Json | null> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': `TwilightEcho/1.0 (${this.policy().contact})`
    }
    if (url.hostname === 'api.discogs.com' && this.policy().discogsToken)
      headers.Authorization = `Discogs token=${this.policy().discogsToken}`
    const response = await this.fetcher(url, { headers, signal })
    if (response.status === 404) return null
    if (!response.ok)
      throw new MetadataHttpError(
        `${this.id}_http_${response.status}`,
        response.status,
        retryAfter(response.headers.get('retry-after'), this.now())
      )
    const value: unknown = await response.json()
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`${this.id}_response_invalid`)
    return value as Json
  }
  private audioUrl(method: string, params: Record<string, string>) {
    const url = new URL(
      `https://www.theaudiodb.com/api/v1/json/${this.policy().audioDbKey}/${method}.php`
    )
    url.search = new URLSearchParams(params).toString()
    return url
  }
  private entry(kind: CatalogKind, raw: Json): Entry | null {
    if (raw.deleted === true || Number(raw.mergedTo) > 0) return null
    const artist = kind === 'artist'
    const value = id(this.id === 'theaudiodb' ? raw[artist ? 'idArtist' : 'idAlbum'] : raw.id)
    const name = text(
      this.id === 'theaudiodb' ? raw[artist ? 'strArtist' : 'strAlbum'] : (raw.name ?? raw.title),
      512
    )
    if (!value || !name) return null
    const aliases =
      this.id === 'vocadb'
        ? list(raw.names).map((n) => text(n.value, 512))
        : this.id === 'discogs'
          ? [
              text(raw.realname, 512),
              ...list(raw.aliases).map((n) => text(n.name, 512)),
              ...(Array.isArray(raw.namevariations)
                ? raw.namevariations.map((n) => text(n, 512))
                : [])
            ]
          : [text(raw.strArtistAlternate, 512)]
    const references: MusicExternalReference[] = [
      { provider: this.id, kind, idType: 'native', value }
    ]
    const mb = mbid(raw[artist ? 'strMusicBrainzID' : 'strMusicBrainzID'])
    if (this.id === 'theaudiodb' && mb)
      references.push({ provider: 'musicbrainz', kind, idType: 'mbid', value: mb })
    if (this.id === 'vocadb') {
      for (const link of list(raw.webLinks)) {
        const match =
          /^https:\/\/musicbrainz\.org\/(artist|release-group)\/([a-f0-9-]{36})\/?$/i.exec(
            text(link.url)
          )
        if (match && match[1] === (artist ? 'artist' : 'release-group') && mbid(match[2]))
          references.push({ provider: 'musicbrainz', kind, idType: 'mbid', value: mbid(match[2]) })
      }
    }
    const summary =
      this.id === 'vocadb'
        ? [raw.artistType ?? raw.discType, raw.artistString]
            .map((v) => text(v, 300))
            .filter(Boolean)
            .join(' · ')
        : this.id === 'theaudiodb'
          ? [raw.strArtist, raw.strGenre, raw.strCountry]
              .map((v) => text(v, 200))
              .filter(Boolean)
              .join(' · ')
          : text(raw.profile ?? raw.notes ?? raw.artist, 800)
    return {
      id: value,
      name,
      aliases: [...new Set([name, ...aliases].filter(Boolean))],
      summary,
      references: references.filter(
        (ref, i) => references.findIndex((r) => JSON.stringify(r) === JSON.stringify(ref)) === i
      ),
      raw
    }
  }
  async recall(input: IdentificationInput, signal: AbortSignal): Promise<IdentificationRecall> {
    this.assert(input.kind)
    const reason = this.identification().blockedReason(input.kind)
    if (reason) throw new MetadataHttpError(reason, 403)
    const name = input.name.trim()
    if (!name || name.length > 200)
      return { proposals: [], incomplete: true, reasons: ['name_missing_or_too_long'] }
    let raw: Json | null,
      rows: Json[],
      incomplete = !!input.sourcesTruncated || !!input.sources?.some((s) => s.tags.truncated)
    if (this.id === 'vocadb') {
      const url = new URL(
        `https://vocadb.net/api/${input.kind === 'artist' ? 'artists' : 'albums'}`
      )
      url.search = new URLSearchParams({
        query: name,
        nameMatchMode: 'Exact',
        maxResults: '10',
        getTotalCount: 'true',
        fields:
          input.kind === 'artist'
            ? 'Names,Description,WebLinks'
            : 'Names,Description,WebLinks,Artists',
        lang: 'Default'
      }).toString()
      raw = await this.get(url, signal)
      if (raw && !Array.isArray(raw.items)) throw new Error('vocadb_response_invalid')
      rows = list(raw?.items)
      incomplete ||= Number(raw?.totalCount ?? rows.length) > rows.length || rows.length >= 10
    } else if (this.id === 'theaudiodb') {
      raw = await this.get(
        this.audioUrl(
          input.kind === 'artist' ? 'search' : 'searchalbum',
          input.kind === 'artist' ? { s: name } : { s: input.artist, a: name }
        ),
        signal
      )
      rows = list(raw?.[input.kind === 'artist' ? 'artists' : 'album'])
      // The free search deliberately returns only one result. It is not a uniqueness proof.
      incomplete = true
    } else {
      const url = new URL('https://api.discogs.com/database/search')
      url.search = new URLSearchParams({
        q: name,
        type: input.kind === 'artist' ? 'artist' : input.kind === 'release' ? 'release' : 'master',
        ...(input.kind === 'artist' ? {} : { artist: input.artist }),
        per_page: '10',
        page: '1'
      }).toString()
      raw = await this.get(url, signal)
      rows = list(raw?.results)
      incomplete ||= Number(object(raw?.pagination).items ?? rows.length) > rows.length
    }
    const entries = rows.map((row) => this.entry(input.kind, row)).filter((e): e is Entry => !!e)
    return {
      proposals: entries.slice(0, 10).map((entry) => ({
        provider: this.id,
        name: entry.name,
        summary: [entry.summary, `ID ${entry.id}`, '请核对作品及身份后确认']
          .filter(Boolean)
          .join(' · ')
          .slice(0, 2048),
        references: entry.references,
        matcherVersion: this.matcherVersion,
        evidence: {
          origin: 'search' as const,
          matches: entry.aliases.some((alias) => norm(alias) === norm(name))
            ? ['name_or_alias']
            : [],
          missing: ['recording_corroboration'],
          conflicts: [],
          incomplete,
          provenance: `${this.id} 官方 API；名称检索不自动确认身份`
        }
      })),
      incomplete,
      reasons: incomplete ? ['search_may_be_incomplete'] : []
    }
  }
  /** Resolve only an authoritative outbound MB link (or TAB's exact MBID field). */
  private async fromMusicBrainz(
    kind: CatalogKind,
    value: string,
    signal: AbortSignal
  ): Promise<Entry | null> {
    if (!this.policy().musicbrainzApproved)
      throw new MetadataHttpError('public_service_not_approved', 403)
    if (this.id === 'theaudiodb') {
      const raw = await this.get(
        this.audioUrl(kind === 'artist' ? 'artist-mb' : 'album-mb', { i: value }),
        signal
      )
      const entries = list(raw?.[kind === 'artist' ? 'artists' : 'album'])
        .map((row) => this.entry(kind, row))
        .filter(
          (entry): entry is Entry =>
            !!entry &&
            entry.references.some((r) => r.provider === 'musicbrainz' && r.value === value)
        )
      return entries.length === 1 ? entries[0] : null
    }
    const mbKind =
      kind === 'artist' ? 'artist' : kind === 'album_project' ? 'release-group' : 'release'
    const raw = await this.get(
      new URL(`https://musicbrainz.org/ws/2/${mbKind}/${value}?inc=url-rels&fmt=json`),
      signal
    )
    if (mbid(raw?.id) !== value) return null
    const pattern =
      this.id === 'vocadb'
        ? new RegExp(`^https://vocadb\\.net/${kind === 'artist' ? 'Ar' : 'Al'}/([1-9]\\d*)(?:/|$)`)
        : new RegExp(
            `^https?://(?:www\\.)?discogs\\.com/(?:[a-z]{2}/)?${kind === 'artist' ? 'artist' : kind === 'release' ? 'release' : 'master'}/([1-9]\\d*)(?:[-/]|$)`
          )
    const ids = [
      ...new Set(
        list(raw?.relations).flatMap((relation) => {
          const match = pattern.exec(text(object(relation.url).resource))
          return match && id(match[1]) ? [match[1]] : []
        })
      )
    ]
    return ids.length === 1 ? this.lookup(kind, ids[0], signal) : null
  }
  private async lookup(kind: CatalogKind, value: string, signal: AbortSignal) {
    let raw: Json | null
    if (this.id === 'vocadb') {
      const url = new URL(
        `https://vocadb.net/api/${kind === 'artist' ? 'artists' : 'albums'}/${value}`
      )
      url.search = new URLSearchParams({
        fields: 'Names,Description,MainPicture,WebLinks',
        lang: 'Default'
      }).toString()
      raw = await this.get(url, signal)
    } else if (this.id === 'theaudiodb') {
      const data = await this.get(
        this.audioUrl(kind === 'artist' ? 'artist' : 'album', {
          [kind === 'artist' ? 'i' : 'm']: value
        }),
        signal
      )
      const rows = list(data?.[kind === 'artist' ? 'artists' : 'album'])
      raw = rows.length === 1 ? rows[0] : null
    } else
      raw = await this.get(
        new URL(
          `https://api.discogs.com/${kind === 'artist' ? 'artists' : kind === 'release' ? 'releases' : 'masters'}/${value}`
        ),
        signal
      )
    const entry = raw ? this.entry(kind, raw) : null
    if (entry && entry.id !== value) throw new Error(`${this.id}_identity_mismatch`)
    return entry
  }
  async enrich(
    request: { kind: CatalogKind; externalId: string; language: EntityMetadataLanguage },
    signal: AbortSignal
  ): ReturnType<MetadataDetailProvider['enrich']> {
    this.assert(request.kind)
    const context = this.context(),
      value = request.externalId
    if (!id(value) && !mbid(value)) throw new Error('Invalid public music identity')
    const entry = mbid(value)
      ? await this.fromMusicBrainz(request.kind, mbid(value), signal)
      : await this.lookup(request.kind, value, signal)
    signal.throwIfAborted()
    if (context !== this.context())
      throw new MetadataHttpError('provider_configuration_changed', 403)
    if (!entry) return { facts: [], availability: 'not_found' as const }
    const now = this.now(),
      kind = request.kind,
      artist = kind === 'artist',
      raw = entry.raw
    const url =
      this.id === 'vocadb'
        ? `https://vocadb.net/${artist ? 'Ar' : 'Al'}/${entry.id}`
        : this.id === 'theaudiodb'
          ? `https://www.theaudiodb.com/${artist ? 'artist' : 'album'}/${entry.id}`
          : `https://www.discogs.com/${artist ? 'artist' : kind === 'release' ? 'release' : 'master'}/${entry.id}`
    const attribution: MetadataAttribution = {
      provider: this.id,
      externalId: entry.id,
      url,
      license:
        this.id === 'vocadb'
          ? 'CC-BY-4.0'
          : this.id === 'discogs'
            ? 'CC0-1.0 (API terms apply)'
            : 'TheAudioDB API terms',
      licenseUrl:
        this.id === 'vocadb' ? 'https://creativecommons.org/licenses/by/4.0/' : TERMS[this.id],
      attribution:
        this.id === 'discogs'
          ? 'Data provided by Discogs.'
          : `Data provided by ${this.id === 'vocadb' ? 'VocaDB' : 'TheAudioDB'}.`,
      revision: text(raw.version ?? raw.dateModified ?? raw.strLastScraped) || String(now),
      retrievedAt: now
    }
    const usage: MetadataUsage =
      this.id === 'vocadb'
        ? openUsage
        : {
            display: true,
            cache: true,
            crossSource: true,
            export: this.id === 'discogs',
            expiresAt: now + (this.id === 'discogs' ? 6 * 3600000 : 7 * 86400000)
          }
    const facts: EntityMetadataFact[] = []
    const add = (field: EntityMetadataFact['field'], value: unknown, language = 'und') => {
      const content = text(value)
      if (content)
        facts.push({
          field,
          value: content,
          language,
          attribution,
          usage,
          sourceProvider: this.id,
          providerContext: context
        })
    }
    add('name', entry.name)
    if (this.id === 'vocadb') {
      // The multilingual contract can contain original and English versions.
      const description = object(raw.description)
      if (typeof raw.description === 'string') add('introduction', raw.description)
      else {
        add('introduction', description.original)
        add('introduction', description.english, 'en')
      }
      add('primaryType', raw.artistType ?? raw.discType)
      const release = object(raw.releaseDate)
      if (Number(release.year) > 0)
        add(
          'releaseDate',
          [
            release.year,
            release.month && String(release.month).padStart(2, '0'),
            release.day && String(release.day).padStart(2, '0')
          ]
            .filter(Boolean)
            .join('-')
        )
    } else if (this.id === 'theaudiodb') {
      for (const [suffix, lang] of [
        ['CN', 'zh-Hans'],
        ['EN', 'en'],
        ['JP', 'ja']
      ] as const)
        add('introduction', raw[`${artist ? 'strBiography' : 'strDescription'}${suffix}`], lang)
      add('country', raw.strCountry)
      add('releaseDate', raw.intYearReleased == null ? '' : String(raw.intYearReleased))
      add('primaryType', raw.strReleaseFormat)
    } else {
      // Discogs markup is plain text here, never renderer HTML.
      add(
        'introduction',
        text(raw.profile ?? raw.notes)
          .replace(/\[(?:url=([^\]]+)|[arlm]=([^\]]+))\]([^]*?)\[\/(?:url|[arlm])\]/gi, '$3')
          .replace(/\[[arlm]=([^\]]+)\]/gi, '$1')
          .replace(
            /\[([arlm])(\d+)\]/gi,
            (_match, type: string, value: string) =>
              `Discogs ${{ a: 'artist', r: 'release', l: 'label', m: 'master' }[type.toLowerCase()]} #${value}`
          )
          .replace(/\[\/?(?:b|i)\]/g, '')
      )
      add('releaseDate', raw.released ?? (raw.year ? String(raw.year) : ''))
      add('country', raw.country)
    }
    const artwork: MetadataArtworkRecord[] = []
    const approved = this.policy().artwork?.[this.id]
    // A CC flag is a rights signal only for artist artwork, not album covers.
    const imageUsage =
      approved ??
      (this.id === 'theaudiodb' && artist && raw.strCreativeCommons === 'Yes'
        ? {
            display: true,
            cache: true,
            crossSource: true,
            export: false,
            expiresAt: now + 7 * 86400000
          }
        : null)
    if (
      imageUsage?.display &&
      imageUsage.cache &&
      imageUsage.crossSource &&
      (imageUsage.expiresAt === undefined || imageUsage.expiresAt > now)
    ) {
      const resource =
        this.id === 'vocadb'
          ? text(object(raw.mainPicture).urlOriginal ?? object(raw.mainPicture).urlSmall)
          : this.id === 'theaudiodb'
            ? text(raw[artist ? 'strArtistThumb' : 'strAlbumThumb'])
            : text((list(raw.images).find((i) => i.type === 'primary') ?? list(raw.images)[0])?.uri)
      const allowed =
        this.id === 'vocadb'
          ? /^https:\/\/(?:static\.)?vocadb\.net\/[^?#]+$/
          : this.id === 'theaudiodb'
            ? /^https:\/\/(?:www|r2)\.theaudiodb\.com\/images\/[^?#]+$/
            : /^https:\/\/i\.discogs\.com\/[^?#]+$/
      if (allowed.test(resource))
        artwork.push({
          field: 'artwork',
          scope: artist ? 'artist' : (kind as 'release' | 'album_project'),
          targetId: entry.id,
          targetRef: entry.references[0],
          resource,
          providerContext: context,
          attribution: {
            ...attribution,
            license: `${this.id} image usage`,
            licenseUrl: TERMS[this.id]
          },
          usage:
            this.id === 'discogs'
              ? {
                  ...imageUsage,
                  expiresAt: Math.min(imageUsage.expiresAt ?? Infinity, now + 6 * 3600000)
                }
              : imageUsage
        })
    }
    return { facts, ...(artwork.length ? { artwork } : {}), availability: 'available' as const }
  }
}
