import { LEGACY_QUEUE_SCHEMA_SQL } from './legacyQueueSchema.fixture.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { LibraryDatabase } from './libraryDatabase.ts'
import { registerLibraryRecordingFunctions } from './libraryDatabasePlaylist.ts'

const v9Schema = `DROP INDEX scan_checkpoint_cleanup;
  ALTER TABLE scan_jobs DROP COLUMN checked_files;
  ALTER TABLE scan_jobs DROP COLUMN checkpoints_reclaimed;
  PRAGMA user_version=9;`

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'scan-maintenance-')),
    path = join(root, 'library.sqlite')
  let db = new LibraryDatabase(path)
  db.updateConfiguration({ folders: [root], exclusions: [] })
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    path,
    get db() {
      return db
    },
    reopen() {
      db.close()
      db = new LibraryDatabase(path)
      return db
    }
  }
}

/** Synthetic durable checkpoints; no metadata parsing or physical media required. */
function checkpoints(db: LibraryDatabase, id: string, count: number, directories = 1) {
  db.sql
    .prepare(
      `INSERT INTO scan_jobs(id,mode,roots,state,epoch,updated_at,committed_files,parsed_files,failed_files)
       VALUES(?,'full','[]','running',2,1234,?,7,3)`
    )
    .run(id, count - 3)
  db.sql.exec('BEGIN IMMEDIATE')
  try {
    const item = db.sql.prepare("INSERT INTO scan_items VALUES(?,?,?,'committed',NULL,1,?)"),
      directory = db.sql.prepare("INSERT INTO scan_directories VALUES(?,?,'complete',NULL)")
    for (let i = 0; i < count + 5; i++)
      item.run(id, `file-${i}`, JSON.stringify({ size: 1, mtimeMs: i }), i < count ? 2 : 1)
    for (let i = 0; i < directories; i++) directory.run(id, `directory-${i}`)
    db.sql.exec('COMMIT')
  } catch (error) {
    db.sql.exec('ROLLBACK')
    throw error
  }
}

function remaining(db: LibraryDatabase, id: string) {
  return Number(
    db.sql
      .prepare(
        'SELECT (SELECT count(*) FROM scan_items WHERE job_id=?)+(SELECT count(*) FROM scan_directories WHERE job_id=?) AS n'
      )
      .get(id, id)!.n
  )
}

function drain(db: LibraryDatabase) {
  for (let pulses = 0; db.needsQueryMaintenance; pulses++) {
    assert.ok(pulses < 1000, 'maintenance must converge')
    db.maintainQueryState()
  }
}

function inventory(db: LibraryDatabase) {
  return ['meta', 'files', 'tracks', 'cue_definitions', 'queues', 'queue_entries'].map((table) =>
    db.sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
  )
}

test('completed progress survives bounded reclamation of all epochs, without changing library or latest-job meaning', (t) => {
  const { db, root } = fixture(t)
  db.replaceDocument({
    version: 2,
    revision: 17,
    folders: [root],
    exclusions: [],
    tracks: [{ id: 'one', filePath: join(root, 'one.wav'), custom: { keep: true } }]
  })
  db.createLibraryQueue({ ids: ['one', 'one'], sort: 'playlist' })
  db.sql.prepare('INSERT INTO cue_definitions VALUES(?,?,?,?)').run('cue', '{}', 'audio', '{}')
  checkpoints(db, 'done', 600, 270)
  db.sql.exec("UPDATE scan_jobs SET state='completed' WHERE id='done'")
  const progress = db.getScanProgress('done'),
    latest = db.getLatestScanJob(),
    before = inventory(db)
  assert.equal(progress.checkedFiles, 600)
  assert.equal(db.sql.prepare('SELECT checked_files FROM scan_jobs').get()!.checked_files, null)
  let old = remaining(db, 'done')
  assert.equal(old, 875)
  for (const expected of [619, 363, 107, 0]) {
    db.maintainQueryState()
    const next = remaining(db, 'done')
    assert.equal(next, expected)
    assert.ok(old - next <= 256, 'one pulse shares its budget across both checkpoint tables')
    assert.deepEqual(db.getScanProgress('done'), progress)
    assert.deepEqual(db.getLatestScanJob(), latest)
    assert.deepEqual(inventory(db), before)
    assert.equal(db.sql.isTransaction, false)
    assert.equal(db.sql.prepare('PRAGMA synchronous').get()!.synchronous, 2)
    old = next
  }
  assert.equal(db.needsQueryMaintenance, false)
  assert.equal(
    db.sql.prepare('SELECT checkpoints_reclaimed FROM scan_jobs').get()!.checkpoints_reclaimed,
    1
  )
  assert.throws(() => db.resumeScan('done'), /not resumable/)
  assert.throws(() => db.recordScanFiles('done', []), /not active/)
  assert.throws(() => db.commitScanBatch({ jobId: 'done', sequence: 1, files: [] }), /not running/)
  const version = db.getTracksByIds(['one']).versions.one
  db.patchTracks([{ id: 'one', expectedVersion: version, patch: { title: 'New title' } }])
  assert.deepEqual(db.getScanProgress('done'), { ...progress, revision: progress.revision + 1 })
})

