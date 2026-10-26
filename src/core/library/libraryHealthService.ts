import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import type { CatalogDatabaseApi, CatalogEntity } from '../../shared/musicCatalog.ts'
import type { EntityMetadataJob, EntityMetadataLanguage } from '../../shared/entityMetadata.ts'
import {
  HEALTH_CATEGORIES,
  HEALTH_STATES,
  type HealthCategory,
  type HealthIssueState,
  type LibraryHealthIssue,
  type LibraryHealthPageQuery,
  type LibraryHealthRepair,
  type LibraryHealthReport,
  type LibraryHealthState
} from '../../shared/libraryHealth.ts'
import type { CoreEntityMetadataService } from './entityMetadataService.ts'
import { buildInboxIssues } from './inbox.ts'
import { libraryTrack } from '../playback/libraryTrack.ts'
import { projectCoreError, projectCoreTrack } from '../projections.ts'

type Snapshot = Awaited<ReturnType<CoreEntityMetadataService['inspectHealth']>>
type Action = { entityId: string; type: 'identify' | 'enrich'; providers: string[] }
interface Options {
  database: Pick<LibraryDatabaseApi, 'queryTracks' | 'getMetadata'> &
    Pick<CatalogDatabaseApi, 'catalogQuery' | 'catalogStatus'>
  metadata: Pick<
    CoreEntityMetadataService,
    'inspectHealth' | 'policy' | 'getRevision' | 'startIdentification' | 'enrich' | 'jobs'
  >
  language(): EntityMetadataLanguage
  now(): number
  newId(): string
  changed(): void
}
const active = (job: EntityMetadataJob) => ['queued', 'running', 'retry_wait'].includes(job.state)
const emptyMetrics = () =>
  Object.fromEntries(
    HEALTH_CATEGORIES.map((k) => [
      k,
      { total: 0, present: 0, hidden: 0, missing: 0, repairable: 0 }
    ])
  ) as LibraryHealthReport['metrics']

