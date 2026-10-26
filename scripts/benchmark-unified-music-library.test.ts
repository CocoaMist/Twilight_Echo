import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { openMixedLibraryFixture } from './fixtures/mixed-music-library.ts'
import { probeMusicLibraryWorker } from './unified-music-library-worker-probe.ts'

test('mixed benchmark fixture validates complete inventories, bounded paging, membership and personal semantics', async t => {
  const fixture = await openMixedLibraryFixture({ perSource: 100, cached: 20 })
  t.after(() => fixture.close())
  const { database: db, expected: e } = fixture
  const all = { version: 1 as const, entity: 'recording' as const }
  const collect = (read: (offset: number) => { total: number; items: { id: string; title: string }[] }, total: number) => {
    const ids = new Set<string>()
    for (let offset = 0; offset < total + 7; offset += 7) {
      const page = read(offset)
      assert.equal(page.total, total)
      assert.equal(page.items.length, Math.min(7, Math.max(0, total - offset)))
      for (const row of page.items) {
        assert.equal(ids.has(row.id), false, 'pages must not repeat an entity')
        ids.add(row.id)
        assert.ok(Number(row.title.split(' ')[1]) < 100, 'cache-only results must not leak into library scope')
      }
    }
    assert.equal(ids.size, total)
    return ids
  }
  const catalog = collect(offset => db.catalogQuery({ kind: 'recording', limit: 7, offset }), e.catalogBindingLibraryRecordings)
  const focus = collect(offset => db.focusQuery({ query: all, limit: 7, offset }), e.libraryRecordings)
  const jazz = collect(offset => db.genresBrowse({ kind: 'recording', genreId: 'genre:jazz', limit: 7, offset }), e.jazzLibraryBindingRecordings)
  assert.equal(catalog.size - focus.size, e.confirmedPairs)
  for (const id of jazz) assert.ok(catalog.has(id))
  assert.equal(db.catalogQuery({ kind: 'recording', scope: 'all', limit: 1 }).total, e.catalogSources)
  assert.equal(db.focusQuery({ query: { ...all, scope: 'catalog' }, limit: 1 }).total, e.catalogRecordings)
  assert.equal(db.focusQuery({ query: { ...all, where: { automaticPlaybackBlocked: true } } }).total, e.banned)
  assert.equal(db.focusQuery({ query: { ...all, where: { rating: { target: 'self', mode: 'personal', gteStars: 4 } } } }).total, e.ratedFourStars)
  assert.equal(db.focusQuery({ query: { ...all, where: { tag: { id: fixture.tagId } } } }).total, e.taggedRecordings)
  const editions = db.albumsBrowse({ entityId: fixture.anchor.releaseId, limit: 7 })
  assert.equal(editions.total, e.projectReleases)
  assert.equal(db.albumsSources({ entityId: fixture.anchor.releaseId, releaseId: editions.items[0].id, token: editions.token, limit: 7 }).total, 10)
  assert.equal(db.getMetadata().trackCount, 100)
  assert.equal(db.catalogStatus().localPending, false)
  assert.deepEqual(fixture.metadataInventory, { expected: { completedJobs: 0, facts: 0 }, jobStates: {}, totalJobs: 0, facts: 0 })
  assert.equal(fixture.schema.beforeOpen, null)
  assert.equal(fixture.schema.afterOpen, Number(db.sql.prepare('PRAGMA user_version').get()!.user_version))
  assert.equal(fixture.schema.upgradedOnOpen, false)
})