test('cleanup uses the partial completed-job index and keyed bounded rowid deletes', (t) => {
  const { db } = fixture(t)
  for (const query of [
    "SELECT 1 FROM scan_jobs WHERE state='completed' AND checkpoints_reclaimed=0 LIMIT 1",
    "SELECT id,epoch,checked_files FROM scan_jobs WHERE state='completed' AND checkpoints_reclaimed=0 ORDER BY updated_at,rowid LIMIT 1"
  ]) {
    const plan = db.sql.prepare('EXPLAIN QUERY PLAN ' + query).all()
    assert.match(plan.map((row) => row.detail).join(' '), /INDEX scan_checkpoint_cleanup/)
    assert.doesNotMatch(plan.map((row) => row.detail).join(' '), /TEMP B-TREE/)
  }
  for (const table of ['scan_items', 'scan_directories']) {
    const plan = db.sql
      .prepare(
        `EXPLAIN QUERY PLAN DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE job_id=? LIMIT 256)`
      )
      .all('done')
      .map((row) => row.detail)
      .join(' ')
    assert.match(plan, /INTEGER PRIMARY KEY \(rowid=\?\)/)
    assert.match(plan, /COVERING INDEX.*\(job_id=\?\)/)
  }
})

test('maintenance never retires running, paused, interrupted, failed or cancelled checkpoints', (t) => {
  const { db } = fixture(t)
  for (const state of ['running', 'paused', 'interrupted', 'failed', 'cancelled', 'completed']) {
    checkpoints(db, state, 300)
    db.sql.prepare('UPDATE scan_jobs SET state=? WHERE id=?').run(state, state)
  }
  const rows = () =>
    ['scan_jobs', 'scan_items', 'scan_directories'].map((table) =>
      db.sql
        .prepare(
          `SELECT * FROM ${table} WHERE ${table === 'scan_jobs' ? 'id' : 'job_id'}<>'completed' ORDER BY rowid`
        )
        .all()
    )
  const before = rows()
  drain(db)
  assert.deepEqual(rows(), before)
  for (const state of ['running', 'paused', 'interrupted', 'failed', 'cancelled'])
    assert.equal(db.getScanProgress(state).checkedFiles, 300)
})

for (const stage of ['count', 'file', 'directory', 'flag'] as const)
  test(`a ${stage} cleanup fault rolls back the summary, rows and flag together and can retry`, (t) => {
    const { db } = fixture(t)
    checkpoints(db, 'legacy', 3)
    db.sql.exec("UPDATE scan_jobs SET state='completed' WHERE id='legacy'")
    const trigger = {
      count: 'BEFORE UPDATE OF checked_files ON scan_jobs',
      file: 'AFTER DELETE ON scan_items',
      directory: 'AFTER DELETE ON scan_directories',
      flag: 'AFTER UPDATE OF checkpoints_reclaimed ON scan_jobs'
    }[stage]
    const before = ['scan_jobs', 'scan_items', 'scan_directories'].map((table) =>
      db.sql.prepare(`SELECT * FROM ${table}`).all()
    )
    db.sql.exec(
      `CREATE TEMP TRIGGER reject_cleanup ${trigger} BEGIN SELECT RAISE(ABORT,'cleanup full'); END`
    )
    assert.throws(() => db.maintainQueryState(), /cleanup full/)
    assert.deepEqual(
      ['scan_jobs', 'scan_items', 'scan_directories'].map((table) =>
        db.sql.prepare(`SELECT * FROM ${table}`).all()
      ),
      before
    )
    assert.equal(db.sql.isTransaction, false)
    assert.equal(db.sql.prepare('PRAGMA synchronous').get()!.synchronous, 2)
    assert.equal(db.needsQueryMaintenance, true)
    db.sql.exec('DROP TRIGGER reject_cleanup')
    drain(db)
    assert.equal(remaining(db, 'legacy'), 0)
    assert.equal(db.getScanProgress('legacy').checkedFiles, 3)
  })

