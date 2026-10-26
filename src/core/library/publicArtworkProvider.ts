import type { CatalogKind } from '../../shared/musicCatalog.ts'
import type { EntityMetadataLanguage, EntityMetadataPolicy } from '../../shared/entityMetadata.ts'
import { validMusicBrainzArtistId } from '../../shared/entityMetadata.ts'
import type { MetadataUsage } from '../../shared/musicMetadata.ts'
import { validMetadataUsage } from '../../shared/musicMetadata.ts'
import type { MetadataArtworkRecord, MusicArtworkScope } from '../../shared/musicArtwork.ts'
import type { MetadataDetailProvider } from './metadataDetailProvider.ts'
import {
  MusicBrainzWikiProvider,
  MetadataIdentityError,
  metadataPolicyView
} from './entityMetadataProvider.ts'
import { MetadataHttpError, publicMetadataHttp, retryAfter } from './metadataHttp.ts'

export interface PublicArtworkPolicy extends EntityMetadataPolicy {
  commonsImages: boolean
  caaUsage: MetadataUsage | null
}
export function artworkUsageApproval(value: string | undefined): MetadataUsage | null {
  if (!value) return null
  const parsed: unknown = JSON.parse(value)
  if (!validMetadataUsage(parsed)) throw new Error('Invalid CAA artwork usage approval')
  return parsed
}
type Json = Record<string, any>
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const plain = (v: unknown) =>
  str(v)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, key: string) => {
      if (key.startsWith('#')) {
        const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1))
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all
      }
      return (
        ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[
          key.toLowerCase()
        ] ?? all
      )
    })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2048)

