import assert from 'node:assert/strict'
import test from 'node:test'
import { openMixedLibraryFixture } from '../../../scripts/fixtures/mixed-music-library.ts'
import { probeMusicLibraryWorker, probeMusicLibraryWorkerStartup } from '../../../scripts/unified-music-library-worker-probe.ts'

function assertStartup(startup: Awaited<ReturnType<typeof probeMusicLibraryWorkerStartup>>['startup']) {
  const phases = [startup.requestToForkMs, startup.forkToReadyMs,
    startup.readyToOpenedMs, startup.openedToMetadataMs]
  for (const duration of phases) assert.ok(Number.isFinite(duration) && duration >= 0)
  assert.ok(Math.abs(phases.reduce((sum, duration) => sum + duration, 0) - startup.totalMs) < 0.001)
}

test('mixed-library worker serves frozen playback reads while Core resolves, enriches and publishes metadata', { timeout: 30_000 }, async t => {
  const fixture = await openMixedLibraryFixture({ perSource: 20, cached: 4 })
  t.after(() => fixture.close())
  const report = await probeMusicLibraryWorker({ databasePath: fixture.databasePath,
    localTrackId: fixture.anchor.localTrackId, samples: 3 })
  assert.equal(report.queueUnchanged, true)
  assert.equal(report.metadataPublished, true)
  assert.equal(report.libraryRevisionUnchanged, true)
  assert.equal(report.externalNetworkRequests, 0)
  assert.deepEqual(report.providerRequests, { resolve: 1, enrich: 1 })
  assertStartup(report.startup)
  assert.equal(report.workerOpenMs, report.startup.totalMs)
  for (const phase of [report.idle, report.resolving, report.enriching, report.publishing]) {
    assert.equal(phase.samplesMs.length, 3)
    assert.ok(phase.maxMs >= phase.p95Ms && phase.p95Ms >= phase.p50Ms)
  }
  assert.ok(report.requestCounts.metadataFinish >= 2)
  assert.equal(fixture.database.getMetadata().trackCount, 20)
})

test('startup-only worker probe separates open phases without scheduling metadata or creating a queue', { timeout: 30_000 }, async t => {
  const fixture = await openMixedLibraryFixture({ perSource: 20, cached: 4 })
  t.after(() => fixture.close())
  const before = fixture.database.getMetadata()
  const phases: string[] = []
  const report = await probeMusicLibraryWorkerStartup({ databasePath: fixture.databasePath,
    progress(phase) { phases.push(phase) } })
  assertStartup(report.startup)
  assert.equal(report.workerOpenMs, report.startup.totalMs)
  assert.deepEqual(report.requestCounts, { getMetadata: 1 })
  assert.deepEqual(phases, ['opening', 'worker-ready', 'worker-opened'])
  assert.deepEqual(report.metadata, before)
  assert.deepEqual(fixture.database.getMetadata(), before)
})

test('worker probe rejects invalid sample bounds before opening a process', async () => {
  await assert.rejects(probeMusicLibraryWorker({ databasePath: 'unused', localTrackId: 'unused', samples: 0 }))
})
