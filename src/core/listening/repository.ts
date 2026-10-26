import { coreStateBatches, type CoreStateApi, type CoreStateRow } from '../../shared/coreState.ts'
import type {
  CoreStatisticsApi,
  CoreStatisticsCheckpoint,
  CoreStatisticsDomain,
  CoreStatisticsRevision
} from '../../shared/coreStatistics.ts'
import type { ListeningStats } from '../../shared/listeningStats.ts'
import { normalizeNumberRecord, normalizeTrackStats } from './model.ts'

export interface StatisticsCheckpoint {
  replace: boolean
  tracks: CoreStateRow[]
  days: CoreStateRow[]
}
const equal = (a: CoreStatisticsRevision, b: CoreStatisticsRevision) =>
  a.tracks === b.tracks && a.days === b.days

/** Absolute checkpoints, not counter-increment RPCs. Read recovery determines
 * the last operation's outcome; no unknown begin/stage/commit is replayed. */
export class CoreStatisticsRepository {
  private revision: CoreStatisticsRevision | null = null
  private pending: { id: string; before: CoreStatisticsRevision } | null = null
  private readonly options: {
    database: CoreStatisticsApi & Pick<CoreStateApi, 'coreStateRead'>
    newId(): string
  }
  constructor(options: CoreStatisticsRepository['options']) {
    this.options = options
  }

  async load(): Promise<ListeningStats> {
    const { database } = this.options
    const status = await database.coreStatisticsStatus()
    // An interrupted, unpublished checkpoint cannot be completed on behalf of
    // the dead Core. Its source of truth is still the last committed rows.
    if (status.operation && !status.operation.committed) await this.discard(status.operation.id)
    const read = async (domain: CoreStatisticsDomain, revision: number) => {
      const entries: [string, unknown][] = []
      let after: string | undefined
      do {
        const page = await database.coreStateRead(domain, after, 128, revision)
        entries.push(...page.rows.map((row) => [row.key, row.value] as [string, unknown]))
        after = page.next ?? undefined
      } while (after !== undefined)
      return Object.fromEntries(entries)
    }
    const tracks = await read('statistics-tracks', status.revision.tracks)
    const days = await read('statistics-days', status.revision.days)
    const latest = await database.coreStatisticsStatus()
    if (!equal(latest.revision, status.revision))
      throw new Error('Statistics changed during hydration')
    this.revision = status.revision
    return { tracks: normalizeTrackStats(tracks), days: normalizeNumberRecord(days) }
  }

  /** Called before a new checkpoint after any failure. Returns whether the
   * previous checkpoint committed, so its capture can be acknowledged exactly once. */
  async recover(): Promise<boolean | null> {
    if (!this.pending) return null
    const pending = this.pending
    const status = await this.options.database.coreStatisticsStatus()
    let committed = false
    if (status.operation?.id === pending.id) {
      committed = status.operation.committed
      if (committed) {
        if (
          !equal(status.revision, {
            tracks: pending.before.tracks + 1,
            days: pending.before.days + 1
          })
        )
          throw new Error('Statistics revision conflict after checkpoint recovery')
        this.revision = status.revision
      } else {
        if (!equal(status.revision, pending.before)) throw new Error('Statistics revision conflict')
        await this.discard(pending.id)
      }
    } else if (!equal(status.revision, pending.before)) {
      throw new Error('Statistics checkpoint outcome cannot be reconciled')
    }
    this.pending = null
    return committed
  }
  private async discard(id: string): Promise<void> {
    try {
      await this.options.database.coreStatisticsAbort(id)
    } catch (error) {
      const status = await this.options.database.coreStatisticsStatus()
      if (status.operation?.id === id) throw error
    }
  }
  async publish(checkpoint: StatisticsCheckpoint): Promise<void> {
    if (!this.revision || this.pending)
      throw new Error('Statistics repository requires hydration/read recovery')
    const { database } = this.options
    const batches: { domain: CoreStatisticsDomain; rows: CoreStateRow[] }[] = []
    for (const domain of ['statistics-tracks', 'statistics-days'] as const) {
      const rows = domain === 'statistics-tracks' ? checkpoint.tracks : checkpoint.days
      async function* pages() {
        yield rows
      }
      for await (const rows of coreStateBatches(domain, pages())) batches.push({ domain, rows })
    }
    const id = this.options.newId(),
      before = { ...this.revision }
    this.pending = { id, before }
    // Keep pending on failure until a status read distinguishes a durable
    // commit from invisible stages. No failed mutation is sent a second time.
    await this.confirm(
      () => database.coreStatisticsBegin(id, before, batches.length, checkpoint.replace),
      (status) =>
        status.operation?.id === id &&
        status.operation.nextBatch === 0 &&
        !status.operation.committed
    )
    for (let index = 0; index < batches.length; index++) {
      const batch = batches[index]
      await this.confirm(
        () => database.coreStatisticsStage(id, index, batch.domain, batch.rows),
        (status) =>
          status.operation?.id === id &&
          status.operation.nextBatch === index + 1 &&
          !status.operation.committed
      )
    }
    const committed = await this.confirm(
      () => database.coreStatisticsCommit(id),
      (status) =>
        status.operation?.id === id &&
        status.operation.committed &&
        status.operation.nextBatch === batches.length
    )
    if (!equal(committed.revision, { tracks: before.tracks + 1, days: before.days + 1 }))
      throw new Error('Invalid statistics checkpoint acknowledgement')
    this.revision = committed.revision
    this.pending = null
  }
  private async confirm(
    operation: () => Promise<CoreStatisticsCheckpoint>,
    accepted: (status: CoreStatisticsCheckpoint) => boolean
  ): Promise<CoreStatisticsCheckpoint> {
    let result: CoreStatisticsCheckpoint
    try {
      result = await operation()
    } catch (error) {
      result = await this.options.database.coreStatisticsStatus()
      if (!accepted(result)) throw error
    }
    if (!accepted(result)) throw new Error('Invalid statistics checkpoint acknowledgement')
    return result
  }
}
