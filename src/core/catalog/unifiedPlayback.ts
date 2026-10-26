import type { CorePlaybackSession } from '../playback/session.ts'
import type { CoreRecordingVersions } from '../playlists/recordingVersions.ts'
import { projectCoreError } from '../projections.ts'
import type {
  CatalogPlaybackSource,
  CatalogUnifiedPlaybackDatabaseApi,
  UnifiedPlaybackRequest,
  UnifiedPlaybackResult
} from '../../shared/musicUnifiedPlayback.ts'
import type { TrackData } from '../../shared/track.ts'
import { versionSourceKey } from '../../shared/trackSourceIdentity.ts'

interface Options {
  database: CatalogUnifiedPlaybackDatabaseApi
  versions: Pick<CoreRecordingVersions, 'getRevision' | 'snapshot'>
  playback: Pick<CorePlaybackSession, 'fromUnifiedTrack'>
  /** Uses the existing provider-input owner and its permission checks. */
  restore(track: TrackData, signal: AbortSignal): Promise<TrackData>
  /** Server-owned frozen query read; returns the permitted subset, never trusts client IDs. */
  assertScope?(
    request: UnifiedPlaybackRequest,
    sourceIds: string[],
    signal: AbortSignal
  ): Promise<string[]>
}

const codeOf = (error: unknown): string => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null
  return typeof code === 'string' && /^[A-Z][A-Z0-9_:-]{0,127}$/.test(code)
    ? code : 'SOURCE_UNAVAILABLE'
}
const mustStop = (error: unknown): boolean =>
  ['FORBIDDEN', 'SOURCE_ACCESS_DENIED', 'STALE_REVISION', 'CANCELLED', 'NOT_READY'].includes(codeOf(error))
const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

/** Only hand-confirmed track-version equivalence permits preparation fallback. */
export class CoreUnifiedPlaybackService {
  private readonly options: Options
  constructor(options: Options) { this.options = options }

