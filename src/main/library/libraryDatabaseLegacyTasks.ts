import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  EntityMetadataJob,
  EntityMetadataResult,
  EntityMetadataWork
} from '../../shared/entityMetadata.ts'
import type {
  LegacyMusicTaskDatabaseApi,
  LegacyMusicTaskSeed,
  LegacyMusicTaskWork,
  LegacyMusicTaskStatus,
  LegacyMusicLookup
} from '../../shared/legacyMusicTasks.ts'
import { legacyMusicLookup } from '../../shared/legacyMusicTasks.ts'
import type { LibraryDatabaseLegacyMusic } from './libraryDatabaseLegacyMusic.ts'

export const LEGACY_MUSIC_TASK_SCHEMA_SQL = `
ALTER TABLE metadata_legacy_documents ADD COLUMN input_revision INTEGER NOT NULL DEFAULT 0;
UPDATE metadata_legacy_documents SET input_revision=revision;
CREATE TABLE metadata_legacy_inputs(plugin_id TEXT NOT NULL,legacy_id TEXT NOT NULL,revision INTEGER NOT NULL,
  PRIMARY KEY(plugin_id,legacy_id));
INSERT INTO metadata_legacy_inputs SELECT a.plugin_id,a.legacy_id,d.revision
  FROM metadata_legacy_albums a JOIN metadata_legacy_documents d USING(plugin_id);
CREATE TABLE metadata_legacy_batches(id TEXT PRIMARY KEY,plugin_id TEXT NOT NULL,operation TEXT NOT NULL,
  state TEXT NOT NULL,expected INTEGER NOT NULL,document_revision INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX metadata_legacy_batches_latest ON metadata_legacy_batches(plugin_id,operation,created_at DESC);
CREATE INDEX metadata_jobs_legacy_batch ON metadata_jobs(json_extract(payload,'$.legacy.batchId'));
`
interface Owner {
  sql: DatabaseSync
  transaction<T>(action: () => T): T
  contentRevision(): number
  albumAliases(id: string): string[]
  music(): LibraryDatabaseLegacyMusic
  save(job: EntityMetadataJob, input?: string, key?: string): void
}
const uint = (n: number) => Number.isSafeInteger(n) && n >= 0
const stale = () =>
  Object.assign(new Error('音乐资料或曲库已变化，请重新读取后查询'), { code: 'STALE_REVISION' })
const decode = (row: Record<string, unknown>) =>
  JSON.parse(String(row.payload)) as EntityMetadataJob

/** Source-scoped compatibility tasks use metadata_jobs and its one Core worker.
 * This class supplies batch publication, source fences and the legacy commit;
 * it never starts another query loop or owns a network request. */
