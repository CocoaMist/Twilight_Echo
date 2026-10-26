import type { TwilightPluginManager } from './manager.ts'
import type { LegacyMusicTaskWork, LegacyMusicLookupResult } from '../../shared/legacyMusicTasks.ts'
import type { EntityMetadataResult } from '../../shared/entityMetadata.ts'
import { AlbumIntroductionProvider } from './rhine-vendor/album-introductions.mjs'
import { QQCreditsProvider } from './rhine-vendor/qq-credits.mjs'
import { MusicBrainzProvider } from './rhine-vendor/musicbrainz.mjs'
import {
  publicMetadataHttp,
  MetadataHttpError,
  retryAfter,
  metadataDelay
} from '../library/metadataHttp.ts'

export interface LegacyMusicLookupProvider {
  blockedReason(work: LegacyMusicTaskWork): Promise<string | null>
  lookup(
    work: LegacyMusicTaskWork,
    attempts: number,
    signal: AbortSignal
  ): Promise<Extract<EntityMetadataResult, { state: 'legacy_result' }>>
}
interface Options {
  plugins: Pick<TwilightPluginManager, 'list'>
  /** A deployment can disable an old capability, without making an omitted
   * new automatic-enrichment setting a prerequisite for existing manual use. */
  disabled?(operation: LegacyMusicTaskWork['operation']): string | null
  fetcher?: typeof fetch
  now?: () => number
}
export function createLegacyMusicLookupProvider(options: Options): LegacyMusicLookupProvider {
  const now = options.now ?? Date.now
  const plugin = async (id: string) =>
    (await options.plugins.list()).find((p) => p.id === id && p.enabled)
  const blockedReason = async (work: LegacyMusicTaskWork) => {
    const active = await plugin(work.pluginId)
    if (!active) return 'experience_disabled'
    if (!active.permissions.includes('library:write') || !active.permissions.includes('network'))
      return 'experience_permission_required'
    return options.disabled?.(work.operation) ?? null
  }
  return {
    blockedReason,
    async lookup(work, attempts, signal) {
      const active = (await plugin(work.pluginId))!
      let http: MetadataHttpError | null = null
      let textBlocked: string | null = null
      const fetcher: typeof fetch = async (input, init: RequestInit = {}) => {
        signal.throwIfAborted()
        const blocked = await blockedReason(work)
        if (blocked) throw new Error(blocked)
        if (
          work.operation === 'enrich' &&
          ['www.wikidata.org', 'zh.wikipedia.org', 'en.wikipedia.org'].includes(
            new URL(String(input)).hostname
          )
        ) {
          textBlocked = options.disabled?.('introductions') ?? null
          if (textBlocked) throw new Error(textBlocked)
        }
        const response = await (options.fetcher ?? publicMetadataHttp.fetch)(input, {
          ...init,
          signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])])
        })
        if (!response.ok)
          http = new MetadataHttpError(
            `资料来源 HTTP ${response.status}`,
            response.status,
            retryAfter(response.headers.get('retry-after'), now())
          )
        return response
      }
      let lookup: LegacyMusicLookupResult
      if (work.operation === 'credits') {
        const credits = new QQCreditsProvider({
          dataDir: active.paths.dataDir,
          fetcher,
          now,
          signal,
          sleep: (ms) => metadataDelay(ms, signal)
        })
        lookup = {
          operation: 'credits',
          value: await credits.lookup(work.album, { force: work.force })
        }
      } else if (work.operation === 'introductions') {
        lookup = {
          operation: 'introductions',
          value: await new AlbumIntroductionProvider({
            fetcher,
            contact: () => work.contact,
            intervalMs: 0
          }).lookup(work.album)
        }
      } else {
        lookup = {
          operation: 'enrich',
          value: await new MusicBrainzProvider({ fetcher, contact: work.contact }).lookup(
            work.album
          )
        }
      }
      signal.throwIfAborted()
      const status = lookup.operation === 'enrich' ? lookup.value.online : lookup.value
      const retry = lookup.operation === 'credits' ? Date.parse(lookup.value.retryAt ?? '') : NaN
      // Vendor adapters retain partial work and expose errors in their original
      // result. Translate those states instead of treating a resolved Promise as
      // success. HTTP cool-down and useful partial credits survive together.
      const failure = http as MetadataHttpError | null
      const descriptionError =
        lookup.operation === 'enrich' && lookup.value.online?.descriptionStatus === 'error'
          ? (lookup.value.online.descriptionError ?? 'legacy_introduction_error')
          : null
      const reason = status?.error ?? textBlocked ?? descriptionError ?? failure?.message ?? null
      const error =
        status?.status === 'error' ||
        (!!descriptionError && !textBlocked) ||
        !!failure ||
        Number.isFinite(retry)
      const retryable = !failure || [408, 429, 500, 502, 503, 504].includes(failure.status)
      const blocked = failure && [401, 403].includes(failure.status)
      return {
        state: 'legacy_result',
        lookup,
        taskState: blocked
          ? 'blocked'
          : error
            ? retryable && attempts < 5
              ? 'retry_wait'
              : 'failed'
            : status?.status === 'uncertain'
              ? 'needs_review'
              : 'completed',
        outcome:
          status?.status === 'matched'
            ? textBlocked
              ? 'partial'
              : 'matched'
            : status?.status === 'partial'
              ? 'partial'
              : 'not_found',
        reason: reason ?? (status?.status === 'uncertain' ? 'legacy_lookup_uncertain' : null),
        ...(error && retryable && attempts < 5
          ? {
              nextAttemptAt: Math.max(
                Number.isFinite(retry) ? retry : 0,
                failure?.retryAt ?? 0,
                now() + Math.min(300000, 1000 * 2 ** attempts)
              )
            }
          : {})
      }
    }
  }
}
