import type { CatalogKind } from '../../shared/musicCatalog.ts'
import type { EntityMetadataPolicy } from '../../shared/entityMetadata.ts'
import { validMusicBrainzArtistId } from '../../shared/entityMetadata.ts'
import type {
  IdentificationInput,
  IdentificationProposal,
  IdentificationRecall,
  IdentificationArtistRecording,
  IdentificationEvidence
} from '../../shared/musicIdentification.ts'
import {
  explicitMusicBrainzIds, identityProofSources, nativeIdentificationId as nativeId
} from '../../shared/musicIdentificationVerification.ts'
import { metadataPolicyView } from './entityMetadataProvider.ts'
import { MetadataHttpError, publicMetadataHttp, retryAfter } from './metadataHttp.ts'
import { verifyMusicBrainzAlbums } from './musicIdentificationAlbum.ts'
import { verifyMusicBrainzAlbumSubset } from './musicIdentificationAlbumSubset.ts'
import { localAlbumLayout } from '../../shared/musicAlbumValidation.ts'
import { verifyPlatformAlbums } from './musicIdentificationPlatformAlbum.ts'
import { IdentificationResponseCache } from './identificationResponseCache.ts'
import { validPlatformAlbumIdentity } from '../../shared/musicPlatformAlbum.ts'
import { artistRecordingSources, verifyArtistRecordings } from '../../shared/musicArtistRecordingVerification.ts'
import { ncmFileReferences } from '../../shared/ncmFileIdentity.ts'
import { platformRecordingSources, platformRecordingReferences, validPlatformRecordingPage,
  platformRecordingShapeMatches, matchedPlatformRecordings, validPlatformArtistIdentity,
  MAX_RECORDING_IDENTITY_RESULTS, type PlatformRecordingPage } from '../../shared/musicPlatformRecording.ts'

export interface IdentificationProvider {
  readonly id: string
  readonly matcherVersion: string
  supports(kind: CatalogKind): boolean
  blockedReason(kind: CatalogKind): string | null
  /** A changed configuration invalidates an in-flight result, even after re-enabling. */
  context(): string
  recall(input: IdentificationInput, signal: AbortSignal): Promise<IdentificationRecall>
}
const LIMIT = 10
const MAX_LOOKUPS = 4
const str = (v: unknown, max = 2048) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const norm = (v: string) => v.normalize('NFKC').trim().toLocaleLowerCase('en')
const usable = (v: string) =>
  !!v.trim() &&
  v.length <= 200 &&
  !/^(unknown(?: artist| album| title)?|未知(?:艺术家|歌手|专辑|歌曲)?|various artists|va)$/i.test(
    v.trim()
  )
const inputIncomplete = (input: IdentificationInput) =>
  !!input.sourcesTruncated || !!input.sources?.some((s) => s.tags.truncated)
const evidence = (
  input: IdentificationInput,
  origin: IdentificationEvidence['origin'],
  provenance: string
): IdentificationEvidence => ({
  origin,
  matches: [],
  missing: [],
  conflicts: [],
  incomplete: inputIncomplete(input),
  provenance
})
function compare(e: IdentificationEvidence, field: string, expected: string, actual: string) {
  if (!usable(expected) || !actual) e.missing.push(field)
  else (norm(expected) === norm(actual) ? e.matches : e.conflicts).push(field)
}
function compareDuration(e: IdentificationEvidence, input: IdentificationInput, seconds: unknown) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    e.missing.push('duration')
    return
  }
  const observations = (input.sources ?? [])
    .map((s) => s.tags.durationSeconds?.value ?? s.duration)
    .filter((d) => d > 0)
  if (!observations.length) e.missing.push('duration')
  else
    (observations.every((d) => Math.abs(d - seconds) <= 2) ? e.matches : e.conflicts).push(
      'duration'
    )
}
const MB_KIND = {
  artist: 'artist',
  recording: 'recording',
  album_project: 'release-group',
  release: 'release'
} as const
const MB_LIST = {
  artist: 'artists',
  recording: 'recordings',
  album_project: 'release-groups',
  release: 'releases'
} as const
const INC = {
  artist: 'aliases',
  recording: 'artist-credits+isrcs',
  album_project: 'artist-credits',
  release: 'artist-credits+release-groups+labels'
} as const
const luceneLiteral = (v: string) => `"${v.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1')}"`

