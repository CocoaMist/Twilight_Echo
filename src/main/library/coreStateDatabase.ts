import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  CORE_STATE_DOMAINS,
  CORE_STATE_BATCH_BYTES,
  coreStateBatchByteLimit,
  emptyCoreStateCounts,
  type CoreMigrationManifest,
  type CoreMigrationStatus,
  type CoreStateDomain,
  type CoreStatePage,
  type CoreStateRow
} from '../../shared/coreState.ts'
import {
  isRecord,
  validatePersonalDomain,
  mergePersonalDomain
} from '../../shared/personalBackup.ts'
import { createPersonalBackupRepository } from '../../core/persistence/personalBackup.ts'
import { parseMusicVersions, type MusicVersionsDocument } from '../../shared/musicVersions.ts'
import type {
  CoreStatisticsCheckpoint,
  CoreStatisticsDomain,
  CoreStatisticsRevision
} from '../../shared/coreStatistics.ts'

const MAX_TOTAL_BYTES = 180 * 1024 * 1024
const DOMAIN_SQL = `'${CORE_STATE_DOMAINS.join("','")}'`

export class CoreStateDurabilityError extends Error {}

/** Separate connection/file: never changes the music-library schema or JSON library mode. */
export class CoreStateDatabase {
  readonly sql: DatabaseSync
  private readonly profileRoot: string | null
  constructor(filePath: string) {
    this.profileRoot = filePath === ':memory:' ? null : dirname(filePath)
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true })
    this.sql = new DatabaseSync(filePath)
    try {
      this.sql.exec(`
        PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS core_domain_revisions(domain TEXT PRIMARY KEY, revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS core_state(domain TEXT NOT NULL CHECK(domain IN (${DOMAIN_SQL})), key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(domain,key));
        CREATE TABLE IF NOT EXISTS core_migrations(id TEXT PRIMARY KEY, manifest TEXT NOT NULL, next_batch INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)));
        CREATE UNIQUE INDEX IF NOT EXISTS one_core_migration ON core_migrations((1));
        CREATE TABLE IF NOT EXISTS core_migration_rows(id TEXT NOT NULL REFERENCES core_migrations(id) ON DELETE CASCADE, domain TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(id,domain,key));
        CREATE TABLE IF NOT EXISTS core_migration_batches(id TEXT NOT NULL REFERENCES core_migrations(id) ON DELETE CASCADE, batch INTEGER NOT NULL, domain TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY(id,batch));
        CREATE TABLE IF NOT EXISTS core_statistics_checkpoint(id TEXT PRIMARY KEY, batches INTEGER NOT NULL, next_batch INTEGER NOT NULL DEFAULT 0, replace_all INTEGER NOT NULL, tracks_revision INTEGER NOT NULL, days_revision INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, committed INTEGER NOT NULL DEFAULT 0);
        CREATE UNIQUE INDEX IF NOT EXISTS one_statistics_checkpoint ON core_statistics_checkpoint((1));
        CREATE TABLE IF NOT EXISTS core_statistics_rows(id TEXT NOT NULL REFERENCES core_statistics_checkpoint(id) ON DELETE CASCADE, domain TEXT NOT NULL CHECK(domain IN ('statistics-tracks','statistics-days')), key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(id,domain,key));
        CREATE TABLE IF NOT EXISTS core_personal_restore(singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL);
      `)
      const insert = this.sql.prepare('INSERT OR IGNORE INTO core_domain_revisions VALUES (?,0)')
      for (const domain of CORE_STATE_DOMAINS) insert.run(domain)
    } catch (error) {
      this.sql.close()
      throw error
    }
  }
  close(): void {
    this.sql.close()
  }
  /** Consume both old renderer restore logs and newly staged Core restores before
   * business owners initialize. Data and the completion token commit together. */
  restorePersonalData(): { id: string | null; applied: boolean } {
    if (!this.profileRoot) throw new Error('Personal restore requires a profile directory')
    const repository = createPersonalBackupRepository()
    const request = repository.readRendererRestore(this.profileRoot)
    if (request === null) return { id: null, applied: false }
    if (
      !isRecord(request) ||
      !isRecord(request.data) ||
      !['keep-local', 'use-backup'].includes(String(request.conflict)) ||
      Object.keys(request.data).some((domain) => !['statistics', 'versions'].includes(domain))
    )
      throw new Error('个人数据恢复请求无效')
    assertId(request.id)
    const id = request.id,
      data = request.data
    const conflict = request.conflict as 'keep-local' | 'use-backup'
    const applied = this.transaction(() => {
      if (!this.status().complete)
        throw new Error('Core browser migration must complete before personal restore')
      if (
        this.sql.prepare('SELECT id FROM core_personal_restore WHERE singleton=1').get()?.id === id
      )
        return false
      const insert = this.sql.prepare('INSERT INTO core_state(domain,key,value) VALUES (?,?,?)')
      const replace = (domain: CoreStateDomain, rows: [string, unknown][]) => {
        this.sql.prepare('DELETE FROM core_state WHERE domain=?').run(domain)
        for (const [key, value] of rows) insert.run(domain, key, JSON.stringify(value))
        this.sql
          .prepare('UPDATE core_domain_revisions SET revision=revision+1 WHERE domain=?')
          .run(domain)
      }
      const read = (domain: CoreStateDomain): [string, unknown][] =>
        this.sql
          .prepare('SELECT key,value FROM core_state WHERE domain=? ORDER BY key')
          .all(domain)
          .map((row) => [String(row.key), JSON.parse(String(row.value))])
      if ('statistics' in data) {
        if (!validatePersonalDomain('statistics', data.statistics))
          throw new Error('统计恢复数据无效')
        const current = {
          tracks: Object.fromEntries(read('statistics-tracks')),
          days: Object.fromEntries(read('statistics-days'))
        }
        const merged = mergePersonalDomain(
          'statistics',
          current,
          data.statistics,
          conflict
        ) as typeof current
        if (
          !validatePersonalDomain('statistics', merged) ||
          Buffer.byteLength(JSON.stringify(merged)) > 16 * 1024 * 1024 - 1024
        )
          throw new Error('统计恢复数据超过容量或无效')
        replace('statistics-tracks', Object.entries(merged.tracks))
        replace('statistics-days', Object.entries(merged.days))
        this.sql.prepare('DELETE FROM core_statistics_checkpoint').run()
      }
      if ('versions' in data) {
        if (!validatePersonalDomain('versions', data.versions))
          throw new Error('版本关系恢复数据无效')
        const rows = read('versions')
        const current: MusicVersionsDocument = {
          version: 1,
          tracks: { versions: [], families: [] },
          albums: { versions: [], families: [] }
        }
        for (const [key, value] of rows) {
          const [scope, kind] = key.split(':') as ['tracks' | 'albums', 'versions' | 'families']
          ;(current[scope][kind] as unknown[]).push(value)
        }
        const merged = mergePersonalDomain(
          'versions',
          rows.length ? current : undefined,
          data.versions,
          conflict
        ) as MusicVersionsDocument
        if (
          !validatePersonalDomain('versions', merged) ||
          Buffer.byteLength(JSON.stringify(merged)) > 8 * 1024 * 1024 - 1024
        )
          throw new Error('版本关系恢复数据超过容量或无效')
        replace(
          'versions',
          (['tracks', 'albums'] as const).flatMap((scope) =>
            (['versions', 'families'] as const).flatMap((kind) =>
              merged[scope][kind].map(
                (value) => [`${scope}:${kind}:${value.id}`, value] as [string, unknown]
              )
            )
          )
        )
      }
      this.sql.prepare('INSERT OR REPLACE INTO core_personal_restore VALUES (1,?)').run(id)
      return true
    })
    repository.acknowledgeRendererRestore(this.profileRoot, id)
    return { id, applied }
  }
  private transaction<T>(run: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE')
    try {
      const value = run()
      this.sql.exec('COMMIT')
      return value
    } catch (error) {
      try {
        if (this.sql.isTransaction) this.sql.exec('ROLLBACK')
      } catch (rollbackError) {
        try {
          this.sql.close()
        } catch {
          /* The worker must terminate. */
        }
        throw new CoreStateDurabilityError(
          `Core state rollback failed: ${String(rollbackError)}; original operation: ${String(error)}`
        )
      }
      throw error
    }
  }
  private revision(domain: CoreStateDomain): number {
    assertDomain(domain)
    return Number(
      this.sql.prepare('SELECT revision FROM core_domain_revisions WHERE domain=?').get(domain)!
        .revision
    )
  }
  private migration() {
    return this.sql.prepare('SELECT * FROM core_migrations').get() as
      | { id: string; manifest: string; next_batch: number; bytes: number; complete: number }
      | undefined
  }
  status(): CoreMigrationStatus {
    const migration = this.migration()
    const counts = emptyCoreStateCounts()
    if (migration)
      for (const row of this.sql
        .prepare(
          'SELECT domain,COUNT(*) AS count FROM core_migration_rows WHERE id=? GROUP BY domain'
        )
        .all(migration.id))
        counts[String(row.domain) as CoreStateDomain] = Number(row.count)
    return {
      complete: migration?.complete === 1,
      id: migration?.id ?? null,
      manifest: migration ? JSON.parse(migration.manifest) : null,
      nextBatch: migration?.next_batch ?? 0,
      counts
    }
  }
  read(
    domain: CoreStateDomain,
    after?: string,
    limit = 128,
    expectedRevision?: number
  ): CoreStatePage {
    const revision = this.revision(domain)
    if (expectedRevision !== undefined && revision !== expectedRevision)
      throw new Error('Core state revision changed; restart the paged read')
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 128 ||
      (after !== undefined && typeof after !== 'string')
    )
      throw new Error('Invalid Core state page bounds')
    const rows =
      after === undefined
        ? this.sql
            .prepare(
              'SELECT key,value FROM core_state WHERE domain=? ORDER BY key COLLATE BINARY LIMIT ?'
            )
            .iterate(domain, limit + 1)
        : this.sql
            .prepare(
              'SELECT key,value FROM core_state WHERE domain=? AND key>? COLLATE BINARY ORDER BY key COLLATE BINARY LIMIT ?'
            )
            .iterate(domain, after, limit + 1)
    const page: CoreStateRow[] = []
    let bytes = 2,
      more = false
    for (const row of rows) {
      const key = String(row.key),
        value = String(row.value)
      const size = Buffer.byteLength(value) + Buffer.byteLength(JSON.stringify(key)) + 20
      if (page.length && (page.length === limit || bytes + size > CORE_STATE_BATCH_BYTES)) {
        more = true
        break
      }
      page.push({ key, value: JSON.parse(value) })
      bytes += size
    }
    return { domain, revision, rows: page, next: more ? page.at(-1)!.key : null }
  }
  write(
    domain: CoreStateDomain,
    rows: CoreStateRow[],
    expectedRevision: number,
    deletes: string[] = []
  ): number {
    assertDomain(domain)
    encodeRows(domain, rows)
    if (
      !Array.isArray(deletes) ||
      deletes.length > 128 ||
      deletes.some((key) => typeof key !== 'string')
    )
      throw new Error('Invalid Core state deletions')
    return this.transaction(() => {
      if (!this.status().complete)
        throw new Error('Core browser migration must complete before business writes')
      const revision = this.revision(domain)
      if (revision !== expectedRevision) throw new Error('Core state revision conflict')
      const insert = this.sql.prepare(
        'INSERT INTO core_state(domain,key,value) VALUES (?,?,?) ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value'
      )
      for (const row of rows) insert.run(domain, row.key, JSON.stringify(row.value))
      const remove = this.sql.prepare('DELETE FROM core_state WHERE domain=? AND key=?')
      for (const key of deletes) remove.run(domain, key)
      if (domain === 'versions') this.validateVersions('core_state')
      this.sql
        .prepare('UPDATE core_domain_revisions SET revision=revision+1 WHERE domain=?')
        .run(domain)
      return revision + 1
    })
  }
  replaceVersions(document: MusicVersionsDocument, expectedRevision: number): number {
    const next = parseMusicVersions(JSON.stringify(document))
    return this.transaction(() => {
      if (!this.status().complete)
        throw new Error('Core browser migration must complete before business writes')
      const revision = this.revision('versions')
      if (revision !== expectedRevision) throw new Error('Core state revision conflict')
      this.sql.prepare("DELETE FROM core_state WHERE domain='versions'").run()
      const insert = this.sql.prepare(
        "INSERT INTO core_state(domain,key,value) VALUES ('versions',?,?)"
      )
      for (const scope of ['tracks', 'albums'] as const)
        for (const kind of ['versions', 'families'] as const)
          for (const value of next[scope][kind])
            insert.run(`${scope}:${kind}:${value.id}`, JSON.stringify(value))
      this.sql
        .prepare("UPDATE core_domain_revisions SET revision=revision+1 WHERE domain='versions'")
        .run()
      return revision + 1
    })
  }
  statisticsStatus(): CoreStatisticsCheckpoint {
    const row = this.sql.prepare('SELECT * FROM core_statistics_checkpoint').get()
    return {
      revision: {
        tracks: this.revision('statistics-tracks'),
        days: this.revision('statistics-days')
      },
      operation: row
        ? {
            id: String(row.id),
            batches: Number(row.batches),
            nextBatch: Number(row.next_batch),
            committed: row.committed === 1
          }
        : null
    }
  }
  statisticsBegin(
    id: string,
    expected: CoreStatisticsRevision,
    batches: number,
    replace: boolean
  ): CoreStatisticsCheckpoint {
    assertId(id)
    if (
      !isRecord(expected) ||
      !Number.isSafeInteger(expected.tracks) ||
      expected.tracks < 0 ||
      !Number.isSafeInteger(expected.days) ||
      expected.days < 0 ||
      !Number.isSafeInteger(batches) ||
      batches < 0 ||
      batches > 100_000 ||
      typeof replace !== 'boolean'
    )
      throw new Error('Invalid statistics checkpoint')
    return this.transaction(() => {
      if (!this.status().complete)
        throw new Error('Core browser migration must complete before business writes')
      const current = this.statisticsStatus()
      if (current.revision.tracks !== expected.tracks || current.revision.days !== expected.days)
        throw new Error('Statistics revision conflict')
      if (current.operation?.id === id || (current.operation && !current.operation.committed))
        throw new Error('Statistics checkpoint already exists; read its outcome before retrying')
      this.sql.exec('DELETE FROM core_statistics_checkpoint')
      this.sql
        .prepare(
          'INSERT INTO core_statistics_checkpoint(id,batches,replace_all,tracks_revision,days_revision) VALUES (?,?,?,?,?)'
        )
        .run(id, batches, replace ? 1 : 0, expected.tracks, expected.days)
      return this.statisticsStatus()
    })
  }
  statisticsStage(
    id: string,
    batch: number,
    domain: CoreStatisticsDomain,
    rows: CoreStateRow[]
  ): CoreStatisticsCheckpoint {
    assertId(id)
    if (
      !['statistics-tracks', 'statistics-days'].includes(domain) ||
      !Number.isSafeInteger(batch) ||
      batch < 0
    )
      throw new Error('Invalid statistics batch')
    const content = encodeRows(domain, rows)
    return this.transaction(() => {
      const status = this.statisticsStatus(),
        current = status.operation
      if (
        !current ||
        current.id !== id ||
        current.committed ||
        current.nextBatch !== batch ||
        batch >= current.batches
      )
        throw new Error('Statistics checkpoint sequence changed; read its outcome before retrying')
      const checkpoint = this.sql
        .prepare('SELECT bytes FROM core_statistics_checkpoint WHERE id=?')
        .get(id)!
      const bytes = Buffer.byteLength(content)
      if (Number(checkpoint.bytes) + bytes > MAX_TOTAL_BYTES)
        throw new Error('Statistics checkpoint exceeds the personal data size limit')
      const insert = this.sql.prepare('INSERT INTO core_statistics_rows VALUES (?,?,?,?)')
      for (const row of rows) insert.run(id, domain, row.key, JSON.stringify(row.value))
      this.sql
        .prepare(
          'UPDATE core_statistics_checkpoint SET next_batch=next_batch+1,bytes=bytes+? WHERE id=?'
        )
        .run(bytes, id)
      return this.statisticsStatus()
    })
  }
  statisticsCommit(id: string): CoreStatisticsCheckpoint {
    assertId(id)
    return this.transaction(() => {
      const status = this.statisticsStatus(),
        current = status.operation
      if (
        !current ||
        current.id !== id ||
        current.committed ||
        current.nextBatch !== current.batches
      )
        throw new Error(
          'Statistics checkpoint is incomplete or already committed; read its outcome'
        )
      const row = this.sql
        .prepare(
          'SELECT replace_all,tracks_revision,days_revision FROM core_statistics_checkpoint WHERE id=?'
        )
        .get(id)!
      if (
        row.tracks_revision !== status.revision.tracks ||
        row.days_revision !== status.revision.days
      )
        throw new Error('Statistics revision conflict')
      if (row.replace_all === 1)
        this.sql.exec(
          "DELETE FROM core_state WHERE domain IN ('statistics-tracks','statistics-days')"
        )
      this.sql
        .prepare(
          `INSERT INTO core_state(domain,key,value) SELECT domain,key,value FROM core_statistics_rows WHERE id=? AND 1
        ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value`
        )
        .run(id)
      this.sql.exec(
        "UPDATE core_domain_revisions SET revision=revision+1 WHERE domain IN ('statistics-tracks','statistics-days')"
      )
      this.sql.prepare('UPDATE core_statistics_checkpoint SET committed=1 WHERE id=?').run(id)
      this.sql.prepare('DELETE FROM core_statistics_rows WHERE id=?').run(id)
      return this.statisticsStatus()
    })
  }
  statisticsAbort(id: string): void {
    assertId(id)
    this.transaction(() => {
      const current = this.statisticsStatus().operation
      if (current?.id !== id || current.committed)
        throw new Error('Statistics checkpoint cannot be discarded')
      this.sql.prepare('DELETE FROM core_statistics_checkpoint WHERE id=?').run(id)
    })
  }
  begin(id: string, manifest: CoreMigrationManifest): CoreMigrationStatus {
    assertId(id)
    assertManifest(manifest)
    return this.transaction(() => {
      const previous = this.migration()
      if (previous) {
        if (previous.id !== id || previous.manifest !== JSON.stringify(manifest))
          throw new Error('A different Core migration already exists')
        return this.status()
      }
      this.sql
        .prepare('INSERT INTO core_migrations(id,manifest) VALUES (?,?)')
        .run(id, JSON.stringify(manifest))
      return this.status()
    })
  }
  stage(
    id: string,
    batch: number,
    domain: CoreStateDomain,
    rows: CoreStateRow[]
  ): CoreMigrationStatus {
    assertId(id)
    assertDomain(domain)
    if (!Number.isSafeInteger(batch) || batch < 0)
      throw new Error('Invalid migration batch sequence')
    const content = encodeRows(domain, rows)
    return this.transaction(() => {
      const migration = this.migration()
      if (!migration || migration.id !== id || migration.complete)
        throw new Error('Migration is not active')
      const old = this.sql
        .prepare('SELECT domain,content FROM core_migration_batches WHERE id=? AND batch=?')
        .get(id, batch)
      if (old) {
        if (old.domain !== domain || old.content !== content)
          throw new Error('Migration retry content changed')
        return this.status() // explicit idempotency for an acknowledged or lost-reply stage
      }
      if (batch !== migration.next_batch) throw new Error('Migration batch sequence gap')
      const bytes = Buffer.byteLength(content)
      if (migration.bytes + bytes > MAX_TOTAL_BYTES)
        throw new Error('Core migration exceeds the personal data size limit')
      const insert = this.sql.prepare('INSERT INTO core_migration_rows VALUES (?,?,?,?)')
      for (const row of rows) insert.run(id, domain, row.key, JSON.stringify(row.value))
      const manifest = JSON.parse(migration.manifest) as CoreMigrationManifest
      const count = Number(
        this.sql
          .prepare('SELECT COUNT(*) AS count FROM core_migration_rows WHERE id=? AND domain=?')
          .get(id, domain)!.count
      )
      if (count > manifest.counts[domain]) throw new Error('Migration count exceeds its manifest')
      this.sql
        .prepare('INSERT INTO core_migration_batches VALUES (?,?,?,?)')
        .run(id, batch, domain, content)
      this.sql
        .prepare('UPDATE core_migrations SET next_batch=next_batch+1,bytes=bytes+? WHERE id=?')
        .run(bytes, id)
      return this.status()
    })
  }
  commit(id: string): CoreMigrationStatus {
    assertId(id)
    return this.transaction(() => {
      const migration = this.migration()
      if (!migration || migration.id !== id) throw new Error('Unknown migration')
      if (migration.complete) return this.status()
      const status = this.status()
      for (const domain of CORE_STATE_DOMAINS) {
        if (status.counts[domain] !== status.manifest!.counts[domain])
          throw new Error(`Migration is incomplete: ${domain}`)
        if (
          Number(
            this.sql.prepare('SELECT COUNT(*) AS count FROM core_state WHERE domain=?').get(domain)!
              .count
          )
        )
          throw new Error(`Existing Core data must not be overwritten: ${domain}`)
      }
      this.validateVersions('core_migration_rows', id)
      this.sql
        .prepare(
          'INSERT INTO core_state(domain,key,value) SELECT domain,key,value FROM core_migration_rows WHERE id=?'
        )
        .run(id)
      this.sql.exec('UPDATE core_domain_revisions SET revision=revision+1')
      this.sql.prepare('UPDATE core_migrations SET complete=1 WHERE id=?').run(id)
      // Retain staged source rows/counts for recovery, but do not keep a second
      // full copy of every JSON batch after the atomic publication.
      this.sql.prepare('DELETE FROM core_migration_batches WHERE id=?').run(id)
      return this.status()
    })
  }
  abort(id: string): void {
    assertId(id)
    this.transaction(() => {
      if (this.migration()?.complete) throw new Error('Published Core migration cannot be aborted')
      this.sql.prepare('DELETE FROM core_migrations WHERE id=? AND complete=0').run(id)
    })
  }
  private validateVersions(table: 'core_state' | 'core_migration_rows', id?: string): void {
    const rows =
      id === undefined
        ? this.sql.prepare(`SELECT key,value FROM ${table} WHERE domain='versions'`).all()
        : this.sql
            .prepare(`SELECT key,value FROM ${table} WHERE domain='versions' AND id=?`)
            .all(id)
    if (!rows.length) return
    const doc = {
      version: 1,
      tracks: { versions: [] as unknown[], families: [] as unknown[] },
      albums: { versions: [] as unknown[], families: [] as unknown[] }
    }
    for (const row of rows) {
      const [scope, kind] = String(row.key).split(':') as [
        'tracks' | 'albums',
        'versions' | 'families'
      ]
      doc[scope][kind].push(JSON.parse(String(row.value)))
    }
    if (!validatePersonalDomain('versions', doc))
      throw new Error('Music version graph validation failed')
  }
}
function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !id || id.length > 128)
    throw new Error('Invalid Core migration identity')
}
function assertDomain(domain: unknown): asserts domain is CoreStateDomain {
  if (!CORE_STATE_DOMAINS.includes(domain as CoreStateDomain))
    throw new Error('Unknown Core state domain')
}
function assertManifest(manifest: CoreMigrationManifest): void {
  if (
    !isRecord(manifest) ||
    manifest.version !== 1 ||
    !isRecord(manifest.counts) ||
    Object.keys(manifest.counts).length !== CORE_STATE_DOMAINS.length
  )
    throw new Error('Invalid Core migration manifest')
  for (const domain of CORE_STATE_DOMAINS)
    if (
      !Number.isSafeInteger(manifest.counts[domain]) ||
      manifest.counts[domain] < 0 ||
      manifest.counts[domain] > 100_000
    )
      throw new Error('Invalid Core migration domain count')
}
function encodeRows(domain: CoreStateDomain, rows: CoreStateRow[]): string {
  if (!Array.isArray(rows) || !rows.length || rows.length > 128)
    throw new Error('Core state batches require 1–128 rows')
  const keys = new Set<string>()
  for (const row of rows) {
    if (
      !isRecord(row) ||
      typeof row.key !== 'string' ||
      !row.key ||
      row.key.length > 32_768 ||
      keys.has(row.key) ||
      !validateRow(domain, row)
    )
      throw new Error(`Invalid Core state row: ${domain}`)
    keys.add(row.key)
  }
  const content = JSON.stringify(rows)
  if (Buffer.byteLength(content) > coreStateBatchByteLimit(domain, rows.length))
    throw new Error('Core state batch exceeds its row/byte limit')
  return content
}
function validateRow(domain: CoreStateDomain, row: CoreStateRow): boolean {
  const value = row.value
  switch (domain) {
    case 'versions': {
      const match = /^(tracks|albums):(versions|families):(.+)$/.exec(row.key)
      return !!match && isRecord(value) && value.id === match[3]
    }
    case 'statistics-tracks':
      return validatePersonalDomain('statistics', { days: {}, tracks: { [row.key]: value } })
    case 'statistics-days':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0
    case 'inbox':
      return (
        isRecord(value) &&
        typeof value.fingerprint === 'string' &&
        ['ignored', 'done'].includes(String(value.status))
      )
    case 'podcast-preferences':
      return (
        row.key === 'defaultPlaybackRate' &&
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0.5 &&
        value <= 2
      )
    case 'eq-preferences':
      return row.key === 'autoPreamp'
        ? typeof value === 'boolean'
        : row.key === 'manualPreamp' && typeof value === 'number' && Number.isFinite(value)
  }
}