test('restart resumes partial retirement without shrinking the durable completion count or changing timestamps', (t) => {
  const f = fixture(t)
  checkpoints(f.db, 'done', 600)
  f.db.sql.exec("UPDATE scan_jobs SET state='completed' WHERE id='done'")
  const before = f.db.getScanProgress('done'),
    latest = f.db.getLatestScanJob()
  f.db.maintainQueryState()
  assert.equal(remaining(f.db, 'done'), 350)
  f.reopen()
  assert.equal(remaining(f.db, 'done'), 350, 'constructor does not perform unbounded cleanup')
  assert.deepEqual(f.db.getScanProgress('done'), before)
  drain(f.db)
  assert.deepEqual(f.db.getScanProgress('done'), before)
  assert.deepEqual(f.db.getLatestScanJob(), latest)
})

test('cancelled full-scan resume still skips committed checkpoints after other completed jobs are reclaimed', (t) => {
  const { db, root } = fixture(t)
  const identities = ['one', 'two'].map((id) => {
    const filePath = join(root, `${id}.flac`)
    writeFileSync(filePath, id)
    const stat = statSync(filePath)
    return { filePath, size: stat.size, mtimeMs: stat.mtimeMs }
  })
  db.startScan({ id: 'cancelled', roots: [root], mode: 'full' })
  db.recordScanFiles('cancelled', identities)
  db.claimScanFiles('cancelled', 1)
  db.commitScanBatch({
    jobId: 'cancelled',
    sequence: 1,
    files: [
      {
        identity: identities[0],
        tracks: [{ id: 'one', filePath: identities[0].filePath }],
        metadataRead: true
      }
    ]
  })
  db.setScanState('cancelled', 'cancelled')
  checkpoints(db, 'done', 300)
  db.sql.exec("UPDATE scan_jobs SET state='completed' WHERE id='done'")
  drain(db)
  db.resumeScan('cancelled')
  db.recordScanFiles('cancelled', identities)
  assert.deepEqual(db.claimScanFiles('cancelled').identities, [identities[1]])
  assert.equal(db.getScanProgress('cancelled').committedFiles, 1)
})

test('finish publishes the exact epoch count atomically with missing-file removal and rolls back a failed commit', (t) => {
  const { db, root } = fixture(t)
  db.replaceDocument({
    version: 2,
    revision: 3,
    folders: [root],
    exclusions: [],
    tracks: [{ id: 'gone', filePath: join(root, 'gone.wav') }]
  })
  db.startScan({ id: 'finishing', roots: [root], mode: 'full' })
  db.recordScanDirectory('finishing', { path: root, children: [] })
  // A failed file is still checked and must be retained in the terminal count.
  db.sql.exec(
    "INSERT INTO scan_items VALUES('finishing','checked','{}','failed','parse failed',1,1)"
  )
  const before = inventory(db)
  db.sql.exec(
    "CREATE TEMP TRIGGER reject_finish AFTER UPDATE OF state ON scan_jobs WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'finish full'); END"
  )
  assert.throws(() => db.finishScan('finishing'), /finish full/)
  assert.deepEqual(inventory(db), before)
  assert.equal(db.getScanProgress('finishing').state, 'running')
  assert.equal(db.sql.prepare('SELECT checked_files FROM scan_jobs').get()!.checked_files, null)
  db.sql.exec('DROP TRIGGER reject_finish')
  assert.equal(db.finishScan('finishing').removedFileCount, 1)
  assert.equal(db.sql.prepare('SELECT checked_files FROM scan_jobs').get()!.checked_files, 1)
  drain(db)
  assert.equal(db.getScanProgress('finishing').checkedFiles, 1)
  assert.equal(db.getScanProgress('finishing').trackCount, 0)
})

