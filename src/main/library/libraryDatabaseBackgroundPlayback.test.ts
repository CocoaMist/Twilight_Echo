import assert from 'node:assert/strict'
import test from 'node:test'
import { openMixedLibraryFixture } from '../../../scripts/fixtures/mixed-music-library.ts'
import { probeMusicLibraryWorker } from '../../../scripts/unified-music-library-worker-probe.ts'

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
  for (const phase of [report.idle, report.resolving, report.enriching, report.publishing]) {
    assert.equal(phase.samplesMs.length, 3)
    assert.ok(phase.maxMs >= phase.p95Ms && phase.p95Ms >= phase.p50Ms)
  }
  assert.ok(report.requestCounts.metadataFinish >= 2)
  assert.equal(fixture.database.getMetadata().trackCount, 20)
})

test('worker probe rejects invalid sample bounds before opening a process', async () => {
  await assert.rejects(probeMusicLibraryWorker({ databasePath: 'unused', localTrackId: 'unused', samples: 0 }))
})