/** A read-only diagnosis and a producer for the existing durable metadata queue. */
export class CoreLibraryHealthService {
  private readonly options: Options
  private value: LibraryHealthState = {
    phase: 'idle',
    inspected: 0,
    report: null,
    repair: null,
    error: ''
  }
  private issues: LibraryHealthIssue[] = []
  private actions = new Map<number, Action>()
  private task: Promise<void> | null = null
  private stopped = false
  private resume: (() => void) | null = null
  constructor(options: Options) {
    this.options = options
  }
  state(): LibraryHealthState {
    return structuredClone(this.value)
  }
  private launch(action: () => Promise<void>) {
    this.task = action()
      .catch((error) => {
        this.value.phase = 'failed'
        this.value.error = projectCoreError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        this.task = null
        this.options.changed()
      })
  }
  start(): LibraryHealthState {
    if (this.stopped) throw new Error('音乐库整理正在退出')
    if (this.task) return this.state()
    this.value = { ...this.value, phase: 'scanning', inspected: 0, error: '' }
    this.launch(() => this.scan())
    return this.state()
  }
  page(query: LibraryHealthPageQuery) {
    if (query.id !== this.value.report?.id) throw stale()
    const items = this.issues.filter(
      (i) =>
        (!query.category || i.category === query.category) &&
        (!query.state || i.state === query.state)
    )
    const offset = query.offset ?? 0
    return {
      id: query.id,
      total: items.length,
      offset,
      items: structuredClone(items.slice(offset, offset + (query.limit ?? 30)))
    }
  }
  private checkStopped() {
    if (this.stopped) throw new Error('音乐库整理正在退出')
  }
  private async scan() {
    const database = this.options.database,
      language = this.options.language()
    const catalog = await database.catalogStatus()
    if (catalog.localPending || catalog.dirtySources)
      throw new Error('曲库目录正在更新，请稍后重新检查')
    const report: LibraryHealthReport = {
      id: this.options.newId(),
      checkedAt: this.options.now(),
      libraryRevision: (await database.getMetadata()).revision,
      catalogRevision: catalog.revision,
      metadataRevision: this.options.metadata.getRevision(),
      language,
      totals: { tracks: 0, artists: 0, albums: 0, releases: 0 },
      metrics: emptyMetrics(),
      states: Object.fromEntries(HEALTH_STATES.map((k) => [k, 0])) as LibraryHealthReport['states'],
      policy: this.options.metadata.policy()
    }
    const issues: LibraryHealthIssue[] = [],
      actions = new Map<number, Action>()
    const add = (item: Omit<LibraryHealthIssue, 'index'>, action?: Action) => {
      const index = issues.length
      issues.push({ ...item, reason: projectCoreError(item.reason), index })
      report.states[item.state]++
      report.metrics[item.category].missing++
      if (action) {
        actions.set(index, action)
        report.metrics[item.category].repairable++
      }
    }
    for (let offset = 0; ; offset += 200) {
      this.checkStopped()
      const page = await database.queryTracks({
        sort: 'insertion',
        contentRevision: report.libraryRevision,
        offset,
        limit: 200
      })
      for (const record of page.tracks) {
        const track = libraryTrack(record)
        const findings = buildInboxIssues([track])
        report.totals.tracks++
        for (const [category, finding] of [
          ['track_tags', findings.find((i) => i.kind === 'tags')],
          ['track_cover', findings.find((i) => i.kind === 'cover')],
          [
            'track_genre',
            !track.genre?.trim()
              ? { reason: '文件没有流派标签；可在流派工作台补充分类，或预览后编辑文件标签。' }
              : null
          ]
        ] as const) {
          report.metrics[category].total++
          if (!finding) report.metrics[category].present++
          else
            add({
              category,
              state: 'manual',
              title: track.title || track.fileName,
              subtitle: [track.artist, track.album].filter(Boolean).join(' · '),
              reason: finding.reason,
              canRepair: false,
              track: projectCoreTrack(track)
            })
        }
      }
      this.value.inspected += page.tracks.length
      if (offset + page.tracks.length >= page.total) break
    }
    for (const kind of ['artist', 'album_project', 'release'] as const) {
      for (let offset = 0; ; offset += 200) {
        this.checkStopped()
        const page = await database.catalogQuery({
          kind,
          scope: 'library',
          revision: report.catalogRevision,
          offset,
          limit: 200
        })
        for (const entity of page.items) {
          this.checkStopped()
          const snapshot = await this.options.metadata.inspectHealth(entity.id, language)
          report.totals[
            kind === 'artist' ? 'artists' : kind === 'release' ? 'releases' : 'albums'
          ]++
          for (const check of entityChecks(entity, snapshot)) {
            const metric = report.metrics[check.category]
            metric.total++
            if (check.hidden) {
              metric.hidden++
              continue
            }
            if (check.present) {
              metric.present++
              continue
            }
            const decision = diagnose(
              entity,
              snapshot,
              check.category,
              report.policy.introduction,
              this.options.now()
            )
            add(
              {
                category: check.category,
                title: entity.title,
                subtitle: entity.artist,
                entity: {
                  id: entity.id,
                  kind: entity.kind,
                  title: entity.title,
                  artist: entity.artist
                },
                ...decision.issue
              },
              decision.action
            )
          }
          this.value.inspected++
        }
        if (offset + page.items.length >= page.total) break
      }
    }
    this.checkStopped()
    if (
      (await database.getMetadata()).revision !== report.libraryRevision ||
      (await database.catalogStatus()).revision !== report.catalogRevision
    )
      throw stale()
    this.issues = issues
    this.actions = actions
    this.value = { ...this.value, report, phase: 'ready', error: '' }
  }
  async repair(request: LibraryHealthRepair): Promise<LibraryHealthState> {
    if (this.stopped) throw new Error('音乐库整理正在退出')
    if (this.task) throw new Error('资料检查或补充正在进行，请等待当前操作完成')
    if ('refresh' in request) {
      this.value = { ...this.value, phase: 'scanning', inspected: 0, error: '', repair: null }
      this.launch(async () => {
        await this.scan()
        const entities = this.repairEntities()
        this.beginRepair(entities.length)
        if (entities.length) await this.fill(entities, undefined, this.value.report!.language)
        else {
          this.value.phase = 'ready'
          this.value.repair!.stage = 'completed'
        }
      })
      return this.state()
    }
    const report = this.value.report
    if (!report || report.id !== request.id || this.value.phase !== 'ready') throw stale()
    if (
      (await this.options.database.getMetadata()).revision !== report.libraryRevision ||
      (await this.options.database.catalogStatus()).revision !== report.catalogRevision
    )
      throw stale()
    // Recheck after asynchronous fences: another window may have started a batch.
    if (this.task || this.value.report?.id !== request.id) throw stale()
    const entities = this.repairEntities(request.category)
    if (!entities.length) throw new Error('当前没有可自动补全的缺项，请先处理身份复核或资料源配置')
    this.beginRepair(entities.length)
    this.launch(() => this.fill(entities, request.category, report.language))
    return this.state()
  }
  private repairEntities(category?: HealthCategory) {
    const entities = new Map<string, CatalogEntity>()
    for (const issue of this.issues) {
      if (
        (!category || issue.category === category) &&
        this.actions.has(issue.index) &&
        issue.entity
      )
        entities.set(issue.entity.id, { ...issue.entity, identity: 'source', sourceCount: 0 })
    }
    return [...entities.values()]
  }
  private beginRepair(total: number) {
    this.value = {
      ...this.value,
      phase: 'repairing',
      error: '',
      repair: {
        batchId: `health:${this.options.newId()}`,
        stage: 'queueing',
        processed: 0,
        total,
        jobs: 0,
        errors: 0,
        lastError: ''
      }
    }
  }
  private async fill(
    entities: CatalogEntity[],
    category: HealthCategory | undefined,
    language: EntityMetadataLanguage
  ) {
    const progress = this.value.repair!,
      jobs = new Set<string>(),
      identified = new Map<string, { entity: CatalogEntity; jobs: string[] }>()
    const enqueue = async (entity: CatalogEntity, followup = false) => {
      this.checkStopped()
      const snapshot = await this.options.metadata.inspectHealth(entity.id, language)
      const actions = new Map<string, Action>()
      for (const check of entityChecks(entity, snapshot)) {
        // Once identification succeeds, finish the name, biography and portrait too.
        if ((!followup && category && check.category !== category) || check.hidden || check.present)
          continue
        const decision = diagnose(
          entity,
          snapshot,
          check.category,
          this.options.metadata.policy().introduction,
          this.options.now()
        )
        if (decision.action)
          actions.set(
            decision.action.type + ':' + decision.action.providers.join(','),
            decision.action
          )
      }
      for (const action of actions.values()) {
        if (action.type === 'identify') {
          if (followup) continue
          const result = await this.options.metadata.startIdentification(
            { entityId: entity.id, batchId: progress.batchId },
            action.providers
          )
          for (const job of result.jobs) jobs.add(job.id)
          identified.set(entity.id, { entity, jobs: result.jobs.map((job) => job.id) })
        } else
          for (const provider of action.providers) {
            const job = await this.options.metadata.enrich({
              entityId: entity.id,
              batchId: progress.batchId,
              language,
              provider
            })
            jobs.add(job.id)
          }
        progress.jobs = jobs.size
      }
    }
    const attempt = async (entity: CatalogEntity, followup = false) => {
      try {
        await enqueue(entity, followup)
      } catch (error) {
        progress.errors++
        progress.lastError = projectCoreError(
          error instanceof Error ? error.message : String(error)
        )
      }
    }
    for (const entity of entities) {
      await attempt(entity)
      progress.processed++
    }
    progress.stage = 'waiting'
    this.options.changed()
    await this.waitForJobs(jobs, async (finished) => {
      // A slow or rate-limited identity must not hold up other confirmed artists.
      for (const [id, item] of identified) {
        if (!item.jobs.every((job) => finished.has(job))) continue
        identified.delete(id)
        // This rechecks identity and manual choices; it never chooses a candidate.
        await attempt(item.entity, true)
      }
    })
    this.checkStopped()
    this.value.inspected = 0
    await this.scan()
    progress.stage = 'completed'
  }
  private async waitForJobs(
    ids: Set<string>,
    followup: (finished: ReadonlySet<string>) => Promise<void>
  ) {
    const pending = new Set(ids),
      finished = new Set<string>()
    while (pending.size) {
      this.checkStopped()
      for (const id of pending) {
        const job = (await this.options.metadata.jobs({ jobId: id })).items[0]
        if (!job || !active(job)) {
          pending.delete(id)
          finished.add(id)
        }
      }
      await followup(finished)
      for (const id of ids) if (!finished.has(id)) pending.add(id)
      if (pending.size)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            this.resume = null
            resolve()
          }, 1500)
          timer.unref?.()
          this.resume = () => {
            clearTimeout(timer)
            this.resume = null
            resolve()
          }
        })
    }
  }
  async shutdown() {
    this.stopped = true
    this.resume?.()
    await this.task
  }
}