test('existing mixed fixture is reused without ingestion, writes or directory deletion', async t => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-mixed-library-reuse-test-'))
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('twilight-mixed-library-reuse-test-'))
    rmSync(root, { recursive: true, force: true })
  })
  const seeded = await openMixedLibraryFixture({ perSource: 20, cached: 4, root })
  const { expected, anchor, tagId } = seeded, revision = seeded.database.getMetadata().revision
  seeded.database.sql.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('benchmark_reuse_sentinel', 'original')
  assert.equal(seeded.mode, 'seeded')
  assert.ok(Object.keys(seeded.phaseTimingsMs).length > 0)
  const evidencePath = join(root, 'original-ingestion.json')
  writeFileSync(evidencePath, JSON.stringify({ timestamp: '2026-10-25T00:00:00.000Z', expected,
    fixture: { mode: seeded.mode }, fixtureMs: 123, ingestionPhasesMs: seeded.phaseTimingsMs }))
  seeded.close()
  assert.ok(existsSync(join(root, 'music-library.sqlite')))

  const progress: string[] = []
  const reused = await openMixedLibraryFixture({ perSource: 20, cached: 4, reuseRoot: root, progress: phase => progress.push(phase) })
  try {
    assert.equal(reused.mode, 'reused')
    assert.equal(reused.schema.beforeOpen, reused.schema.afterOpen)
    assert.equal(reused.schema.upgradedOnOpen, false)
    assert.deepEqual(reused.expected, expected)
    assert.deepEqual(reused.anchor, anchor)
    assert.equal(reused.tagId, tagId)
    assert.deepEqual(reused.phaseTimingsMs, {})
    assert.deepEqual(progress, ['reuse-existing-fixture'])
    assert.equal(reused.database.getMetadata().revision, revision)
    assert.equal(reused.database.sql.prepare("SELECT value FROM meta WHERE key='benchmark_reuse_sentinel'").get()!.value, 'original')
    assert.throws(() => reused.database.sql.exec("UPDATE meta SET value='changed' WHERE key='benchmark_reuse_sentinel'"), /readonly/i)
  } finally { reused.close() }
  assert.ok(existsSync(join(root, 'music-library.sqlite')))

  const outputPath = join(root, 'reused-query-report.json')
  const result = spawnSync(process.execPath, ['--expose-gc', '--experimental-strip-types',
    fileURLToPath(new URL('./benchmark-unified-music-library.ts', import.meta.url)), '20', outputPath,
    `--reuse-fixture=${root}`, `--ingestion-evidence=${evidencePath}`], {
    encoding: 'utf8', env: { ...process.env, MUSIC_BENCHMARK_ROUNDS: '1' }, timeout: 60_000
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  const report = JSON.parse(readFileSync(outputPath, 'utf8'))
  assert.deepEqual(report.expected, expected)
  assert.equal(report.fixture.mode, 'reused')
  assert.equal(report.fixture.reusedPath, resolve(root))
  assert.equal(report.fixture.schema.beforeOpen, report.fixture.schema.afterOpen)
  assert.equal(report.fixture.schema.upgradedOnOpen, false)
  assert.match(report.fixture.setupMeasurement, /possible migration\/backup/)
  assert.deepEqual(report.ingestionPhasesMs, {})
  assert.equal(report.ingestionEvidence.sourceReportPath, evidencePath)
  assert.equal(report.ingestionEvidence.fixtureMs, 123)
  assert.match(report.ingestionEvidence.measurement, /not measured again/)
  assert.match(report.method.fixtureReuse, /Cross-process/)
  assert.match(report.method.warmup, /no cold-cache/)
  assert.match(report.method.workerProbe, /Skipped: query-only/)
  assert.equal(report.workerProbe, null)
  assert.equal(report.offlineHttpRequests, 0)
  assert.equal(report.reconciliation.report.summary.errorChecks, 0)
  assert.match(result.stderr, /catalogFirst complete first=[\d.]+ms p50=[\d.]+ms p95=[\d.]+ms/)
  assert.ok(existsSync(join(root, 'music-library.sqlite')))

  const conflictingOutput = spawnSync(process.execPath, ['--experimental-strip-types',
    fileURLToPath(new URL('./benchmark-unified-music-library.ts', import.meta.url)), '20', evidencePath,
    `--reuse-fixture=${root}`, `--ingestion-evidence=${evidencePath}`], { encoding: 'utf8', timeout: 60_000 })
  assert.notEqual(conflictingOutput.status, 0)
  assert.match(conflictingOutput.stderr, /Query output must not overwrite its ingestion evidence/)
  assert.equal(JSON.parse(readFileSync(evidencePath, 'utf8')).fixtureMs, 123)
})

test('fixture reuse rejects relative or missing paths without creating a database', async () => {
  await assert.rejects(openMixedLibraryFixture({ perSource: 20, cached: 4, reuseRoot: 'relative-fixture' }), /absolute path/)
  const missing = join(tmpdir(), `twilight-mixed-library-missing-${process.pid}-${Date.now()}`)
  await assert.rejects(openMixedLibraryFixture({ perSource: 20, cached: 4, reuseRoot: missing }), /Cannot reuse missing fixture/)
  assert.equal(existsSync(missing), false)
})

test('post-worker reuse requires explicit completed-job and fact inventories without deleting probe data', async t => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-mixed-library-worker-reuse-test-'))
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('twilight-mixed-library-worker-reuse-test-'))
    rmSync(root, { recursive: true, force: true })
  })
  const seeded = await openMixedLibraryFixture({ perSource: 20, cached: 4, root })
  const { databasePath, anchor, expected } = seeded
  seeded.close()
  const probe = await probeMusicLibraryWorker({ databasePath, localTrackId: anchor.localTrackId, samples: 1 })
  assert.equal(probe.metadataPublished, true)
  await assert.rejects(openMixedLibraryFixture({ perSource: 20, cached: 4, reuseRoot: root }), /metadata job inventory/)
  await assert.rejects(openMixedLibraryFixture({ perSource: 20, cached: 4, reuseRoot: root,
    expectedMetadata: { completedJobs: 2, facts: 0 } }), /metadata fact inventory/)

  const outputPath = join(root, 'post-worker-query-report.json')
  const result = spawnSync(process.execPath, ['--experimental-strip-types',
    fileURLToPath(new URL('./benchmark-unified-music-library.ts', import.meta.url)), '20', outputPath,
    `--reuse-fixture=${root}`, '--expected-completed-metadata-jobs=2', '--expected-metadata-facts=1'], {
    encoding: 'utf8', env: { ...process.env, MUSIC_BENCHMARK_ROUNDS: '1' }, timeout: 60_000
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  const report = JSON.parse(readFileSync(outputPath, 'utf8'))
  assert.deepEqual(report.expected, expected)
  assert.deepEqual(report.fixture.metadataInventory, {
    expected: { completedJobs: 2, facts: 1 }, jobStates: { completed: 2 }, totalJobs: 2, facts: 1
  })
  assert.equal(report.metrics.metadataTasksFirst.total, 2)
  const reused = await openMixedLibraryFixture({ perSource: 20, cached: 4, reuseRoot: root,
    expectedMetadata: { completedJobs: 2, facts: 1 } })
  try {
    assert.equal(reused.database.metadataTasks({ limit: 1 }).counts.completed, 2)
    assert.equal(reused.database.sql.prepare('SELECT count(*) n FROM metadata_facts').get()!.n, 1)
    assert.throws(() => reused.database.sql.exec('DELETE FROM metadata_jobs'), /readonly/i)
  } finally { reused.close() }
})