/** Layered, bounded recall. Only verified structured proofs can authorize adoption. */
export class MusicBrainzIdentificationProvider implements IdentificationProvider {
  readonly id = 'musicbrainz'
  readonly matcherVersion = 'mb-verify-v4-local-corroboration'
  private readonly policy: () => EntityMetadataPolicy
  private readonly fetcher: typeof publicMetadataHttp.fetch
  private readonly now: () => number
  private readonly responses: IdentificationResponseCache
  constructor(
    policy: () => EntityMetadataPolicy,
    fetcher = publicMetadataHttp.fetch,
    now = Date.now,
    responses = new IdentificationResponseCache({ now })
  ) {
    this.policy = policy
    this.fetcher = fetcher
    this.now = now
    this.responses = responses
  }
  supports() {
    return true
  }
  blockedReason() {
    return metadataPolicyView(this.policy()).reason
  }
  context() {
    const p = this.policy()
    return JSON.stringify([p.enabled, p.publicServiceApproved, p.contact])
  }
  private async json(url: URL, signal: AbortSignal) {
    signal.throwIfAborted()
    const reason = this.blockedReason()
    if (reason) throw new MetadataHttpError(reason, 403)
    const context = this.context()
    const response = await this.responses.read(
      {
        provider: this.id,
        context,
        method: 'GET',
        parameters: [url.href, 'application/json']
      },
      signal,
      async (sharedSignal) => {
        const response = await this.fetcher(url, {
          signal: sharedSignal,
          headers: {
            Accept: 'application/json',
            'User-Agent': `TwilightEcho/1.3.1 (${this.policy().contact})`
          }
        })
        if (response.status === 404)
          return {
            value: null,
            retention:
              url.searchParams.has('query') || url.searchParams.has('release-group')
                ? false
                : 'negative'
          }
        if (!response.ok)
          throw new MetadataHttpError(
            `metadata_http_${response.status}`,
            response.status,
            retryAfter(response.headers.get('retry-after'), this.now())
          )
        const data = obj(await response.json())
        if (data.error) throw new MetadataHttpError('musicbrainz_api_error', 400)
        const list = url.pathname.endsWith('/artist')
          ? 'artists'
          : url.pathname.endsWith('/recording')
            ? 'recordings'
            : url.pathname.endsWith('/release-group')
              ? 'release-groups'
              : 'releases'
        const rows = data[list]
        const count = data[url.searchParams.has('query') ? 'count' : 'release-count']
        const valid =
          url.searchParams.has('query') || url.searchParams.has('release-group')
            ? Array.isArray(rows) &&
              Number.isSafeInteger(count) &&
              Number(count) >= rows.length &&
              rows.every((row) => validMusicBrainzArtistId(str(obj(row).id)))
            : validMusicBrainzArtistId(str(data.id))
        return {
          value: data,
          retention: !valid
            ? false
            : Array.isArray(rows) && !rows.length && count === 0
              ? 'negative'
              : 'positive'
        }
      }
    )
    signal.throwIfAborted()
    if (context !== this.context())
      throw new MetadataHttpError('provider_configuration_changed', 403)
    return response
  }
  private ids(input: IdentificationInput) {
    return explicitMusicBrainzIds(input)
  }
  private proposal(
    input: IdentificationInput,
    raw: unknown,
    origin: 'explicit_id' | 'search',
    url: URL,
    incomplete: boolean,
    explicitIds: Map<string, boolean>,
    retrievedAt: number
  ): IdentificationProposal | null {
    const data = obj(raw),
      kind = input.kind,
      id = str(data.id).toLowerCase()
    const name = str(kind === 'artist' ? data.name : data.title)
    if (
      !validMusicBrainzArtistId(id) ||
      !name ||
      (kind === 'artist' &&
        data.type !== undefined &&
        data.type !== null &&
        !['Person', 'Group', 'Orchestra', 'Choir', 'Character', 'Other'].includes(
          String(data.type)
        )) ||
      (kind === 'recording' && !Object.hasOwn(data, 'length')) ||
      (kind === 'album_project' && !Object.hasOwn(data, 'primary-type')) ||
      (kind === 'release' && !Object.hasOwn(data, 'status') && !Array.isArray(data.media))
    )
      return null
    const e = evidence(
      input,
      origin,
      JSON.stringify({
        provider: 'musicbrainz',
        url: url.href,
        retrievedAt,
        revision: str(data['last-updated']),
        attribution: 'MusicBrainz contributors',
        license: 'CC0-1.0'
      })
    )
    e.incomplete ||= incomplete
    const rawCredit = array(data['artist-credit'])
    if (
      str(kind === 'artist' ? data.name : data.title, 2049).length > 2048 ||
      (kind !== 'artist' &&
        (!rawCredit.length ||
          rawCredit.length > 64 ||
          rawCredit.some((c) => {
            const name = str(obj(c).name || obj(obj(c).artist).name, 2049)
            return !name || name.length > 2048
          })))
    ) {
      e.incomplete = true
      e.missing.push('complete_remote_metadata')
    }
    compare(e, kind === 'artist' ? 'name' : 'title', input.name, name)
    if (
      kind === 'artist' &&
      e.conflicts.includes('name') &&
      array(data.aliases).some((a) => norm(str(obj(a).name)) === norm(input.name))
    ) {
      e.conflicts = e.conflicts.filter((c) => c !== 'name')
      e.matches.push('artist_alias')
    }
    if (kind === 'artist' && origin === 'explicit_id') {
      const names = [name, ...array(data.aliases).map((a) => str(obj(a).name))].map(norm)
      for (const s of input.sources ?? []) {
        if (explicitMusicBrainzIds({ ...input, sources: [s] }).get(id) !== true) continue
        const rawName = s.tags.artists?.value[0] ?? s.tags.artist?.value
        if (rawName && !names.includes(norm(rawName))) e.conflicts.push('raw_artist_name')
      }
    }
    const credit = array(data['artist-credit'])
      .map((c) => str(obj(c).name) || str(obj(obj(c).artist).name))
      .filter(Boolean)
    if (kind !== 'artist') compare(e, 'artist_credit', input.artist, credit.join(' / '))
    if (kind === 'recording')
      compareDuration(e, input, typeof data.length === 'number' ? data.length / 1000 : undefined)
    if (kind === 'recording') {
      for (const s of input.sources ?? []) {
        if (s.tags.title) compare(e, 'raw_title', s.tags.title.value, name)
        const names = s.tags.artists?.value ?? (s.tags.artist ? [s.tags.artist.value] : [])
        if (
          names.length &&
          (names.length !== credit.length ||
            names.some((n, i) => norm(n) !== norm(credit[i] ?? '')))
        )
          e.conflicts.push('raw_artist_credits')
        const isrcs = array(data.isrcs).map((v) => str(v).toUpperCase())
        if (
          s.tags.isrcs?.length &&
          isrcs.length &&
          !s.tags.isrcs.every((v) => isrcs.includes(v.toUpperCase()))
        )
          e.conflicts.push('isrc')
      }
    }
    if (kind === 'release') {
      for (const s of input.sources ?? []) {
        const projectId = str(obj(data['release-group']).id).toLowerCase()
        if (
          s.tags.musicbrainz?.releaseGroupId &&
          projectId &&
          s.tags.musicbrainz.releaseGroupId.toLowerCase() !== projectId
        )
          e.conflicts.push('release_group_mbid')
        const barcode = str(data.barcode)
        if (s.tags.barcode && barcode && s.tags.barcode !== barcode) e.conflicts.push('barcode')
        const catalogs = array(data['label-info'])
          .map((l) => str(obj(l)['catalog-number']))
          .filter(Boolean)
        if (
          s.tags.catalogNumbers?.length &&
          catalogs.length &&
          !s.tags.catalogNumbers.every((n) => catalogs.some((c) => norm(c) === norm(n)))
        )
          e.conflicts.push('catalog_number')
      }
    }
    if (kind === 'release' || kind === 'album_project') {
      for (const s of input.sources ?? []) {
        if (s.tags.album) compare(e, 'raw_album_title', s.tags.album.value, name)
        const names =
          s.tags.albumArtists?.value ?? (s.tags.albumArtist ? [s.tags.albumArtist.value] : [])
        if (
          names.length &&
          (names.length !== credit.length ||
            names.some((n, i) => norm(n) !== norm(credit[i] ?? '')))
        )
          e.conflicts.push('raw_album_artists')
      }
    }
    e.matches = [...new Set(e.matches)]
    e.missing = [...new Set(e.missing)]
    e.conflicts = [...new Set(e.conflicts)]
    if (origin === 'explicit_id') {
      e.matches.push(`${MB_KIND[kind]}_mbid`)
      if (explicitIds.size > 1) e.conflicts.push('multiple_explicit_ids')
      if (explicitIds.get(id) === false) e.missing.push('artist_id_alignment')
    } else e.missing.push('verified_identity')
    if (origin === 'search') {
      if (kind === 'release') e.missing.push('complete_track_validation', 'pressing_disambiguation')
      if (kind === 'album_project') e.missing.push('complete_track_validation')
    }
    const reference = { provider: 'musicbrainz', kind, idType: 'mbid', value: id }
    if (
      origin === 'explicit_id' &&
      explicitIds.size === 1 &&
      explicitIds.get(id) &&
      !e.incomplete &&
      !e.conflicts.length
    )
      e.verification = {
        method: 'typed_id',
        reference,
        sourceIds: identityProofSources(input, reference)
      }
    return {
      provider: this.id,
      name,
      summary: [
        str(data.disambiguation),
        str(data.type),
        str(data['primary-type']),
        str(data.country),
        str(data.date) || str(data['first-release-date']),
        str(data.barcode)
      ]
        .filter(Boolean)
        .join(' · ')
        .slice(0, 4096),
      references: [reference],
      evidence: e,
      matcherVersion: this.matcherVersion
    }
  }
  private async verifyArtist(
    input: IdentificationInput,
    proposals: IdentificationProposal[],
    signal: AbortSignal
  ) {
    const sources = artistRecordingSources(input)
    const samples: Array<{ sourceId: string; recordings: IdentificationArtistRecording[] }> = []
    const receipts: Array<{ url: string; retrievedAt: number }> = []
    if (
      !sources.length ||
      !proposals.some((p) => !p.evidence.conflicts.length && !p.evidence.incomplete)
    )
      return false
    for (const source of sources) {
      const url = new URL('https://musicbrainz.org/ws/2/recording')
      const artistName = source.artists[source.artistIndexes[0]].name
      const album = source.tags.album
      const albumQuery =
        album && ['audio_tag', 'cue', 'manual'].includes(album.origin) && usable(album.value)
          ? ` AND release:${luceneLiteral(album.value)}`
          : ''
      url.search = new URLSearchParams({
        query: `recording:${luceneLiteral(source.tags.title!.value)} AND artist:${luceneLiteral(artistName)}${albumQuery}`,
        fmt: 'json',
        limit: String(LIMIT),
        offset: '0'
      }).toString()
      const { value: data, retrievedAt } = await this.json(url, signal)
      receipts.push({ url: url.href, retrievedAt })
      const rows = data?.recordings
      if (!Array.isArray(rows) || data?.count !== rows.length || rows.length > LIMIT) return true
      const recordings = rows.map((raw) => {
        const row = obj(raw)
        return {
          id: str(row.id).toLowerCase(),
          title: str(row.title),
          duration: typeof row.length === 'number' ? row.length / 1000 : 0,
          artists: array(row['artist-credit']).map((rawCredit) => {
            const credit = obj(rawCredit),
              artist = obj(credit.artist)
            return { id: str(artist.id).toLowerCase(), name: str(credit.name) || str(artist.name) }
          }),
          albums: array(row.releases)
            .map((release) => str(obj(release).title))
            .filter(Boolean)
        }
      })
      samples.push({ sourceId: source.sourceId, recordings })
    }
    for (const p of proposals) {
      const proof = {
        method: 'artist_recordings' as const,
        reference: p.references[0],
        sourceIds: sources.map((s) => s.sourceId),
        samples,
        toleranceSeconds: 2 as const
      }
      if (
        p.evidence.conflicts.length ||
        p.evidence.incomplete ||
        !verifyArtistRecordings(input, proof)
      )
        continue
      p.evidence.origin = 'cross_reference'
      p.evidence.verification = proof
      p.evidence.matches.push(
        'recording_titles',
        'raw_duration_2s',
        'all_track_artists',
        sources.length === 1 ? 'recording_album' : 'distinct_recordings'
      )
      p.evidence.missing = p.evidence.missing.filter((m) => m !== 'verified_identity')
      p.evidence.provenance = JSON.stringify({
        recall: JSON.parse(p.evidence.provenance),
        artistRecordings: receipts
      })
    }
    return false
  }
  async recall(input: IdentificationInput, signal: AbortSignal): Promise<IdentificationRecall> {
    const ids = this.ids(input),
      proposals: IdentificationProposal[] = [],
      reasons: string[] = []
    let incomplete = inputIncomplete(input)
    if (ids.size) {
      incomplete ||= ids.size > MAX_LOOKUPS
      if (ids.size > MAX_LOOKUPS) reasons.push('lookup_limit')
      for (const id of [...ids.keys()].slice(0, MAX_LOOKUPS)) {
        signal.throwIfAborted()
        if (!validMusicBrainzArtistId(id)) {
          reasons.push('invalid_explicit_mbid')
          incomplete = true
          continue
        }
        const url = new URL(`https://musicbrainz.org/ws/2/${MB_KIND[input.kind]}/${id}`)
        url.search = new URLSearchParams({ fmt: 'json', inc: INC[input.kind] }).toString()
        const response = await this.json(url, signal),
          data = response.value
        if (!data) {
          reasons.push('explicit_id_not_found')
          continue
        }
        const proposal =
          str(data.id).toLowerCase() === id
            ? this.proposal(input, data, 'explicit_id', url, incomplete, ids, response.retrievedAt)
            : null
        if (proposal) proposals.push(proposal)
        else {
          reasons.push('invalid_entity_identity_or_type')
          incomplete = true
        }
      }
    } else if (usable(input.name)) {
      const field = MB_KIND[input.kind]
      const query = `${input.kind === 'album_project' ? 'releasegroup' : field}:${luceneLiteral(input.name)}${input.kind !== 'artist' && usable(input.artist) ? ` AND artist:${luceneLiteral(input.artist)}` : ''}`
      const url = new URL(`https://musicbrainz.org/ws/2/${field}`)
      url.search = new URLSearchParams({
        query,
        fmt: 'json',
        limit: String(LIMIT),
        offset: '0'
      }).toString()
      const response = await this.json(url, signal),
        data = response.value
      const rows = data?.[MB_LIST[input.kind]]
      if (!Array.isArray(rows))
        throw new MetadataHttpError('invalid_musicbrainz_search_response', 400)
      incomplete ||=
        !Number.isSafeInteger(data?.count) ||
        Number(data?.count) !== rows.length ||
        rows.length > LIMIT
      for (const row of rows.slice(0, LIMIT)) {
        const proposal = this.proposal(
          input,
          row,
          'search',
          url,
          incomplete,
          ids,
          response.retrievedAt
        )
        if (proposal) proposals.push(proposal)
        else {
          reasons.push('invalid_search_item')
          incomplete = true
        }
      }
    } else reasons.push('insufficient_metadata')
    if (!ids.size && input.kind === 'artist' && proposals.length && !incomplete) {
      if (await this.verifyArtist(input, proposals, signal)) {
        incomplete = true
        reasons.push('incomplete_artist_recordings')
      }
    }
    if (!ids.size && ['album_project', 'release'].includes(input.kind) && proposals.length) {
      const layout = localAlbumLayout(input)
      if (input.kind === 'album_project' && layout.missing.length && !layout.conflicts.length) {
        await verifyMusicBrainzAlbumSubset(
          input,
          proposals,
          (url, sig) => this.json(url, sig),
          signal
        )
      } else {
        const validation = await verifyMusicBrainzAlbums(
          input,
          proposals,
          (url, sig) => this.json(url, sig),
          signal
        )
        incomplete ||= validation.incomplete
        reasons.push(...validation.reasons)
      }
    }
    incomplete ||= proposals.some((p) => p.evidence.incomplete)
    signal.throwIfAborted()
    if (incomplete) for (const p of proposals) p.evidence.incomplete = true
    return { proposals, incomplete, reasons: [...new Set(reasons)] }
  }
}

