import type { CatalogKind } from '../../shared/musicCatalog.ts'
import { MetadataHttpError, publicMetadataHttp, retryAfter } from './metadataHttp.ts'

const mbid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i

/** Native IDs work independently. MB identities may follow one exact official
 * URL relationship; names, aliases and search rankings never prove identity. */
export function ncmMetadataIdentity(
  policy: () => { publicServiceApproved: boolean; contact: string },
  fetcher = publicMetadataHttp.fetch
) {
  return {
    // MB service eligibility governs the optional request, not already resolved
    // native records or their independent NCM display/cache permissions.
    context: () => 'ncm-exact-link-v1',
    async resolve(
      kind: CatalogKind,
      externalId: string,
      signal: AbortSignal
    ): Promise<string | null> {
      signal.throwIfAborted()
      if (!['artist', 'release'].includes(kind)) throw new Error('Invalid NCM metadata identity')
      if (/^[1-9]\d{0,15}$/.test(externalId)) return externalId
      if (!mbid.test(externalId)) throw new Error('Invalid NCM metadata identity')
      const p = policy()
      const expected = JSON.stringify([p.publicServiceApproved, p.contact])
      const assertCurrent = () => {
        signal.throwIfAborted()
        if (expected !== JSON.stringify([policy().publicServiceApproved, policy().contact]))
          throw new MetadataHttpError('provider_configuration_changed', 403)
      }
      if (!p.publicServiceApproved) throw new MetadataHttpError('public_service_not_approved', 403)
      if (!p.contact.trim()) throw new MetadataHttpError('missing_application_contact', 403)
      const response = await fetcher(
        new URL(
          `https://musicbrainz.org/ws/2/${kind}/${externalId.toLowerCase()}?inc=url-rels&fmt=json`
        ),
        {
          signal,
          headers: { Accept: 'application/json', 'User-Agent': `TwilightEcho/1.0 (${p.contact})` }
        }
      )
      assertCurrent()
      if (response.status === 404) return null
      if (!response.ok)
        throw new MetadataHttpError(
          `musicbrainz_http_${response.status}`,
          response.status,
          retryAfter(response.headers.get('retry-after'), Date.now())
        )
      const body = (await response.json()) as {
        id?: unknown
        relations?: Array<{ 'target-type'?: unknown; url?: { resource?: unknown } }>
      }
      if (
        typeof body.id !== 'string' ||
        body.id.toLowerCase() !== externalId.toLowerCase() ||
        !Array.isArray(body.relations)
      )
        throw new Error('Invalid MusicBrainz URL relationship response')
      const ids = new Set<string>()
      for (const relation of body.relations) {
        if (relation?.['target-type'] !== 'url' || typeof relation.url?.resource !== 'string')
          continue
        try {
          const u = new URL(relation.url.resource)
          if (
            !['https:', 'http:'].includes(u.protocol) ||
            u.hostname !== 'music.163.com' ||
            u.port ||
            u.username ||
            u.password
          )
            continue
          // Accept canonical /artist?id= and /#/artist?id=, not nested redirect URLs.
          const path = u.hash ? u.hash.slice(1) : u.pathname + u.search
          if (u.hash && (u.pathname !== '/' || u.search)) continue
          const match = new RegExp(
            `^/${kind === 'artist' ? 'artist' : 'album'}\\?id=([1-9]\\d{0,15})$`
          ).exec(path)
          if (match) ids.add(match[1])
        } catch {
          /* Not a canonical platform entity URL. */
        }
      }
      assertCurrent()
      return ids.size === 1 ? [...ids][0] : null
    }
  }
}