function entityChecks(entity: CatalogEntity, snapshot: Snapshot) {
  const { identity, detail, hasArtwork } = snapshot
  const confirmed = identity.link?.state === 'confirmed'
  const detached = identity.link?.state === 'detached' || detail.link?.state === 'rejected'
  const introHidden =
    detail.override?.mode === 'clear' || !!detail.imports?.some((i) => i.descriptionCleared)
  if (entity.kind === 'artist')
    return [
      { category: 'artist_identity' as const, present: confirmed, hidden: detached },
      {
        category: 'artist_name' as const,
        present: confirmed && detail.facts.some((f) => f.field === 'name' && !!f.value.trim()),
        hidden: detached
      },
      {
        category: 'artist_image' as const,
        present: !!detail.manualArtwork || hasArtwork,
        hidden: detail.artworkOverride?.mode === 'clear'
      },
      {
        category: 'artist_intro' as const,
        present: !!detail.introduction?.value.trim(),
        hidden: introHidden
      }
    ]
  if (entity.kind === 'album_project')
    return [
      { category: 'album_identity' as const, present: confirmed, hidden: detached },
      {
        category: 'album_intro' as const,
        present: !!detail.introduction?.value.trim(),
        hidden: introHidden
      }
    ]
  return [{ category: 'release_identity' as const, present: confirmed, hidden: detached }]
}