test('v9 upgrade snapshots committed WAL before DDL and defers legacy counting and cleanup until maintenance', (t) => {
  const { db: old, path, root } = fixture(t)
  checkpoints(old, 'legacy', 600)
  old.sql.exec("UPDATE scan_jobs SET state='completed' WHERE id='legacy'")
  const progress = old.getScanProgress('legacy')
  old.sql.exec(LEGACY_QUEUE_SCHEMA_SQL + v9Schema)
  // Keep the old writer open with committed schema/data still in WAL.
  const upgraded = new LibraryDatabase(path)
  try {
    assert.equal(upgraded.sql.prepare('PRAGMA user_version').get()!.user_version, 28)
    assert.equal(
      upgraded.sql.prepare('SELECT checked_files FROM scan_jobs').get()!.checked_files,
      null
    )
    assert.equal(remaining(upgraded, 'legacy'), 606)
    assert.deepEqual(upgraded.getScanProgress('legacy'), progress)
    const backups = readdirSync(root).filter((name) => name.includes('.v9-backup-'))
    assert.equal(backups.length, 1)
    const snapshot = new DatabaseSync(join(root, backups[0]), { readOnly: true })
    try {
      registerLibraryRecordingFunctions(snapshot)
      assert.equal(snapshot.prepare('PRAGMA user_version').get()!.user_version, 9)
      assert.equal(snapshot.prepare('SELECT count(*) AS n FROM scan_items').get()!.n, 605)
      assert.equal(snapshot.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
      assert.ok(
        !snapshot
          .prepare('PRAGMA table_info(scan_jobs)')
          .all()
          .some((row) => row.name === 'checked_files')
      )
    } finally {
      snapshot.close()
    }
    drain(upgraded)
    assert.deepEqual(upgraded.getScanProgress('legacy'), progress)
  } finally {
    upgraded.close()
  }
})

test('v9 snapshot failure or partial scan-column DDL leaves old schema and checkpoints intact', (t) => {
  const { db: old, path } = fixture(t)
  checkpoints(old, 'legacy', 10)
  old.sql.exec("UPDATE scan_jobs SET state='completed' WHERE id='legacy'")
  old.sql.exec(LEGACY_QUEUE_SCHEMA_SQL + v9Schema)
  const before = old.sql.prepare('SELECT * FROM scan_items').all(),
    prepare = DatabaseSync.prototype.prepare
  const backupFault = t.mock.method(
    DatabaseSync.prototype,
    'prepare',
    function (this: DatabaseSync, sql: string) {
      if (sql === 'VACUUM INTO ?') throw new Error('backup full')
      return prepare.call(this, sql)
    }
  )
  assert.throws(() => new LibraryDatabase(path), /backup full/)
  assert.equal(old.sql.prepare('PRAGMA user_version').get()!.user_version, 9)
  assert.deepEqual(old.sql.prepare('SELECT * FROM scan_items').all(), before)
  backupFault.mock.restore()
  const exec = DatabaseSync.prototype.exec
  const ddlFault = t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('ALTER TABLE scan_jobs ADD COLUMN checked_files')) {
        exec.call(this, 'ALTER TABLE scan_jobs ADD COLUMN checked_files INTEGER')
        throw new Error('scan DDL full')
      }
      return exec.call(this, sql)
    }
  )
  assert.throws(() => new LibraryDatabase(path), /scan DDL full/)
  assert.equal(old.sql.prepare('PRAGMA user_version').get()!.user_version, 9)
  assert.ok(
    !old.sql
      .prepare('PRAGMA table_info(scan_jobs)')
      .all()
      .some((row) => row.name === 'checked_files')
  )
  assert.deepEqual(old.sql.prepare('SELECT * FROM scan_items').all(), before)
  ddlFault.mock.restore()
  const upgraded = new LibraryDatabase(path)
  try {
    drain(upgraded)
    assert.equal(upgraded.getScanProgress('legacy').checkedFiles, 10)
  } finally {
    upgraded.close()
  }
})

test('future scan schemas remain rejected before writes', (t) => {
  const { db, path } = fixture(t)
  db.sql.exec('PRAGMA user_version=29')
  assert.throws(() => new LibraryDatabase(path), /Unsupported.*29/)
  assert.equal(db.sql.prepare('PRAGMA user_version').get()!.user_version, 29)
})
