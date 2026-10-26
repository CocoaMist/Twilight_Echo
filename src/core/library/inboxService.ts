import type { CoreStateApi } from '../../shared/coreState.ts'
import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import type {
  CoreInboxMark,
  CoreInboxPage,
  CoreInboxQuery,
  CoreInboxState,
  CoreInboxDatabase
} from '../../shared/coreInbox.ts'
import type { DuplicateDetectionResult } from '../../shared/duplicateDetection.ts'
import type { TrackData } from '../../shared/track.ts'
import { buildInboxIssues, inboxStatus, type InboxDecision, type InboxIssue } from './inbox.ts'
import { libraryTrack } from '../playback/libraryTrack.ts'
import { projectCoreError, projectCoreTrack } from '../projections.ts'

type Decision = InboxDecision & { order?: number }
interface Options {
  database: Pick<LibraryDatabaseApi, 'queryTracks' | 'getMetadata'> &
    Pick<CoreStateApi, 'coreStateRead'> &
    CoreInboxDatabase
  duplicates(id: string): { revision: number; result: DuplicateDetectionResult }
  newId(): string
  changed(): void
}

/** Review decisions and issue fingerprints belong to Core, not a mounted dialog. */
export class CoreInboxService {
  private readonly options: Options
  private decisions = new Map<string, Decision>()
  private revision = 0
  private order = 0
  private uncertain = false
  private view: { id: string; libraryRevision: number; issues: InboxIssue[] } | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private stopped = false
  private summary: CoreInboxState | null = null
  constructor(options: Options) {
    this.options = options
  }

  async initialize(): Promise<void> {
    const rows: Array<[string, Decision]> = []
    let after: string | undefined, revision: number | undefined
    do {
      const page = await this.options.database.coreStateRead('inbox', after, 128, revision)
      revision = page.revision
      rows.push(...page.rows.map((row): [string, Decision] => [row.key, row.value as Decision]))
      after = page.next ?? undefined
    } while (after !== undefined)
    // New imports preserve the browser Map's insertion order. Rows imported by
    // an earlier staged build retain their existing key order until marked again.
    rows.sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0))
    this.decisions = new Map(rows)
    this.order = rows.reduce((max, [, value]) => Math.max(max, value.order ?? 0), 0)
    this.revision = revision!
    this.uncertain = false
    this.updateSummary()
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('整理收件箱正在退出'))
    const work = this.tail.catch(() => {}).then(action)
    this.tail = work
    return work
  }
  refresh(duplicatesId?: string): Promise<CoreInboxState> {
    return this.enqueue(async () => {
      if (this.uncertain) await this.initialize()
      const evidence = duplicatesId ? this.options.duplicates(duplicatesId) : null
      const tracks: TrackData[] = []
      let revision: number | undefined
      for (let offset = 0; ; offset += 200) {
        if (this.stopped) throw new Error('整理收件箱正在退出')
        const page = await this.options.database.queryTracks({
          sort: 'insertion',
          contentRevision: revision,
          offset,
          limit: 200
        })
        revision = page.revision
        if (evidence && evidence.revision !== revision)
          throw stale('曲库已变化，请重新检查重复曲目')
        tracks.push(...page.tracks.map(libraryTrack))
        if (offset + page.tracks.length >= page.total) break
      }
      if (this.stopped) throw new Error('整理收件箱正在退出')
      this.view = {
        id: this.options.newId(),
        libraryRevision: revision!,
        issues: buildInboxIssues(tracks, evidence?.result)
      }
      this.updateSummary()
      this.options.changed()
      return this.state()!
    })
  }
  state(): CoreInboxState | null {
    return this.summary ? structuredClone(this.summary) : null
  }
  private updateSummary(): void {
    if (!this.view) return
    const empty = () => ({ cover: 0, tags: 0, enrichment: 0, duplicate: 0 })
    const counts = { pending: empty(), ignored: empty(), done: empty() }
    for (const issue of this.view.issues) counts[inboxStatus(issue, this.decisions)][issue.kind]++
    this.summary = {
      id: this.view.id,
      libraryRevision: this.view.libraryRevision,
      revision: this.revision,
      total: this.view.issues.length,
      counts
    }
  }
  page(query: CoreInboxQuery): Promise<CoreInboxPage> {
    return this.enqueue(async () => {
      if (this.uncertain) await this.initialize()
      const view = this.current(query)
      const items: CoreInboxPage['items'] = []
      const offset = query.offset ?? 0,
        limit = query.limit ?? 50
      let total = 0
      for (const [index, issue] of view.issues.entries()) {
        const status = inboxStatus(issue, this.decisions)
        if ((query.kind && query.kind !== issue.kind) || (query.status && query.status !== status))
          continue
        if (total >= offset && items.length < limit)
          items.push({
            index,
            status,
            kind: issue.kind,
            reason: projectCoreError(issue.reason),
            track: projectCoreTrack(issue.track)
          })
        total++
      }
      return { state: this.state()!, total, offset, items }
    })
  }
  mark(command: CoreInboxMark): Promise<CoreInboxState> {
    return this.enqueue(async () => {
      if (this.uncertain) await this.initialize()
      const view = this.current(command)
      if ((await this.options.database.getMetadata()).revision !== view.libraryRevision)
        throw stale('曲库已变化，请刷新整理收件箱')
      const next = new Map(this.decisions)
      const changed = new Set<string>()
      for (const index of new Set(command.indexes)) {
        const issue = view.issues[index]
        if (!issue) throw stale('整理问题不存在，请刷新')
        changed.add(issue.key)
        next.delete(issue.key)
        if (command.status !== 'pending')
          next.set(issue.key, {
            fingerprint: issue.fingerprint,
            status: command.status,
            order: ++this.order
          })
      }
      while (next.size > 20000) {
        const oldest = next.keys().next().value!
        next.delete(oldest)
        changed.add(oldest)
      }
      const rows = [...changed]
        .filter((key) => next.has(key))
        .map((key) => ({ key, value: next.get(key)! }))
      const deletes = [...changed].filter((key) => !next.has(key))
      try {
        this.revision = await this.options.database.coreInboxWrite(
          rows,
          this.revision,
          deletes,
          view.libraryRevision
        )
        this.decisions = next
        this.updateSummary()
      } catch (error) {
        this.uncertain = true
        await this.initialize()
        this.options.changed()
        throw error
      }
      this.options.changed()
      return this.state()!
    })
  }
  private current(expected: { id: string; revision: number }) {
    if (this.view?.id !== expected.id || this.revision !== expected.revision)
      throw stale('整理记录已变化，请刷新')
    return this.view
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    await this.tail.catch(() => {})
  }
}
function stale(message: string): Error {
  return Object.assign(new Error(message), { code: 'STALE_REVISION' })
}