function diagnose(
  entity: CatalogEntity,
  snapshot: Snapshot,
  category: HealthCategory,
  textAllowed: boolean,
  now: number
): {
  issue: Pick<LibraryHealthIssue, 'state' | 'reason' | 'canRepair'>
  action?: Action
} {
  const issue = (state: HealthIssueState, reason: string, action?: Action) => ({
    issue: { state, reason, canRepair: !!action },
    action
  })
  if (snapshot.identity.link?.state === 'detached' || snapshot.detail.link?.state === 'rejected')
    return issue('manual', '已手工解除或拒绝身份关联，请在资料复核中决定是否重新关联。')
  const identify = snapshot.identity.link?.state !== 'confirmed'
  if (identify && snapshot.needsReview)
    return issue('review', '已有身份候选，需要核对匹配依据后确认。')
  const portrait = category === 'artist_image'
  const intro = ['artist_intro', 'album_intro'].includes(category)
  const contentProviders = snapshot.potentialEnrichment.filter((p) =>
    portrait ? p.id === 'public-artwork' || p.artwork : p.id !== 'public-artwork'
  )
  if (
    identify &&
    !['artist_identity', 'album_identity', 'release_identity'].includes(category) &&
    !contentProviders.some(
      (p) => !p.reason && !(intro && p.id === 'musicbrainz-details' && !textAllowed)
    )
  )
    return issue(
      'blocked',
      contentProviders.find((p) => p.reason)?.reason ??
        (intro && !textAllowed ? 'wikipedia_text_not_permitted' : 'provider_not_available')
    )
  const capabilities = identify
    ? snapshot.identification
    : snapshot.enrichment.filter((p) =>
        portrait ? p.id === 'public-artwork' || p.artwork : p.id !== 'public-artwork'
      )
  const available = capabilities.filter(
    (p) => !p.reason && !(intro && p.id === 'musicbrainz-details' && !textAllowed)
  )
  if (!available.length)
    return issue(
      'blocked',
      capabilities.find((p) => p.reason)?.reason ??
        (intro && !textAllowed ? 'wikipedia_text_not_permitted' : 'provider_not_available')
    )
  const relevant = snapshot.jobs
    .filter(
      (job) =>
        (identify ? job.type === 'identify' : job.type === 'enrich') &&
        available.some((p) => p.id === job.provider)
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
  if (relevant.some(active))
    return issue(
      'processing',
      identify
        ? '正在识别身份，确认后继续补充资料。'
        : '资料已进入后台队列，完成后重新检查即可查看覆盖情况。'
    )
  if (identify && relevant.some((j) => j.state === 'needs_review'))
    return issue('review', '已有身份候选，需要核对匹配依据后确认。')
  const action: Action = {
    entityId: entity.id,
    type: identify ? 'identify' : 'enrich',
    providers: available.map((p) => p.id)
  }
  // A completed request is not coverage. Respect the queue's one-day negative cache.
  const exhausted = available.every((p) =>
    relevant.some(
      (j) => j.provider === p.id && j.state === 'completed' && now - j.updatedAt < 86400000
    )
  )
  if (exhausted)
    return issue(
      'unavailable',
      '已查询当前资料源，仍未找到此项内容；可手动补充，24 小时后可再次尝试。'
    )
  const failure = relevant.find((j) => ['failed', 'blocked'].includes(j.state))
  if (failure) return issue('failed', failure.reason ?? 'metadata_response_invalid', action)
  return issue(
    'ready',
    identify
      ? '先根据原始标签识别身份，再补充规范名、头像和简介；有歧义的条目留待复核。'
      : '身份已确认，可从当前获准使用的资料源补充。',
    action
  )
}
function stale() {
  return Object.assign(new Error('曲库或检查结果已变化，请重新检查'), { code: 'STALE_REVISION' })
}