export interface IdentificationPlatform {
  id: string
  enabled: boolean
  supportedMethods: readonly string[]
  configuration: string
}
type SearchMethod = 'searchSongs' | 'searchArtists' | 'searchAlbums'
const searchMethod = (kind: CatalogKind): SearchMethod =>
  kind === 'artist' ? 'searchArtists' : kind === 'recording' ? 'searchSongs' : 'searchAlbums'
export interface PlatformIdentificationOptions {
  inventory(): IdentificationPlatform[]
  responses?: IdentificationResponseCache
  /** Optional, independent of fetchAlbumTracks and absent on older plugins. */
  albumIdentity?(id: string, albumId: string, signal: AbortSignal): Promise<unknown>
  recordingSearch?(id: string, query: string, signal: AbortSignal, offset?: number): Promise<unknown>
  artistIdentity?(id: string, artistId: string, signal: AbortSignal): Promise<unknown>
  search(
    id: string,
    method: SearchMethod,
    query: string,
    limit: number,
    offset: number,
    signal: AbortSignal
  ): Promise<unknown>
}
/** Native IDs prove only their namespace. A platform album is not an MB release-group or pressing. */
export class PlatformIdentificationProvider implements IdentificationProvider {
  readonly id: string
  readonly matcherVersion: string
  private readonly providerId: string
  private readonly options: PlatformIdentificationOptions
  private readonly responses: IdentificationResponseCache
  constructor(providerId: string, options: PlatformIdentificationOptions) {
    this.providerId = providerId
    this.id = `platform.${providerId}`
    this.matcherVersion = providerId === 'ncm' ? 'platform-verify-v8-artist-credits' : 'platform-verify-v7-public-recordings'
    this.options = options
    this.responses = options.responses ?? new IdentificationResponseCache()
  }
  private platform() {
    return this.options.inventory().find((p) => p.id === this.providerId)
  }
  supports(kind: CatalogKind) {
    if (kind === 'album_project') return false
    const methods = this.platform()?.supportedMethods ?? []
    return (
      methods.includes(searchMethod(kind)) ||
      methods.includes('searchRecordingIdentities') ||
      (kind === 'artist' && methods.includes('fetchArtistIntro')) ||
      (kind === 'release' && (methods.includes('fetchAlbumTracks') || methods.includes('fetchAlbumIdentity')))
    )
  }
  blockedReason(kind: CatalogKind) {
    return !this.platform()?.enabled
      ? 'provider_disabled'
      : !this.supports(kind)
        ? 'provider_method_not_supported'
        : null
  }
  context() {
    const p = this.platform()
    return JSON.stringify(p ? [p.id, p.enabled, p.supportedMethods, p.configuration] : null)
  }
  private native(input: IdentificationInput): IdentificationProposal[] {
    const values = new Map<string, { name: string; artist: string; duration?: number }>()
    const disagreements = new Set<string>()
    const observe = (id: string, item: { name: string; artist: string; duration?: number }) => {
      const previous = values.get(id)
      if (previous && (norm(previous.name) !== norm(item.name) ||
        norm(previous.artist) !== norm(item.artist) ||
        (previous.duration && item.duration && Math.abs(previous.duration - item.duration) > 2))) disagreements.add(id)
      values.set(id, item)
    }
    for (const s of input.sources ?? []) {
      // A local file's legacy artists.id is never a streaming-native identity.
      if (s.provider !== this.providerId) continue
      if (input.kind === 'artist')
        for (const index of s.artistIndexes) {
          const a = s.artists[index],
            id = nativeId(a?.id),
            name = str(a?.name)
          if (id && name) observe(id, { name, artist: '' })
        }
      else if (input.kind === 'recording') {
        const id = nativeId(s.trackId)
        if (id && str(s.title))
          observe(id, {
            name: str(s.title),
            artist: s.artist,
            duration: s.tags.durationSeconds?.value ?? s.duration
          })
      } else if (input.kind === 'release') {
        const id = nativeId(s.albumId)
        if (id && str(s.album))
          observe(id, { name: str(s.album), artist: s.albumArtist || s.artist })
      }
    }
    return [...values].slice(0, LIMIT).map(([id, item]) => {
      const e = evidence(
        input,
        'provider_native',
        JSON.stringify({ provider: this.providerId, origin: 'indexed_source', id })
      )
      e.matches.push('provider_native_id')
      if (values.size > 1) e.conflicts.push('multiple_native_ids')
      if (disagreements.has(id)) e.conflicts.push('contradictory_native_observations')
      e.incomplete ||= values.size > LIMIT
      compare(e, 'name', input.name, item.name)
      if (input.kind === 'recording') {
        compareDuration(e, input, item.duration)
        for (const s of input.sources ?? []) {
          if (s.tags.title) compare(e, 'raw_title', s.tags.title.value, item.name)
          compare(e, 'artist_credit', s.artist, item.artist)
        }
        e.matches = [...new Set(e.matches)]
        e.missing = [...new Set(e.missing)]
        e.conflicts = [...new Set(e.conflicts)]
      }
      if (values.size === 1 && !e.incomplete && !e.conflicts.length) {
        const reference = { provider: this.providerId, kind: input.kind, idType: 'native', value: id }
        e.verification = { method: 'provider_native', reference, sourceIds: identityProofSources(input, reference) }
      }
      return this.proposal(input, id, item.name, item.artist, e)
    })
  }
  private proposal(
    input: IdentificationInput,
    id: string,
    name: string,
    summary: string,
    e: IdentificationEvidence
  ): IdentificationProposal {
    return {
      provider: this.providerId,
      name: str(name),
      summary: str(summary, 4096),
      matcherVersion: this.matcherVersion,
      references: [{ provider: this.providerId, kind: input.kind, idType: 'native', value: id }],
      evidence: e
    }
  }
  private async recordingPage(query: string, context: string, signal: AbortSignal): Promise<PlatformRecordingPage> {
    const page: PlatformRecordingPage = { items: [], total: null }
    for (let offset = 0; offset < MAX_RECORDING_IDENTITY_RESULTS; offset += 10) {
      const response = await this.responses.read({ provider: this.id, context, method: 'searchRecordingIdentities', parameters: [query, 10, offset] }, signal, async sharedSignal => {
        const value = await this.options.recordingSearch!(this.providerId, query, sharedSignal, offset)
        return { value, retention: validPlatformRecordingPage(value) ? value.total === 0 ? 'negative' : 'positive' : false }
      })
      signal.throwIfAborted()
      if (context !== this.context()) throw new MetadataHttpError('provider_configuration_changed', 403)
      const value = response.value
      if (!validPlatformRecordingPage(value) || value.items.length > 10) throw new MetadataHttpError('invalid_provider_recording_identity', 400)
      if (offset && page.total !== value.total) { page.total = null; break }
      page.total = value.total
      page.items.push(...value.items)
      if (page.total === null || page.total > MAX_RECORDING_IDENTITY_RESULTS || page.items.length >= page.total || value.items.length < 10) break
    }
    // A changing index, duplicate row or bounded/truncated search cannot prove uniqueness.
    return validPlatformRecordingPage(page) ? page : { items: [], total: null }
  }
  private async recordingAliases(input: IdentificationInput, sourceId: string, page: PlatformRecordingPage,
    context: string, signal: AbortSignal, lookups: Set<string>) {
    if (!this.options.artistIdentity || !this.platform()!.supportedMethods.includes('fetchArtistIdentity') ||
      page.total === null || page.total > page.items.length) return
    for (const row of page.items) {
      if (!platformRecordingShapeMatches(input, sourceId, row) ||
        matchedPlatformRecordings(input, sourceId, { items: [row], total: 1 }).length) continue
      for (const artist of row.artists) {
        if (!artist.id) continue
        lookups.add(artist.id)
        if (lookups.size > 16) { page.total = null; return }
        const response = await this.responses.read({ provider: this.id, context, method: 'fetchArtistIdentity', parameters: [artist.id] }, signal, async sharedSignal => {
          const value = await this.options.artistIdentity!(this.providerId, artist.id!, sharedSignal)
          return { value, retention: validPlatformArtistIdentity(value) ? 'positive' : false }
        })
        signal.throwIfAborted()
        if (context !== this.context()) throw new MetadataHttpError('provider_configuration_changed', 403)
        const identity = response.value
        if (!validPlatformArtistIdentity(identity) || identity.id !== artist.id)
          throw new MetadataHttpError('invalid_provider_artist_identity', 400)
        artist.aliases = [...new Set([...(artist.aliases ?? []), identity.name, ...identity.aliases])].filter(name => name !== artist.name).slice(0, 32)
      }
    }
  }
  async recall(input: IdentificationInput, signal: AbortSignal): Promise<IdentificationRecall> {
    signal.throwIfAborted()
    const reason = this.blockedReason(input.kind)
    if (reason) throw new MetadataHttpError(reason, 403)
    const fileIds = this.providerId === 'ncm' ? ncmFileReferences(input) : new Map<string, string[]>()
    if (fileIds.size) return {
      proposals: [...fileIds].map(([value, sourceIds]) => {
        const reference = { provider: 'ncm', kind: input.kind, idType: 'native', value }
        const e = evidence(input, 'explicit_id', JSON.stringify({ provider: 'ncm', origin: 'audio_file_tag', value }))
        e.matches.push('file_native_id', 'raw_title', 'raw_duration_2s', 'artist_credit')
        if (fileIds.size !== 1) e.conflicts.push('multiple_native_ids')
        else e.verification = { method: 'file_native', reference, sourceIds }
        return this.proposal(input, value, input.name, input.artist, e)
      }), incomplete: false, reasons: []
    }
    const native = this.native(input)
    if (native.length)
      return {
        proposals: native,
        incomplete: native.some((p) => p.evidence.incomplete),
        reasons: []
      }
    if (this.providerId === 'ncm' && this.options.recordingSearch && this.platform()!.supportedMethods.includes('searchRecordingIdentities')) {
      const context = this.context(), samples: Array<{ sourceId: string; page: PlatformRecordingPage }> = [], lookups = new Set<string>()
      for (const source of platformRecordingSources(input)) {
        const query = [source.tags.title!.value, source.tags.artists?.value.join(' ') ?? source.tags.artist!.value].join(' ')
        let page = await this.recordingPage(query, context, signal)
        if (page.total !== null && page.total > MAX_RECORDING_IDENTITY_RESULTS &&
          source.tags.album && ['audio_tag', 'cue', 'manual'].includes(source.tags.album.origin))
          page = await this.recordingPage(`${query} ${source.tags.album.value.replace(/\s+-\s+(single|ep)$/i, '')}`, context, signal)
        await this.recordingAliases(input, source.sourceId, page, context, signal, lookups)
        samples.push({ sourceId: source.sourceId, page })
      }
      const ids = platformRecordingReferences(input, samples)
      if (ids.length) return { proposals: ids.map(value => {
        const e = evidence(input, 'search', JSON.stringify({ provider: 'ncm', method: 'searchRecordingIdentities', samples: samples.map(s => s.sourceId) }))
        e.matches.push('raw_title', 'raw_duration_2s', 'all_track_artists', 'recording_album')
        if (ids.length !== 1) e.conflicts.push('multiple_native_ids')
        else e.verification = { method: 'platform_recordings', reference: { provider: 'ncm', kind: input.kind, idType: 'native', value }, sourceIds: samples.map(s => s.sourceId), samples }
        return this.proposal(input, value, input.name, input.artist, e)
      }), incomplete: false, reasons: [] }
    }
    if (!usable(input.name))
      return {
        proposals: [],
        incomplete: inputIncomplete(input),
        reasons: ['insufficient_metadata']
      }
    const method = searchMethod(input.kind)
    if (!this.platform()!.supportedMethods.includes(method))
      return { proposals: [], incomplete: true, reasons: ['provider_search_not_supported'] }
    const query = [
      input.name,
      ...(input.kind === 'artist' || !usable(input.artist) ? [] : [input.artist])
    ].join(' ')
    const context = this.context()
    const response = await this.responses.read({
      provider: this.id, context, method, parameters: [query, LIMIT, 0]
    }, signal, async sharedSignal => {
      const page = obj(await this.options.search(this.providerId, method, query, LIMIT, 0, sharedSignal))
      if (!Array.isArray(page.items)) throw new MetadataHttpError('invalid_provider_search_response', 400)
      // Search TrackData may contain playback URLs. Retain only identity comparison fields.
      const text = (v: unknown) => typeof v === 'string' ? v : ''
      const value = {
        total: typeof page.total === 'number' ? page.total : null,
        incomplete: page.incomplete === undefined ? undefined : page.incomplete !== false,
        items: page.items.slice(0, LIMIT + 1).map(raw => {
          const row = obj(raw)
          return { id: typeof row.id === 'number' || typeof row.id === 'string' ? row.id : null,
            name: text(row.name), title: text(row.title), artist: text(row.artist),
            source: text(row.source), duration: typeof row.duration === 'number' ? row.duration : null }
        })
      }
      const valid = Number.isSafeInteger(page.total) && Number(page.total) >= page.items.length &&
        (page.incomplete === undefined || typeof page.incomplete === 'boolean') &&
        value.items.every(row => nativeId(row.id) &&
          (method === 'searchSongs' ? row.title && row.source === this.providerId : row.name))
      return {
        value,
        retention: !valid ? false : !page.items.length && page.total === 0 && !page.incomplete ? 'negative' : 'positive'
      }
    })
    const page = response.value
    signal.throwIfAborted()
    if (context !== this.context()) throw new MetadataHttpError('provider_configuration_changed', 403)
    let incomplete =
      inputIncomplete(input) ||
      (page.incomplete !== undefined && page.incomplete !== false) ||
      !Number.isSafeInteger(page.total) ||
      Number(page.total) < page.items.length ||
      Number(page.total) > page.items.length ||
      page.items.length >= LIMIT
    const reasons: string[] = [],
      proposals: IdentificationProposal[] = [], seen = new Set<string>()
    for (const raw of page.items.slice(0, LIMIT)) {
      const row = obj(raw),
        id = nativeId(row.id),
        name = str(input.kind === 'recording' ? row.title : row.name)
      if (!id || !name || (input.kind === 'recording' && row.source !== this.providerId)) {
        reasons.push('invalid_search_item')
        incomplete = true
        continue
      }
      if (seen.has(id)) {
        incomplete = true
        reasons.push('duplicate_search_identity')
        continue
      }
      seen.add(id)
      if (typeof (input.kind === 'recording' ? row.title : row.name) === 'string' &&
        String(input.kind === 'recording' ? row.title : row.name).length > 2048) incomplete = true
      const e = evidence(
        input,
        'search',
        JSON.stringify({
          provider: this.providerId,
          method,
          query,
          offset: 0,
          limit: LIMIT,
          total: page.total,
          retrievedAt: response.retrievedAt
        })
      )
      compare(e, 'name', input.name, name)
      if (input.kind !== 'artist') compare(e, 'artist_credit', input.artist, str(row.artist))
      if (input.kind === 'recording') compareDuration(e, input, row.duration)
      e.missing.push('verified_identity')
      if (input.kind === 'release')
        e.missing.push('complete_track_validation', 'pressing_disambiguation')
      proposals.push(this.proposal(input, id, name, str(row.artist), e))
    }
    for (const p of proposals) p.evidence.incomplete ||= incomplete
    if (input.kind === 'release' && proposals.length && this.options.albumIdentity &&
      this.platform()!.supportedMethods.includes('fetchAlbumIdentity')) {
      const validation = await verifyPlatformAlbums(input, proposals, this.providerId, async (id, sig) => {
        const reason = this.blockedReason(input.kind)
        if (reason || !this.platform()?.supportedMethods.includes('fetchAlbumIdentity'))
          throw new MetadataHttpError(reason ?? 'provider_method_not_supported', 403)
        const response = await this.responses.read({ provider: this.id, context,
          method: 'fetchAlbumIdentity', parameters: [id] }, sig, async sharedSignal => {
          const value = await this.options.albumIdentity!(this.providerId, id, sharedSignal)
          return { value, retention: validPlatformAlbumIdentity(value) && value.provider === this.providerId && value.id === id
            ? 'positive' : false }
        })
        if (context !== this.context()) throw new MetadataHttpError('provider_configuration_changed', 403)
        return response
      }, signal)
      incomplete ||= validation.incomplete
      reasons.push(...validation.reasons)
    }
    signal.throwIfAborted()
    return { proposals, incomplete, reasons: [...new Set(reasons)] }
  }
}