  play(
    request: UnifiedPlaybackRequest,
    signal?: AbortSignal,
    restore: Options['restore'] = this.options.restore
  ): Promise<UnifiedPlaybackResult> {
    let selectedSourceId: string | null = null
    let preparationSignal: AbortSignal
    const revision = this.options.versions.getRevision()
    const fence = () => {
      preparationSignal.throwIfAborted()
      if (revision !== this.options.versions.getRevision())
        throw Object.assign(new Error('播放版本偏好已变化，请重新选择'), { code: 'STALE_REVISION' })
    }
    const scope = async (ids: string[]): Promise<Set<string>> => {
      fence()
      if ((request.scope || request.albumScope) && !this.options.assertScope)
        throw Object.assign(new Error('冻结来源范围验证不可用'), { code: 'NOT_READY' })
      const allowed: string[] = []
      for (let offset = 0; offset < ids.length; offset += 200)
        allowed.push(...(this.options.assertScope
          ? await this.options.assertScope(request, ids.slice(offset, offset + 200), preparationSignal)
          : ids.slice(offset, offset + 200)))
      fence()
      return new Set(allowed)
    }
    return this.options.playback.fromUnifiedTrack(async (current, prepare) => {
      preparationSignal = current
      fence()
      const result: UnifiedPlaybackResult = {
        status: 'unavailable', requestedSourceId: request.sourceId,
        sourceId: null, versionId: null, attempts: []
      }
      const anchorPage = await this.options.database.catalogPlaybackSources({
        revision: request.revision, sourceId: request.sourceId, limit: 1
      })
      fence()
      const anchor = anchorPage.items.find((item) => item.sourceId === request.sourceId)
      if (!anchor || !anchor.inLibrary) return { prepared: null, result }
      // A filtered click must itself still belong to the frozen result.
      if (!(await scope([anchor.sourceId])).has(anchor.sourceId))
        throw Object.assign(new Error('所选来源不在当前冻结结果中'), { code: 'STALE_REVISION' })

      const document = this.options.versions.snapshot().tracks
      const anchorVersion = document.versions.find((version) => version.sources.includes(anchor.sourceKey))
      const family = anchorVersion && document.families.find((item) => item.versions.includes(anchorVersion.id))
      const preferredVersion = family?.preferredVersion
        ? document.versions.find((version) => version.id === family.preferredVersion)
        : null
      const version = preferredVersion ?? anchorVersion
      result.versionId = version?.id ?? null
      const sourceKeys = version ? [...new Set(version.sources)] : [anchor.sourceKey]
      const byId = new Map<string, CatalogPlaybackSource>()
      if (!version) byId.set(anchor.sourceId, anchor)
      else for (let index = 0; index < sourceKeys.length; index += 200) {
        const keys = sourceKeys.slice(index, index + 200)
        let offset = 0, total: number
        do {
          const page = await this.options.database.catalogPlaybackSources({
            revision: request.revision, sourceKeys: keys, offset, limit: 200
          })
          fence()
          for (const item of page.items) if (keys.includes(item.sourceKey)) byId.set(item.sourceId, item)
          total = page.total
          offset += page.items.length
          if (offset >= total) break
          if (!page.items.length) throw new Error('来源分页未完成，请刷新音乐库')
        } while (offset < total)
      }
      const candidates = [...byId.values()].filter((item) => item.inLibrary)
      const allowed = await scope(candidates.map((item) => item.sourceId))
      const order = new Map((request.providerOrder ?? []).map((provider, index) => [provider, index]))
      const ranked = candidates.filter((item) => allowed.has(item.sourceId)).sort((a, b) => {
        const preferred = Number(b.sourceKey === version?.preferredSource) - Number(a.sourceKey === version?.preferredSource)
        return preferred || (order.get(a.provider) ?? order.size) - (order.get(b.provider) ?? order.size) ||
          (a.addedAt ?? Number.POSITIVE_INFINITY) - (b.addedAt ?? Number.POSITIVE_INFINITY) ||
          compareId(a.sourceId, b.sourceId)
      })
      for (const candidate of ranked) {
        fence()
        try {
          if (!candidate.track) throw Object.assign(new Error('本地来源已不在音乐库中'), { code: 'SOURCE_MISSING' })
          const track = await restore(candidate.track, current)
          fence()
          if (versionSourceKey(track) !== candidate.sourceKey)
            throw Object.assign(new Error('来源身份已变化，请刷新音乐库'), { code: 'SOURCE_IDENTITY_CHANGED' })
          const prepared = await prepare({ ...track, sourceSelection: 'explicit' })
          fence()
          if (versionSourceKey(prepared.track) !== candidate.sourceKey)
            throw Object.assign(new Error('准备结果与所选来源不一致'), { code: 'SOURCE_IDENTITY_CHANGED' })
          if (!(await scope([candidate.sourceId])).has(candidate.sourceId))
            throw Object.assign(new Error('来源已不在当前冻结结果中'), { code: 'STALE_REVISION' })
          const confirm = prepared.confirm
          prepared.confirm = () => { fence(); confirm?.() }
          selectedSourceId = candidate.sourceId
          result.status = 'played'
          result.sourceId = candidate.sourceId
          result.attempts.push({ sourceId: candidate.sourceId, provider: candidate.provider,
            status: 'selected', code: null, message: null })
          return { prepared, result }
        } catch (error) {
          fence()
          if (mustStop(error)) throw error
          let message = projectCoreError(error)
          for (const privateValue of [candidate.sourceKey, candidate.track?.filePath, candidate.track?.subTrack])
            if (privateValue) message = message.split(privateValue).join('<source>')
          message = message.replace(/(?:[a-z]:[\\/]|\\\\)[^\r\n"'<>]+/gi, '<local-source>')
          result.attempts.push({ sourceId: candidate.sourceId, provider: candidate.provider,
            status: 'failed', code: codeOf(error), message })
        }
      }
      return { prepared: null, result }
    }, signal, async () => {
      fence()
      const latest = selectedSourceId && await this.options.database.catalogPlaybackSources({
        sourceId: selectedSourceId, revision: request.revision, limit: 1
      })
      fence()
      if (!latest || !latest.items.some((item) =>
        item.sourceId === selectedSourceId && item.inLibrary && item.track
      )) throw Object.assign(new Error('播放来源已变化，请刷新音乐库'), { code: 'STALE_REVISION' })
      if (!selectedSourceId || !(await scope([selectedSourceId])).has(selectedSourceId))
        throw Object.assign(new Error('来源已不在当前冻结结果中'), { code: 'STALE_REVISION' })
    })
  }
}