function commonsLicense(meta: Json): { license: string; licenseUrl: string } | null {
  const raw = str(meta.LicenseUrl?.value).replace(/^\/\//, 'https://')
  // Commons' PD templates often omit LicenseUrl. Require the machine-readable
  // PD declaration as well as matching copyright, terms and restriction fields.
  if (!raw && str(meta.License?.value) === 'pd' &&
    str(meta.LicenseShortName?.value) === 'Public domain' &&
    str(meta.UsageTerms?.value) === 'Public domain' &&
    str(meta.Copyrighted?.value) === 'False' && !str(meta.Restrictions?.value))
    return { license: 'Public domain', licenseUrl: 'https://commons.wikimedia.org/wiki/Commons:Licensing#Material_in_the_public_domain' }
  const match =
    /^https:\/\/creativecommons\.org\/(licenses\/(by|by-sa)\/(1\.0|2\.0|2\.5|3\.0|4\.0)|publicdomain\/(zero|mark)\/1\.0)\/?$/i.exec(
      raw
    )
  if (!match) return null
  if (match[4] === 'mark' && str(meta.Copyrighted?.value) !== 'False') return null
  return {
    license: match[2]
      ? `CC-${match[2].toUpperCase()}-${match[3]}`
      : match[4] === 'zero'
        ? 'CC0-1.0'
        : 'Public domain',
    licenseUrl: `${raw.replace(/\/$/, '')}/`
  }
}

/** Current Commons URLs add analytics parameters and may use thumb.wikimedia.
 * Strip only those documented tracking fields; signed/unknown queries stay out. */
function commonsResource(value: unknown): string | null {
  const raw = str(value)
  if (
    !/^https:\/\/(?:upload|thumb)\.wikimedia\.org\/wikipedia\/commons\/[^?#]+\.(?:jpe?g|png|webp)(?:\?[^#]*)?$/i.test(
      raw
    )
  )
    return null
  const url = new URL(raw)
  if (
    [...url.searchParams.keys()].some(
      (key) => !['utm_source', 'utm_campaign', 'utm_content'].includes(key)
    )
  )
    return null
  url.search = ''
  return url.href
}

/** Exact confirmed IDs only; image rights do not inherit Wikipedia/MB text rights. */
export class PublicArtworkProvider implements MetadataDetailProvider {
  readonly id = 'public-artwork'
  private readonly policy: () => PublicArtworkPolicy
  private readonly fetcher: typeof publicMetadataHttp.fetch
  private readonly now: () => number
  constructor(
    policy: () => PublicArtworkPolicy,
    fetcher = publicMetadataHttp.fetch,
    now = Date.now
  ) {
    this.policy = policy
    this.fetcher = fetcher
    this.now = now
  }
  supports(kind: CatalogKind) {
    return kind !== 'recording'
  }
  blockedReason(kind: CatalogKind): string | null {
    const p = this.policy()
    const reason = metadataPolicyView(p).reason
    if (reason) return reason
    if (!this.supports(kind)) return 'artwork_kind_unsupported'
    if (kind === 'artist') return p.commonsImages ? null : 'commons_images_not_permitted'
    const usage = p.caaUsage
    if (
      !usage?.display ||
      !usage.cache ||
      (usage.expiresAt !== undefined && usage.expiresAt <= this.now())
    )
      return 'caa_artwork_cache_not_approved'
    return usage.crossSource ? null : 'caa_artwork_cross_source_not_approved'
  }
  context() {
    const p = this.policy()
    return JSON.stringify([
      'public-artwork-v2-commons-pd',
      p.enabled,
      p.publicServiceApproved,
      p.contact,
      p.commonsImages,
      p.caaUsage
    ])
  }
  private async json(url: string | URL, signal: AbortSignal): Promise<Json | null> {
    const response = await this.fetcher(new URL(url), {
      signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': `TwilightEcho/1.3.1 (${this.policy().contact})`
      }
    })
    signal.throwIfAborted()
    if (response.status === 404) return null
    if (!response.ok)
      throw new MetadataHttpError(
        `artwork_http_${response.status}`,
        response.status,
        retryAfter(response.headers.get('retry-after'), this.now())
      )
    const data = (await response.json()) as Json
    if (data.error)
      throw new MetadataHttpError(
        `artwork_api_${str(data.error.code) || 'error'}`,
        data.error.code === 'maxlag' ? 503 : 400
      )
    return data
  }
  async enrich(
    request: { kind: CatalogKind; externalId: string; language: EntityMetadataLanguage },
    signal: AbortSignal
  ) {
    const reason = this.blockedReason(request.kind)
    if (reason) throw new MetadataHttpError(reason, 403)
    if (!validMusicBrainzArtistId(request.externalId))
      throw new MetadataIdentityError('invalid_artwork_identity')
    const context = this.context()
    const id = request.externalId.toLowerCase()
    const artwork =
      request.kind === 'artist'
        ? await this.artist(id, signal)
        : await this.album(request.kind as 'release' | 'album_project', id, signal)
    signal.throwIfAborted()
    return {
      facts: [],
      artwork: artwork ? [{ ...artwork, providerContext: context }] : [],
      availability: artwork ? ('available' as const) : ('not_provided' as const)
    }
  }
  private async cover(
    kind: 'release' | 'album_project',
    id: string,
    signal: AbortSignal
  ): Promise<MetadataArtworkRecord | null> {
    const type = kind === 'release' ? 'release' : 'release-group'
    const data = await this.json(`https://coverartarchive.org/${type}/${id}`, signal)
    if (!data) return null
    const match = /^https?:\/\/musicbrainz\.org\/release\/([a-f0-9-]{36})\/?$/i.exec(
      str(data.release)
    )
    if (
      !match ||
      !validMusicBrainzArtistId(match[1]) ||
      (kind === 'release' && match[1].toLowerCase() !== id)
    )
      throw new MetadataIdentityError('conflicting_caa_release')
    const sourceReleaseId = match[1].toLowerCase()
    const image = (data.images ?? []).find(
      (image: Json) =>
        image.front === true && image.approved === true && /^\d{1,24}$/.test(String(image.id))
    )
    if (!image) return null
    return {
      field: 'artwork',
      scope: kind,
      targetId: id,
      sourceReleaseId,
      resource: `https://coverartarchive.org/release/${sourceReleaseId}/${image.id}-500.jpg`,
      attribution: {
        provider: 'coverartarchive',
        externalId: String(image.id),
        url: `https://musicbrainz.org/release/${sourceReleaseId}/cover-art`,
        revision: String(image.edit ?? ''),
        retrievedAt: this.now(),
        license: 'Copyright; deployment-approved use',
        licenseUrl: 'https://musicbrainz.org/doc/Cover_Art_Archive/License',
        attribution: 'Cover Art Archive; original artwork copyright holders'
      },
      usage: { ...this.policy().caaUsage! }
    }
  }
  private async album(kind: 'release' | 'album_project', id: string, signal: AbortSignal) {
    const exact = await this.cover(kind, id, signal)
    if (exact || kind === 'album_project') return exact
    // Only an explicit MB release→group relation permits project fallback.
    const release = await this.json(`https://musicbrainz.org/ws/2/release/${id}?fmt=json`, signal)
    if (!release) return null
    if (str(release.id).toLowerCase() !== id)
      throw new MetadataIdentityError('conflicting_artwork_release')
    const group = str(release['release-group']?.id).toLowerCase()
    return validMusicBrainzArtistId(group) ? this.cover('album_project', group, signal) : null
  }
  private async artist(id: string, signal: AbortSignal): Promise<MetadataArtworkRecord | null> {
    const identity = await new MusicBrainzWikiProvider(this.policy, this.fetcher, this.now).resolve(
      id,
      signal
    )
    if (!identity?.wikidataId) return null
    const qid = identity.wikidataId
    const data = await this.json(
      `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`,
      signal
    )
    const entity = data?.entities?.[qid]
    if (!entity || entity.id !== qid || entity.missing !== undefined) return null
    const ids = (entity.claims?.P434 ?? [])
      .filter((c: Json) => c.rank !== 'deprecated')
      .map((c: Json) => str(c.mainsnak?.datavalue?.value).toLowerCase())
    if (
      !ids.includes(id) ||
      ids.some((value: string) => value !== id) ||
      (entity.claims?.P31 ?? []).some((c: Json) =>
        ['Q4167410', 'Q13406463'].includes(c.mainsnak?.datavalue?.value?.id)
      )
    )
      throw new MetadataIdentityError('conflicting_wikidata_identity')
    const images = (entity.claims?.P18 ?? [])
      .filter((c: Json) => c.rank !== 'deprecated')
      .sort((a: Json, b: Json) => Number(b.rank === 'preferred') - Number(a.rank === 'preferred'))
      .slice(0, 3)
    for (const claim of images) {
      const name = str(claim.mainsnak?.datavalue?.value)
      if (!name || name.length > 512 || /[\0\r\n|]/.test(name)) continue
      const title = `File:${name}`
      const url = new URL('https://commons.wikimedia.org/w/api.php')
      url.search = new URLSearchParams({
        action: 'query',
        format: 'json',
        formatversion: '2',
        prop: 'imageinfo',
        titles: title,
        iiprop: 'url|extmetadata|timestamp',
        iiurlwidth: '960',
        maxlag: '5'
      }).toString()
      const info = await this.json(url, signal)
      const page = info?.query?.pages?.find(
        (p: Json) =>
          p.ns === 6 &&
          p.missing === undefined &&
          str(p.title).replaceAll('_', ' ') === title.replaceAll('_', ' ')
      )
      const image = page?.imageinfo?.[0]
      const meta = image?.extmetadata ?? {}
      const license = commonsLicense(meta)
      const author = plain(meta.Attribution?.value) || plain(meta.Artist?.value)
      const credit = plain(meta.Credit?.value)
      const resource = commonsResource(image?.thumburl || image?.url)
      if (!license || !author || !resource) continue
      return {
        field: 'artwork',
        scope: 'artist' as MusicArtworkScope,
        targetId: id,
        resource,
        attribution: {
          provider: 'commons',
          externalId: title,
          url: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`,
          ...license,
          attribution: credit && credit !== author ? `${author}; ${credit}` : author,
          revision: str(image.timestamp),
          retrievedAt: this.now()
        },
        usage: { display: true, cache: true, crossSource: true, export: true }
      }
    }
    return null
  }
}