export class LibraryDatabaseLegacyTasks {
  private readonly sql: DatabaseSync
  private readonly owner: Owner
  constructor(owner: Owner) {
    this.owner = owner
    this.sql = owner.sql
  }
  private batch(id: string) {
    const row = this.sql.prepare('SELECT * FROM metadata_legacy_batches WHERE id=?').get(id)
    if (!row) throw new Error('资料查询批次不存在')
    return row
  }
  private latest(pluginId: string, operation: LegacyMusicLookup) {
    return this.sql
      .prepare(
        'SELECT id FROM metadata_legacy_batches WHERE plugin_id=? AND operation=? ORDER BY created_at DESC,rowid DESC LIMIT 1'
      )
      .get(pluginId, operation)
  }
  status(pluginId: string, operation: LegacyMusicLookup): LegacyMusicTaskStatus | null {
    if (!legacyMusicLookup(operation)) throw new Error('Invalid legacy lookup')
    const latest = this.latest(pluginId, operation)
    return latest ? this.describe(String(latest.id)) : null
  }
  private describe(id: string): LegacyMusicTaskStatus {
    const batch = this.batch(id)
    const counts = this.sql
      .prepare(
        `SELECT state,json_extract(payload,'$.outcome') outcome,count(*) n
      FROM metadata_jobs WHERE json_extract(payload,'$.legacy.batchId')=? GROUP BY state,outcome`
      )
      .all(id)
    const count = (...states: string[]) =>
      counts
        .filter((row) => states.includes(String(row.state)))
        .reduce((n, row) => n + Number(row.n), 0)
    const terminal = count('completed', 'needs_review', 'failed', 'blocked', 'cancelled')
    const outcome = (value: string) =>
      counts
        .filter(
          (row) =>
            (value === 'not_found' ? row.state === 'completed' : row.state !== 'cancelled') &&
            row.outcome === value
        )
        .reduce((n, row) => n + Number(row.n), 0)
    const active = this.sql
      .prepare(
        `SELECT payload FROM metadata_jobs WHERE json_extract(payload,'$.legacy.batchId')=? AND state='running' LIMIT 1`
      )
      .get(id)
    const error = this.sql
      .prepare(
        `SELECT json_extract(payload,'$.reason') reason FROM metadata_jobs
      WHERE json_extract(payload,'$.legacy.batchId')=? AND state IN ('retry_wait','failed','blocked','needs_review','cancelled')
      AND json_extract(payload,'$.reason') IS NOT NULL ORDER BY json_extract(payload,'$.updatedAt') DESC,rowid DESC LIMIT 1`
      )
      .get(id)
    const due = this.sql
      .prepare(
        `SELECT min(next_attempt) due FROM metadata_jobs WHERE json_extract(payload,'$.legacy.batchId')=? AND state='retry_wait'`
      )
      .get(id)!.due
    return {
      batchId: id,
      state: batch.state as LegacyMusicTaskStatus['state'],
      running:
        batch.state === 'staging' ||
        (batch.state === 'published' && count('queued', 'running', 'retry_wait') > 0),
      total: Number(batch.expected),
      completed: terminal,
      updated: outcome('matched') + outcome('partial'),
      notFound: outcome('not_found'),
      failed: count('failed'),
      needsReview: count('needs_review'),
      blocked: count('blocked'),
      retrying: count('retry_wait'),
      cancelled: count('cancelled'),
      currentAlbum: active ? decode(active).legacy!.title : '',
      error:
        batch.state === 'abandoned'
          ? '查询提交中断，请重新发起；未提交的批次未执行'
          : String(error?.reason ?? ''),
      nextAttemptAt: due === null ? null : Number(due)
    }
  }
  begin(request: Parameters<LegacyMusicTaskDatabaseApi['legacyMusicBatchBegin']>[0], now: number) {
    if (
      !request.id ||
      !request.pluginId ||
      !legacyMusicLookup(request.operation) ||
      !uint(request.expected) ||
      request.expected > 100000
    )
      throw new Error('Invalid legacy query batch')
    return this.owner.transaction(() => {
      const latest = this.status(request.pluginId, request.operation)
      if (latest?.running) return latest
      const document = this.owner.music().read(request.pluginId)
      if (!document || !this.documentValid(request.pluginId, request.documentRevision))
        throw stale()
      this.sql
        .prepare("INSERT INTO metadata_legacy_batches VALUES(?,?,?,'staging',?,?,?)")
        .run(
          request.id,
          request.pluginId,
          request.operation,
          request.expected,
          request.documentRevision,
          now
        )
      this.owner.music().checkpoint(request.pluginId)
      return this.describe(request.id)
    })
  }
  stage(batchId: string, entries: LegacyMusicTaskSeed[], now: number) {
    if (!Array.isArray(entries) || entries.length > 50) throw new Error('Invalid legacy task page')
    return this.owner.transaction(() => {
      const batch = this.batch(batchId)
      if (batch.state !== 'staging') throw stale()
      const document = this.owner.music().read(String(batch.plugin_id))
      if (
        !document ||
        !this.documentValid(String(batch.plugin_id), Number(batch.document_revision))
      )
        throw stale()
      const config = document.value.config as { musicBrainzContact?: string } | undefined
      for (const entry of entries) {
        if (entry.contentRevision !== this.owner.contentRevision()) throw stale()
        const ref = {
          pluginId: String(batch.plugin_id),
          batchId,
          albumId: entry.album.id,
          operation: batch.operation as LegacyMusicLookup,
          title: entry.album.title
        }
        const legacy: LegacyMusicTaskWork = {
          ...ref,
          album: entry.album,
          collectionId: entry.collectionId,
          force: entry.force,
          contact: config?.musicBrainzContact ?? ''
        }
        const fence = this.fence(legacy)
        if (!fence) throw stale()
        const key = JSON.stringify(['legacy', batchId, entry.album.id])
        if (this.sql.prepare('SELECT 1 FROM metadata_jobs WHERE task_key=?').get(key)) continue
        const job: EntityMetadataJob = {
          id: randomUUID(),
          entityId: entry.album.id,
          type: 'legacy',
          provider: `legacy.${ref.operation}`,
          language: 'zh-Hans',
          externalId: '',
          state: 'queued',
          generation: 1,
          attempts: 0,
          nextAttemptAt: now,
          outcome: null,
          reason: null,
          candidate: null,
          updatedAt: now,
          legacy: ref
        }
        const input = JSON.stringify({ legacy, fence })
        if (Buffer.byteLength(input) > 16 * 1024 * 1024)
          throw new Error('Legacy task exceeds 16 MiB')
        this.owner.save(job, input, key)
        this.sql.prepare('INSERT INTO metadata_demands VALUES(?,?)').run(job.id, batchId)
      }
      const count = Number(
        this.sql
          .prepare(
            "SELECT count(*) n FROM metadata_jobs WHERE json_extract(payload,'$.legacy.batchId')=?"
          )
          .get(batchId)!.n
      )
      if (count > Number(batch.expected))
        throw new Error('Legacy query inventory exceeds selection')
    })
  }
  publish(batchId: string, _now: number) {
    return this.owner.transaction(() => {
      const batch = this.batch(batchId)
      if (batch.state === 'published') return this.describe(batchId)
      if (
        batch.state !== 'staging' ||
        !this.documentValid(String(batch.plugin_id), Number(batch.document_revision))
      )
        throw stale()
      const count = Number(
        this.sql
          .prepare(
            "SELECT count(*) n FROM metadata_jobs WHERE json_extract(payload,'$.legacy.batchId')=?"
          )
          .get(batchId)!.n
      )
      if (count !== Number(batch.expected)) throw new Error('Legacy query inventory is incomplete')
      this.sql
        .prepare("UPDATE metadata_legacy_batches SET state='published' WHERE id=?")
        .run(batchId)
      return this.describe(batchId)
    })
  }
  private documentValid(pluginId: string, revision: number): boolean {
    const row = this.sql
      .prepare(
        "SELECT revision,input_revision FROM metadata_legacy_documents WHERE plugin_id=? AND state='published'"
      )
      .get(pluginId)
    // Automatic patches may advance the document during batch staging. Manual
    // edits still invalidate the original selection, even after A-B-A changes.
    return (
      uint(revision) &&
      !!row &&
      revision >= Number(row.input_revision) &&
      revision <= Number(row.revision)
    )
  }
  private fence(work: LegacyMusicTaskWork): string | null {
    const document = this.sql
      .prepare("SELECT base FROM metadata_legacy_documents WHERE plugin_id=? AND state='published'")
      .get(work.pluginId)
    if (!document) return null
    const tracks = this.sql
      .prepare(
        `SELECT id,version FROM tracks WHERE album_key IN (SELECT value FROM json_each(?)) ORDER BY id`
      )
      .all(JSON.stringify(this.owner.albumAliases(work.collectionId)))
    const members = new Set(work.album.tracks.map((track) => track.id))
    if (
      !tracks.length ||
      tracks.length !== work.album.tracks.length ||
      tracks.some((track) => !members.has(String(track.id)))
    )
      return null
    const input = this.sql
      .prepare('SELECT revision FROM metadata_legacy_inputs WHERE plugin_id=? AND legacy_id=?')
      .get(work.pluginId, work.albumId)
    const config = JSON.parse(String(document.base)).config
    return JSON.stringify([
      tracks,
      input?.revision ?? 0,
      work.operation === 'credits' ? '' : (config?.musicBrainzContact ?? '')
    ])
  }
  work(input: string): LegacyMusicTaskWork {
    return JSON.parse(input).legacy
  }
  valid(input: string): boolean {
    const saved = JSON.parse(input) as { legacy: LegacyMusicTaskWork; fence: string }
    return (
      this.batch(saved.legacy.batchId).state === 'published' &&
      this.fence(saved.legacy) === saved.fence
    )
  }
  apply(
    work: EntityMetadataWork,
    result: Extract<EntityMetadataResult, { state: 'legacy_result' }>
  ) {
    if (!work.legacy) throw new Error('Legacy query input missing')
    this.owner.music().applyLookup(work.legacy, result.lookup)
  }
  settled(
    work: EntityMetadataWork,
    state: string,
    reason: string | null,
    nextAttemptAt: number | undefined,
    now: number
  ) {
    const batchId = work.legacy!.batchId
    if (state === 'retry_wait') {
      // Do not fan a source failure out over the rest of an accepted batch.
      // The same durable due time is respected after a worker replacement.
      this.sql
        .prepare(
          `UPDATE metadata_jobs SET next_attempt=max(next_attempt,?),
        payload=json_set(payload,'$.nextAttemptAt',max(next_attempt,?))
        WHERE json_extract(payload,'$.legacy.batchId')=? AND state='queued'`
        )
        .run(nextAttemptAt ?? now, nextAttemptAt ?? now, batchId)
    }
    const last =
      state === 'failed'
        ? this.sql
            .prepare(
              `SELECT state FROM metadata_jobs
      WHERE json_extract(payload,'$.legacy.batchId')=? AND state IN ('completed','needs_review','failed')
      ORDER BY json_extract(payload,'$.updatedAt') DESC,rowid DESC LIMIT 3`
            )
            .all(batchId)
        : []
    if (state === 'blocked' || (last.length === 3 && last.every((row) => row.state === 'failed'))) {
      const message =
        state === 'blocked'
          ? (reason ?? 'legacy_source_blocked')
          : 'legacy_batch_paused_after_errors'
      this.sql
        .prepare(
          `UPDATE metadata_jobs SET state='blocked',payload=json_set(payload,'$.state','blocked',
        '$.generation',json_extract(payload,'$.generation')+1,'$.reason',?,'$.updatedAt',?)
        WHERE json_extract(payload,'$.legacy.batchId')=? AND state IN ('queued','retry_wait')`
        )
        .run(message, now, batchId)
    }
  }
  cancel(pluginId: string, operation: LegacyMusicLookup, now: number) {
    return this.owner.transaction(() => {
      const latest = this.latest(pluginId, operation)
      if (!latest) return null
      this.stop(String(latest.id), 'cancelled', now)
      return this.describe(String(latest.id))
    })
  }
  private stop(id: string, state: 'cancelled' | 'abandoned', now: number) {
    this.sql.prepare('DELETE FROM metadata_demands WHERE batch_id=?').run(id)
    this.sql
      .prepare(
        `UPDATE metadata_jobs SET state='cancelled',payload=json_set(payload,'$.state','cancelled',
      '$.generation',json_extract(payload,'$.generation')+1,'$.reason',?,'$.updatedAt',?)
      WHERE json_extract(payload,'$.legacy.batchId')=? AND state IN ('queued','running','retry_wait','blocked','needs_review')`
      )
      .run(state === 'abandoned' ? 'batch_not_published' : 'batch_cancelled', now, id)
    this.sql.prepare('UPDATE metadata_legacy_batches SET state=? WHERE id=?').run(state, id)
  }
  recover(now: number) {
    for (;;) {
      const rows = this.sql
        .prepare("SELECT id FROM metadata_legacy_batches WHERE state='staging' LIMIT 100")
        .all()
      if (!rows.length) return
      this.owner.transaction(() => {
        for (const row of rows) this.stop(String(row.id), 'abandoned', now)
      })
    }
  }
}
